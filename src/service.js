// 研学实操资源编排：服务门面
// - 维护只增事件日志与归约状态；命令在状态副本上判定，失败不留痕（原子提交）。
// - 事件按 event_id 去重：同标识同内容跳过，同标识异内容进入隔离。
// - 离线领用回执按 receipt_id 幂等；重放不重复扣减，异内容回执进入隔离。
// - recover() 从日志完全重建状态，并按各候补原截止点继续候补与复检。

import crypto from "node:crypto";

import { applyEvent, decide, initialState, receiptFingerprint, DomainError } from "./domain.js";
import { validateEvent } from "./validator.js";

export { DomainError };

export class QuarantineError extends Error {
  constructor(message, entry) {
    super(message);
    this.name = "QuarantineError";
    this.entry = entry;
  }
}

export function canonicalHash(value) {
  return crypto.createHash("sha256").update(canonicalStringify(value), "utf8").digest("hex");
}

function canonicalStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalStringify).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalStringify(value[key])}`).join(",")}}`;
}

export class StudyTourService {
  constructor({ clock = () => new Date().toISOString() } = {}) {
    this.clock = clock;
    this.log = [];
    this.state = initialState();
    this.offlineQueue = []; // 离线期间排队、尚未重放的领用回执
  }

  get events() {
    return this.log;
  }

  // 仅供测试/恢复设施使用：用一份既有日志重建服务。
  static fromEvents(events, options = {}) {
    const service = new StudyTourService(options);
    for (const event of events) service.appendEvent(event, { fromReplay: true });
    return service;
  }

  submit(command) {
    const now = this.clock();

    // 离线领用回执重放的特殊语义：同标识异内容进隔离，而不是当作重复扣减或直接失败。
    if (command.type === "issueConsumables" && command.receipt_id) {
      const prior = this.state.receipts[command.receipt_id];
      if (prior) {
        if (receiptFingerprint(command) === prior.hash)
          return { deduplicated: true, events: [], reason: "receipt_replayed" };
        this.#quarantineReceipt(command, prior, "同标识回执内容不一致");
        return { deduplicated: false, events: [], quarantined: true };
      }
    }

    // 在状态副本上判定：任何校验失败都不污染已提交状态（整单原子）。
    const scratch = structuredClone(this.state);
    const result = decide(command, scratch, now);
    if (result.deduplicated) return result;

    const committed = [];
    for (const event of result.events) {
      if (!("content_hash" in event)) event.content_hash = canonicalHash(withoutKey(event, "event_id"));
      committed.push(this.appendEvent(event));
    }
    return { deduplicated: false, events: committed };
  }

  appendEvent(event, { fromReplay = false } = {}) {
    const errors = validateEvent(event);
    if (errors.length) throw new DomainError("BAD_EVENT", `事件信封不合法：${errors.join("；")}`, { errors });

    if (event.event_id in this.state.seenEvents) {
      const existing = this.state.seenEvents[event.event_id];
      const hash = event.content_hash || canonicalHash(withoutKey(event, "event_id"));
      if (hash === existing) return null; // 同标识同内容：幂等跳过
      // 同标识异内容：不改写既有状态，登记隔离事件（只增，可随日志重放恢复）。
      const marker = {
        event_id: `evt-event-quarantine-${event.event_id}`,
        event_type: "EVENT_QUARANTINED",
        aggregate_type: "event",
        aggregate_id: event.event_id,
        occurred_at: this.clock(),
        version: 1,
        summary: `事件 ${event.event_id} 同标识异内容，已进入隔离`,
        event_ref: event.event_id,
        reason: "同标识事件内容不一致",
      };
      marker.content_hash = canonicalHash(withoutKey(marker, "event_id"));
      applyEvent(this.state, marker);
      this.log.push(marker);
      const entry = this.state.quarantine[event.event_id];
      throw new QuarantineError(`事件 ${event.event_id} 同标识异内容，已进入隔离`, entry);
    }
    applyEvent(this.state, event);
    this.log.push(event);
    return event;
  }

  // 离线场景：领队端在断连时先排队回执。
  queueOfflineReceipt(receipt) {
    this.offlineQueue.push({ ...receipt, queued_at: this.clock() });
  }

  // 服务恢复后重放全部离线回执；对同一份队列再次完全重放时全部幂等命中。
  replayOffline() {
    const report = { applied: [], deduplicated: [], quarantined: [], failed: [] };
    const queued = this.offlineQueue.splice(0);
    for (const receipt of queued) {
      try {
        const result = this.submit({
          type: "issueConsumables",
          command_id: receipt.command_id || `receipt-cmd-${receipt.receipt_id}`,
          receipt_id: receipt.receipt_id,
          slot_id: receipt.slot_id,
          items: receipt.items,
          at: receipt.at,
        });
        if (result.quarantined) report.quarantined.push(receipt.receipt_id);
        else if (result.deduplicated) report.deduplicated.push(receipt.receipt_id);
        else report.applied.push(receipt.receipt_id);
      } catch (error) {
        report.failed.push({ receipt_id: receipt.receipt_id, error: error.code || error.message });
      }
    }
    return report;
  }

  // 模拟服务重启：从只增日志完整重建，再按各候补原截止点继续候补与复检判定。
  recover(now = this.clock()) {
    const rebuilt = StudyTourService.fromEvents(this.log, { clock: this.clock });
    this.state = rebuilt.state;
    this.log = rebuilt.log;
    const result = this.submit({ type: "reconcileWaitlists", at: now });
    return { recovered_event_count: this.log.length, continued: result.events || [] };
  }

  #quarantineReceipt(command, prior, reason) {
    if (this.state.quarantine[command.receipt_id]) return; // 已隔离，重复上报幂等
    const event = {
      event_id: `evt-receipt-quarantine-${command.receipt_id}`,
      event_type: "RECEIPT_QUARANTINED",
      aggregate_type: "offline_receipt",
      aggregate_id: command.receipt_id,
      occurred_at: this.clock(),
      version: 1,
      summary: `离线回执 ${command.receipt_id} 与已处理回执同标识异内容，进入隔离`,
      receipt_id: command.receipt_id,
      reason,
      prior_event_id: prior.event_id,
    };
    event.content_hash = canonicalHash(withoutKey(event, "event_id"));
    applyEvent(this.state, event);
    this.log.push(event);
  }

  leaderView({ group_id = null, revision_id = null } = {}) {
    return buildLeaderView(this.state, { group_id, revision_id });
  }
}

function withoutKey(object, key) {
  const copy = { ...object };
  delete copy[key];
  return copy;
}

// ---------------------------------------------------------------------------
// 领队视图投影：改线保留了哪些节点、哪些证据失效、耗材余量为何变化
// ---------------------------------------------------------------------------

export function buildLeaderView(state, { group_id = null, revision_id = null } = {}) {
  const slotList = Object.values(state.slots).filter((slot) => !group_id || slot.group_id === group_id);

  const slots = slotList.map((slot) => ({
    slot_id: slot.slot_id,
    group_id: slot.group_id,
    objective: slot.objective,
    status: slot.status,
    kept: slot.status === "completed" || slot.status === "started",
    units: slot.unit_ids,
    replacement_of: slot.replacement_of || null,
    replacement_slot_id: slot.replacement_slot_id || null,
    equivalence_note: slot.equivalence_note || null,
    suspended_at: slot.suspended_at || null,
    resumed_at: slot.resumed_at || null,
    replaced_at: slot.replaced_at || null,
  }));

  const evidence = Object.values(state.evidence)
    .filter((item) => slotList.some((slot) => slot.slot_id === item.slot_id))
    .map((item) => ({
      evidence_id: item.evidence_id,
      slot_id: item.slot_id,
      source_ref: item.source_ref,
      collected_at: item.collected_at,
      status: item.status,
      // 改线后仍被采纳的证据必须能追溯来源；失效证据给出原因。
      retained_with_source: item.status === "valid" && item.preserved,
      invalid_reason: item.invalid_reason || null,
    }));

  const batches = Object.values(state.batches).map((batch) => ({
    batch_id: batch.batch_id,
    name: batch.name,
    status: batch.status,
    quantity: batch.quantity,
    reserved: batch.reserved,
    consumed: batch.consumed,
    discarded: batch.discarded || 0,
    available: batch.status === "active" ? batch.quantity - batch.reserved - batch.consumed : 0,
    balance_changes: batch.ledger
      .filter((entry) => entry.reserved_delta !== 0 || entry.consumed_delta !== 0 || entry.discarded_delta)
      .map((entry) => ({
        at: entry.at,
        cause: entry.event_type,
        ref: entry.ref,
        reserved_delta: entry.reserved_delta,
        consumed_delta: entry.consumed_delta,
        discarded_delta: entry.discarded_delta || 0,
        available_after: entry.available_after,
      })),
  }));

  const revisions = Object.values(state.revisions)
    .filter((revision) => !revision_id || revision.revision_id === revision_id)
    .map((revision) => {
      const suspendedIds = new Set(revision.suspended_slots);
      return {
        revision_id: revision.revision_id,
        hazard: revision.hazard,
        root: revision.root,
        status: revision.status,
        impacted_units: revision.impacted_units,
        impacted_batches: revision.impacted_batches,
        impacted_samples: revision.impacted_samples,
        // 保留的节点：已完成活动槽不暂停；未受影响团组不动。
        kept_nodes: slotList
          .filter((slot) => !suspendedIds.has(slot.slot_id))
          .map((slot) => ({ slot_id: slot.slot_id, status: slot.status })),
        suspended_slots: revision.suspended_slots,
        resumed_slots: revision.resumed_slots,
        replacements: revision.replacements,
        invalidated_evidence: revision.invalidated_evidence,
        paused_waitlist: revision.paused_waitlist,
      };
    });

  const waitlist = Object.values(state.waitlist).map((entry) => ({
    waitlist_id: entry.waitlist_id,
    target_slot_id: entry.target_slot_id,
    cutoff: entry.cutoff,
    status: entry.status,
    items: entry.items,
    fulfilled_at: entry.fulfilled_at || null,
    expire_reason: entry.expire_reason || null,
  }));

  return {
    slots,
    evidence,
    batches,
    revisions,
    waitlist,
    quarantine: Object.values(state.quarantine || {}),
  };
}
