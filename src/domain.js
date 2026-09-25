// 研学实操资源编排：事件溯源领域内核（纯函数，无 I/O）
//
// 约定：
// - decide(command, state, now) 做前置校验，返回一个原子追加的事件数组；
// - applyEvent(state, event) 只做状态归约，不重新拒绝事件（重放需要）；
// - 事件一经追加不可原地改写，更正只能产生后继事件；
// - 节点标识：unit:<id> / batch:<id> / sample:<id>，污染与校准失效沿接触边无向传播。

import crypto from "node:crypto";

export class DomainError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "DomainError";
    this.code = code;
    this.details = details;
  }
}

const TERMINAL_SLOT_STATUS = new Set(["completed", "replaced"]);

export function initialState() {
  return {
    seq: {}, // aggregate_id -> 已追加版本号
    mentors: {},
    units: {},
    batches: {},
    groups: {},
    slots: {},
    evidence: {},
    waitlist: {},
    waitlistOrder: [],
    edges: [],
    revisions: {},
    reservations: {}, // slot_id -> { batch_id -> 剩余预留 }
    seenCommands: {}, // command_id -> event_id
    seenEvents: {}, // event_id -> content_hash
    seenReceipts: {}, // 离线领用回执 receipt_id -> 首次处理的事件
    receipts: {}, // receipt_id -> { hash, event_id }，用于重放时同标识异内容判定
    quarantine: {}, // 隔离区：同标识异内容的事件/离线回执
  };
}

export function replay(events) {
  const state = initialState();
  for (const event of events) applyEvent(state, event);
  return state;
}

const nodeKey = (ref) => `${ref.kind}:${ref.id}`;

// ISO-8601 时间字符串带不同偏移量，必须转毫秒时间戳比较，不能做字典序比较。
export const time = (value) => Date.parse(value);
const timeLE = (a, b) => time(a) <= time(b);
const timeGT = (a, b) => time(a) > time(b);
const timeGE = (a, b) => time(a) >= time(b);

function bumpVersion(state, aggregateId) {
  state.seq[aggregateId] = (state.seq[aggregateId] || 0) + 1;
  return state.seq[aggregateId];
}

function availableStock(batch) {
  if (batch.status !== "active") return 0;
  return batch.quantity - batch.reserved - batch.consumed;
}

// 离线领用回执内容指纹：只对实际影响扣减的字段（槽位 + 明细）做规范化哈希。
export function receiptFingerprint(receipt) {
  const canonical = {
    slot_id: receipt.slot_id,
    items: [...receipt.items]
      .map((item) => ({ batch_id: item.batch_id, quantity: item.quantity }))
      .sort((a, b) => a.batch_id.localeCompare(b.batch_id)),
  };
  return crypto.createHash("sha256").update(JSON.stringify(canonical), "utf8").digest("hex");
}

// ---------------------------------------------------------------------------
// 命令 -> 事件
// ---------------------------------------------------------------------------

export function decide(command, state, now) {
  if (command.command_id && state.seenCommands[command.command_id]) {
    return { deduplicated: true, events: [] };
  }
  const events = [];
  // 事件在产出的同一时刻归约到工作状态，保证同一原子批次内的后继判断
  // （例如释放后立即满足候补）看到最新库存；从日志重放走同一条归约路径。
  const emit = (event) => {
    event.version = bumpVersion(state, event.aggregate_id);
    if (command.command_id) event.command_id = command.command_id;
    events.push(event);
    applyEvent(state, event);
    return event;
  };

  switch (command.type) {
    case "registerMentor": {
      if (state.mentors[command.mentor_id]) throw new DomainError("MEMBER_EXISTS", "导师已登记");
      emit({
        event_id: command.event_id || `evt-mentor-${command.mentor_id}`,
        event_type: "MENTOR_REGISTERED",
        aggregate_type: "mentor",
        aggregate_id: command.mentor_id,
        occurred_at: command.at || now,
        summary: `登记导师 ${command.mentor_id}`,
        mentor_id: command.mentor_id,
        qualifications: command.qualifications,
      });
      break;
    }

    case "registerUnit": {
      if (state.units[command.unit_id]) throw new DomainError("UNIT_EXISTS", "仪器已登记");
      emit({
        event_id: command.event_id || `evt-unit-${command.unit_id}`,
        event_type: "UNIT_REGISTERED",
        aggregate_type: "resource_unit",
        aggregate_id: command.unit_id,
        occurred_at: command.at || now,
        summary: `登记仪器 ${command.unit_id}`,
        unit_id: command.unit_id,
        name: command.name || command.unit_id,
        calibration_valid_until: command.calibration_valid_until,
      });
      break;
    }

    case "registerBatch": {
      if (state.batches[command.batch_id]) throw new DomainError("BATCH_EXISTS", "耗材批次已登记");
      if (!Number.isInteger(command.quantity) || command.quantity <= 0)
        throw new DomainError("BAD_QUANTITY", "批次数量必须为正整数");
      emit({
        event_id: command.event_id || `evt-batch-${command.batch_id}`,
        event_type: "BATCH_REGISTERED",
        aggregate_type: "consumable_batch",
        aggregate_id: command.batch_id,
        occurred_at: command.at || now,
        summary: `登记耗材批次 ${command.batch_id}`,
        batch_id: command.batch_id,
        name: command.name || command.batch_id,
        quantity: command.quantity,
      });
      break;
    }

    case "confirmGroup": {
      confirmGroup(command, state, now, emit);
      break;
    }

    case "startActivity": {
      const slotIds = command.slot_ids || slotsOfGroup(state, command.group_id);
      if (slotIds.length === 0) throw new DomainError("NO_SLOT", "没有可启动的活动槽");
      for (const slotId of slotIds) {
        const slot = state.slots[slotId];
        if (!slot) throw new DomainError("SLOT_NOT_FOUND", `活动槽不存在：${slotId}`);
        if (slot.status !== "confirmed")
          throw new DomainError("SLOT_NOT_CONFIRMED", `活动槽 ${slotId} 当前状态 ${slot.status}，不能启动`, {
            slot_id: slotId,
            status: slot.status,
          });
        for (const unitId of slot.unit_ids) checkUnitReady(state.units[unitId], command.at || now);
        for (const batchId of Object.keys(state.reservations[slotId] || {})) {
          const batch = state.batches[batchId];
          if (batch.status !== "active")
            throw new DomainError("BATCH_UNAVAILABLE", `批次 ${batchId} 当前不可用`, { batch_id: batchId, status: batch.status });
        }
      }
      for (const slotId of slotIds) {
        emit({
          event_id: command.event_id || `evt-start-${slotId}-${(command.at || now).replace(/[:.+]/g, "")}`,
          event_type: "ACTIVITY_STARTED",
          aggregate_type: "activity_slot",
          aggregate_id: slotId,
          occurred_at: command.at || now,
          summary: `活动槽 ${slotId} 开始`,
          slot_id: slotId,
          group_id: state.slots[slotId].group_id,
        });
      }
      break;
    }

    case "completeSlot": {
      const slot = requireSlot(state, command.slot_id);
      if (slot.status !== "started")
        throw new DomainError("SLOT_NOT_STARTED", `活动槽 ${command.slot_id} 未在进行中，不能完成`);
      emit({
        event_id: command.event_id || `evt-complete-${command.slot_id}`,
        event_type: "SLOT_COMPLETED",
        aggregate_type: "activity_slot",
        aggregate_id: command.slot_id,
        occurred_at: command.at || now,
        summary: `活动槽 ${command.slot_id} 完成`,
        slot_id: command.slot_id,
      });
      break;
    }

    case "issueConsumables": {
      const slot = requireSlot(state, command.slot_id);
      if (slot.status !== "started")
        throw new DomainError("SLOT_NOT_STARTED", `活动槽 ${command.slot_id} 未在进行中，不能领用`, {
          status: slot.status,
        });
      const fingerprint = command.receipt_id ? receiptFingerprint(command) : null;
      if (command.receipt_id && state.seenReceipts[command.receipt_id]) {
        const prior = state.receipts[command.receipt_id];
        if (prior.hash === fingerprint) return { deduplicated: true, events: [] };
        throw new DomainError("RECEIPT_CONTENT_MISMATCH", `回执 ${command.receipt_id} 与已处理回执同标识异内容`, {
          receipt_id: command.receipt_id,
          prior_event_id: prior.event_id,
        });
      }
      const held = state.reservations[command.slot_id] || {};
      for (const item of command.items) {
        const batch = requireBatch(state, item.batch_id);
        if (batch.status !== "active")
          throw new DomainError("BATCH_QUARANTINED", `批次 ${item.batch_id} 已隔离，不能领用`, {
            batch_id: item.batch_id,
          });
        const remaining = held[item.batch_id] || 0;
        if (!Number.isInteger(item.quantity) || item.quantity <= 0)
          throw new DomainError("BAD_QUANTITY", "领用数量必须为正整数");
        if (item.quantity > remaining)
          throw new DomainError("OVER_ISSUE", `领用超过预留：${item.batch_id} 剩余预留 ${remaining}，申请 ${item.quantity}`, {
            batch_id: item.batch_id,
            remaining,
            requested: item.quantity,
          });
      }
      emit({
        event_id: command.event_id || `evt-issue-${command.slot_id}-${(command.at || now).replace(/[:.+]/g, "")}`,
        event_type: "CONSUMABLES_ISSUED",
        aggregate_type: "activity_slot",
        aggregate_id: command.slot_id,
        occurred_at: command.at || now,
        summary: `活动槽 ${command.slot_id} 实际领用耗材`,
        slot_id: command.slot_id,
        receipt_id: command.receipt_id || null,
        receipt_hash: fingerprint,
        items: command.items.map((item) => ({ batch_id: item.batch_id, quantity: item.quantity })),
      });
      break;
    }

    case "releaseUnused": {
      releaseUnused(command, state, now, emit);
      break;
    }

    case "registerWaitlist": {
      if (state.waitlist[command.waitlist_id]) throw new DomainError("WAITLIST_EXISTS", "候补已登记");
      if (!command.cutoff) throw new DomainError("BAD_CUTOFF", "候补必须给出截止点 cutoff");
      for (const item of command.items) requireBatch(state, item.batch_id);
      emit({
        event_id: command.event_id || `evt-waitlist-${command.waitlist_id}`,
        event_type: "WAITLIST_REGISTERED",
        aggregate_type: "waitlist_entry",
        aggregate_id: command.waitlist_id,
        occurred_at: command.at || now,
        summary: `候补 ${command.waitlist_id} 登记，截止点 ${command.cutoff}`,
        waitlist_id: command.waitlist_id,
        group_id: command.group_id,
        target_slot_id: command.target_slot_id,
        cutoff: command.cutoff,
        items: command.items,
      });
      break;
    }

    case "recordContact": {
      const kinds = ["unit", "batch", "sample"];
      if (!kinds.includes(command.from.kind) || !kinds.includes(command.to.kind))
        throw new DomainError("BAD_NODE", "接触节点类型必须是 unit/batch/sample");
      if (!command.slot_id || !state.slots[command.slot_id])
        throw new DomainError("SLOT_NOT_FOUND", `接触记录必须归属存在的活动槽：${command.slot_id}`);
      emit({
        event_id: command.event_id || `evt-contact-${state.edges.length + 1}`,
        event_type: "CONTACT_RECORDED",
        aggregate_type: "activity_slot",
        aggregate_id: command.slot_id,
        occurred_at: command.at || now,
        summary: `记录器材/样品接触：${nodeKey(command.from)} ↔ ${nodeKey(command.to)}（${command.via || ""}）`,
        slot_id: command.slot_id,
        from: command.from,
        to: command.to,
        via: command.via || null,
      });
      break;
    }

    case "raiseHazard": {
      raiseHazard(command, state, now, emit);
      break;
    }

    case "recordCleaning": {
      const unit = requireUnit(state, command.unit_id);
      if (unit.status !== "quarantined")
        throw new DomainError("UNIT_NOT_QUARANTINED", `仪器 ${command.unit_id} 未隔离，无需清洁`);
      emit({
        event_id: command.event_id || `evt-cleaning-${command.unit_id}`,
        event_type: "CLEANING_RECORDED",
        aggregate_type: "resource_unit",
        aggregate_id: command.unit_id,
        occurred_at: command.at || now,
        summary: `仪器 ${command.unit_id} 完成清洁`,
        unit_id: command.unit_id,
        revision_id: command.revision_id,
      });
      break;
    }

    case "recertifyUnit": {
      const unit = requireUnit(state, command.unit_id);
      if (unit.status === "active")
        throw new DomainError("UNIT_ACTIVE", `仪器 ${command.unit_id} 仍然有效，无需复检`);
      if (!command.valid_until || !timeGT(command.valid_until, command.at || now))
        throw new DomainError("BAD_CALIBRATION", "复检后的校准有效期必须晚于当前时间");
      emit({
        event_id: command.event_id || `evt-recert-${command.unit_id}`,
        event_type: "CALIBRATION_RECERTIFIED",
        aggregate_type: "resource_unit",
        aggregate_id: command.unit_id,
        occurred_at: command.at || now,
        summary: `仪器 ${command.unit_id} 复检通过，校准有效至 ${command.valid_until}`,
        unit_id: command.unit_id,
        revision_id: command.revision_id,
        calibration_valid_until: command.valid_until,
      });
      break;
    }

    case "clearBatch": {
      const batch = requireBatch(state, command.batch_id);
      if (batch.status !== "quarantined")
        throw new DomainError("BATCH_NOT_QUARANTINED", `批次 ${command.batch_id} 未隔离`);
      if (!["cleared", "discarded"].includes(command.disposition))
        throw new DomainError("BAD_DISPOSITION", "处置必须是 cleared 或 discarded");
      emit({
        event_id: command.event_id || `evt-batch-clear-${command.batch_id}`,
        event_type: "BATCH_CLEARED",
        aggregate_type: "consumable_batch",
        aggregate_id: command.batch_id,
        occurred_at: command.at || now,
        summary:
          command.disposition === "cleared"
            ? `批次 ${command.batch_id} 复检合格解除隔离`
            : `批次 ${command.batch_id} 污染报废`,
        batch_id: command.batch_id,
        revision_id: command.revision_id,
        disposition: command.disposition,
      });
      if (command.disposition === "discarded") {
        // 依赖批次永久不可用，等待/暂停中的候补按原截止点判定终止。
        for (const entry of Object.values(state.waitlist)) {
          if (!["waiting", "paused"].includes(entry.status)) continue;
          if (!entry.items.some((item) => item.batch_id === command.batch_id)) continue;
          emitWaitlistExpired(entry, command.at || now, emit, `依赖批次 ${command.batch_id} 污染报废`);
        }
      }
      break;
    }

    case "resumeSlot": {
      resumeSlot(command, state, now, emit);
      break;
    }

    case "proposeReplacement": {
      proposeReplacement(command, state, now, emit);
      break;
    }

    case "acceptEvidence": {
      const slot = requireSlot(state, command.slot_id);
      if (state.evidence[command.evidence_id]) throw new DomainError("EVIDENCE_EXISTS", "学习证据已存在");
      if (!command.source_ref) throw new DomainError("BAD_SOURCE", "证据必须保留来源 source_ref");
      const collectedAt = command.collected_at || command.at || now;
      // 只有仍被暂停或已被替换的槽位设采集边界；恢复后的新采集允许采纳。
      const blocked = slot.status === "suspended" || slot.status === "replaced";
      const boundary = slot.suspended_at || slot.replaced_at || null;
      if (blocked && boundary && time(collectedAt) > time(boundary))
        throw new DomainError("EVIDENCE_AFTER_SUSPENSION", "活动槽已暂停/替换后采集的数据不能作为该槽证据", {
          slot_id: command.slot_id,
          boundary,
          collected_at: collectedAt,
        });
      const preserved = boundary
        ? timeLE(collectedAt, boundary)
        : Boolean(slot.completed_at && timeLE(collectedAt, slot.completed_at));
      emit({
        event_id: command.event_id || `evt-evidence-${command.evidence_id}`,
        event_type: "EVIDENCE_ACCEPTED",
        aggregate_type: "learning_evidence",
        aggregate_id: command.evidence_id,
        occurred_at: command.at || now,
        summary: `采纳学习证据 ${command.evidence_id}（来源：${command.source_ref}）`,
        evidence_id: command.evidence_id,
        slot_id: command.slot_id,
        source_ref: command.source_ref,
        collected_at: collectedAt,
        preserved,
      });
      break;
    }

    case "invalidateEvidence": {
      const evidence = state.evidence[command.evidence_id];
      if (!evidence) throw new DomainError("EVIDENCE_NOT_FOUND", "学习证据不存在");
      if (evidence.status === "invalid") throw new DomainError("EVIDENCE_INVALID", "证据已经失效");
      if (!command.reason) throw new DomainError("BAD_REASON", "失效证据必须说明原因");
      emit({
        event_id: command.event_id || `evt-evidence-invalid-${command.evidence_id}`,
        event_type: "EVIDENCE_INVALIDATED",
        aggregate_type: "learning_evidence",
        aggregate_id: command.evidence_id,
        occurred_at: command.at || now,
        summary: `学习证据 ${command.evidence_id} 失效：${command.reason}`,
        evidence_id: command.evidence_id,
        revision_id: command.revision_id || null,
        reason: command.reason,
      });
      break;
    }

    case "reconcileWaitlists": {
      // 服务恢复后的显式收敛：按各候补原截止点继续判定，不改动截止点本身。
      drainWaitlist(state, command.at || now, emit);
      break;
    }

    case "resumeRevision": {
      const revision = requireRevision(state, command.revision_id);
      if (revision.status !== "open") throw new DomainError("REVISION_NOT_OPEN", "改线不处于进行中");
      emit({
        event_id: command.event_id || `evt-revision-resume-${command.revision_id}`,
        event_type: "REVISION_RESUMED",
        aggregate_type: "revision",
        aggregate_id: command.revision_id,
        occurred_at: command.at || now,
        summary: `改线 ${command.revision_id} 在服务恢复后按原截止点继续候补与复检`,
        revision_id: command.revision_id,
      });
      drainWaitlist(state, command.at || now, emit);
      break;
    }

    case "closeRevision": {
      const revision = requireRevision(state, command.revision_id);
      const pending = [];
      for (const unitId of revision.impacted_units) {
        const unit = state.units[unitId];
        if (unit.status !== "active") pending.push({ kind: "unit", id: unitId, status: unit.status });
      }
      for (const batchId of revision.impacted_batches) {
        const batch = state.batches[batchId];
        if (!["active", "discarded"].includes(batch.status))
          pending.push({ kind: "batch", id: batchId, status: batch.status });
      }
      for (const slotId of revision.suspended_slots) {
        const slot = state.slots[slotId];
        if (slot.status === "suspended") pending.push({ kind: "slot", id: slotId, status: slot.status });
      }
      for (const waitlistId of revision.paused_waitlist || []) {
        const entry = state.waitlist[waitlistId];
        if (entry && entry.status === "paused")
          pending.push({ kind: "waitlist", id: waitlistId, status: "paused" });
      }
      if (pending.length)
        throw new DomainError("RECOVERY_INCOMPLETE", "仍有未恢复节点，不能结束改线", { pending });
      emit({
        event_id: command.event_id || `evt-revision-close-${command.revision_id}`,
        event_type: "REVISION_CLOSED",
        aggregate_type: "revision",
        aggregate_id: command.revision_id,
        occurred_at: command.at || now,
        summary: `改线 ${command.revision_id} 全部节点恢复完成`,
        revision_id: command.revision_id,
      });
      break;
    }

    default:
      throw new DomainError("UNKNOWN_COMMAND", `未知命令：${command.type}`);
  }

  return { deduplicated: false, events };
}

// ---------------------------------------------------------------------------
// 命令处理细节
// ---------------------------------------------------------------------------

function slotsOfGroup(state, groupId) {
  return Object.values(state.slots)
    .filter((slot) => slot.group_id === groupId)
    .map((slot) => slot.slot_id);
}

function requireSlot(state, slotId) {
  const slot = state.slots[slotId];
  if (!slot) throw new DomainError("SLOT_NOT_FOUND", `活动槽不存在：${slotId}`);
  return slot;
}
function requireUnit(state, unitId) {
  const unit = state.units[unitId];
  if (!unit) throw new DomainError("UNIT_NOT_FOUND", `仪器不存在：${unitId}`);
  return unit;
}
function requireBatch(state, batchId) {
  const batch = state.batches[batchId];
  if (!batch) throw new DomainError("BATCH_NOT_FOUND", `耗材批次不存在：${batchId}`);
  return batch;
}
function requireRevision(state, revisionId) {
  const revision = state.revisions[revisionId];
  if (!revision) throw new DomainError("REVISION_NOT_FOUND", `改线不存在：${revisionId}`);
  return revision;
}

function checkUnitReady(unit, at) {
  if (!unit) throw new DomainError("UNIT_NOT_FOUND", "仪器不存在");
  if (unit.status === "quarantined" || unit.status === "cleaning")
    throw new DomainError("UNIT_UNAVAILABLE", `仪器 ${unit.unit_id} 当前 ${unit.status}`, {
      unit_id: unit.unit_id,
      status: unit.status,
    });
  if (!timeGE(unit.calibration_valid_until, at))
    throw new DomainError("CALIBRATION_EXPIRED", `仪器 ${unit.unit_id} 校准已失效`, {
      unit_id: unit.unit_id,
      valid_until: unit.calibration_valid_until,
    });
}

function confirmGroup(command, state, now, emit) {
  if (state.groups[command.group_id]) throw new DomainError("GROUP_EXISTS", "团组已确认");
  if (!Number.isInteger(command.headcount) || command.headcount <= 0)
    throw new DomainError("BAD_HEADCOUNT", "人数必须为正整数");
  if (!command.risk_group) throw new DomainError("BAD_RISK_GROUP", "必须给出风险分组");
  if (!Array.isArray(command.mentor_ids) || command.mentor_ids.length === 0)
    throw new DomainError("NO_MENTOR", "确认方案时必须锁定导师");

  const at = command.at || now;
  for (const mentorId of command.mentor_ids) {
    const mentor = state.mentors[mentorId];
    if (!mentor) throw new DomainError("MENTOR_NOT_FOUND", `导师不存在：${mentorId}`);
    const qualification = mentor.qualifications.find(
      (q) => (q.risk_group === command.risk_group || q.risk_group === "*") && timeGE(q.valid_until, at)
    );
    if (!qualification)
      throw new DomainError("MENTOR_NOT_QUALIFIED", `导师 ${mentorId} 不具备风险分组 ${command.risk_group} 的有效资格`, {
        mentor_id: mentorId,
        risk_group: command.risk_group,
      });
  }
  if (!Array.isArray(command.slots) || command.slots.length === 0)
    throw new DomainError("NO_SLOT", "确认方案必须包含活动槽");

  // 原子性校验：任何一台仪器校准失效或任一批次余量不足，整个团组都不确认。
  const wants = {};
  for (const plan of command.slots) {
    if (state.slots[plan.slot_id]) throw new DomainError("SLOT_EXISTS", `活动槽已存在：${plan.slot_id}`);
    if (!plan.objective) throw new DomainError("BAD_OBJECTIVE", `活动槽 ${plan.slot_id} 缺少目标`);
    for (const unitId of plan.unit_ids || []) checkUnitReady(state.units[unitId], at);
    for (const use of plan.consumptions || []) {
      const batch = requireBatch(state, use.batch_id);
      if (batch.status !== "active")
        throw new DomainError("BATCH_UNAVAILABLE", `批次 ${use.batch_id} 当前 ${batch.status}`);
      wants[use.batch_id] = (wants[use.batch_id] || 0) + use.quantity;
    }
  }
  for (const [batchId, need] of Object.entries(wants)) {
    const batch = state.batches[batchId];
    if (availableStock(batch) < need)
      throw new DomainError("INSUFFICIENT_STOCK", `批次 ${batchId} 可用余量不足：需要 ${need}，可用 ${availableStock(batch)}`, {
        batch_id: batchId,
        available: availableStock(batch),
        needed: need,
      });
  }

  emit({
    event_id: command.event_id || `evt-group-${command.group_id}`,
    event_type: "GROUP_CONFIRMED",
    aggregate_type: "student_group",
    aggregate_id: command.group_id,
    occurred_at: at,
    summary: `团组 ${command.group_id} 方案确认，同时锁定人数、导师资格、仪器校准、耗材批次与风险分组`,
    group_id: command.group_id,
    headcount: command.headcount,
    mentor_ids: command.mentor_ids,
    risk_group: command.risk_group,
    slot_ids: command.slots.map((plan) => plan.slot_id),
  });

  for (const plan of command.slots) {
    emit({
      event_id: command.event_id ? `${command.event_id}-lock-${plan.slot_id}` : `evt-lock-${plan.slot_id}`,
      event_type: "RESOURCE_LOCKED",
      aggregate_type: "activity_slot",
      aggregate_id: plan.slot_id,
      occurred_at: at,
      summary: `活动槽 ${plan.slot_id} 锁定仪器与耗材预留`,
      slot_id: plan.slot_id,
      group_id: command.group_id,
      objective: plan.objective,
      risk_group: command.risk_group,
      unit_ids: plan.unit_ids || [],
      reservations: (plan.consumptions || []).map((use) => ({ batch_id: use.batch_id, quantity: use.quantity })),
      calibration_snapshot: Object.fromEntries(
        (plan.unit_ids || []).map((unitId) => [unitId, state.units[unitId].calibration_valid_until])
      ),
    });
  }
}

function releaseUnused(command, state, now, emit) {
  const slot = requireSlot(state, command.slot_id);
  const held = state.reservations[command.slot_id] || {};
  const releases = Object.entries(held)
    .filter(([, qty]) => qty > 0)
    .map(([batch_id, quantity]) => ({ batch_id, quantity }));
  if (releases.length === 0) throw new DomainError("NOTHING_RESERVED", `活动槽 ${command.slot_id} 没有可释放的预留`);

  emit({
    event_id: command.event_id || `evt-release-${command.slot_id}`,
    event_type: "RESERVATION_RELEASED",
    aggregate_type: "activity_slot",
    aggregate_id: command.slot_id,
    occurred_at: command.at || now,
    summary: `活动槽 ${command.slot_id} 原子释放未使用预留`,
    slot_id: command.slot_id,
    releases,
  });
  drainWaitlist(state, command.at || now, emit);
}

// 按（截止点 cutoff, 登记顺序）贪心整单满足候补；与释放事件在同一原子批次里追加。
function drainWaitlist(state, now, emit) {
  for (const waitlistId of state.waitlistOrder) {
    const entry = state.waitlist[waitlistId];
    if (entry.status !== "waiting") continue;
    const pastCutoff = Date.parse(now) > Date.parse(entry.cutoff);
    const fits = entry.items.every((item) => {
      const batch = state.batches[item.batch_id];
      return batch.status === "active" && availableStock(batch) >= item.quantity;
    });
    if (pastCutoff) {
      emitWaitlistExpired(entry, now, emit, "超过候补截止点");
    } else if (fits) {
      emit({
        event_id: `evt-waitlist-fulfilled-${entry.waitlist_id}`,
        event_type: "WAITLIST_FULFILLED",
        aggregate_type: "waitlist_entry",
        aggregate_id: waitlistId,
        occurred_at: now,
        summary: `候补 ${waitlistId} 在截止点 ${entry.cutoff} 前获得预留`,
        waitlist_id: waitlistId,
        target_slot_id: entry.target_slot_id,
        cutoff: entry.cutoff,
        items: entry.items,
      });
    }
  }
}

function emitWaitlistExpired(entry, now, emit, reason) {
  emit({
    event_id: `evt-waitlist-expired-${entry.waitlist_id}`,
    event_type: "WAITLIST_EXPIRED",
    aggregate_type: "waitlist_entry",
    aggregate_id: entry.waitlist_id,
    occurred_at: now,
    summary: `候补 ${entry.waitlist_id} 终止：${reason}`,
    waitlist_id: entry.waitlist_id,
    reason,
  });
}

function traceImpact(state, root) {
  const reached = new Set([nodeKey(root)]);
  const queue = [nodeKey(root)];
  while (queue.length) {
    const current = queue.pop();
    for (const edge of state.edges) {
      const a = nodeKey(edge.from);
      const b = nodeKey(edge.to);
      const other = a === current ? b : b === current ? a : null;
      if (other && !reached.has(other)) {
        reached.add(other);
        queue.push(other);
      }
    }
  }
  const units = [];
  const batches = [];
  const samples = [];
  for (const key of reached) {
    const [kind, id] = key.split(":");
    if (kind === "unit") units.push(id);
    else if (kind === "batch") batches.push(id);
    else samples.push(id);
  }
  const slotSet = new Set();
  // 接触发生地
  for (const edge of state.edges) {
    if (reached.has(nodeKey(edge.from)) || reached.has(nodeKey(edge.to))) slotSet.add(edge.slot_id);
  }
  // 器材/批次锁定关系：同批次被另一团组继续领用也在此被定位
  for (const slot of Object.values(state.slots)) {
    if (TERMINAL_SLOT_STATUS.has(slot.status)) continue;
    if (slot.unit_ids.some((unitId) => reached.has(`unit:${unitId}`))) slotSet.add(slot.slot_id);
    const held = state.reservations[slot.slot_id] || {};
    if (Object.keys(held).some((batchId) => reached.has(`batch:${batchId}`))) slotSet.add(slot.slot_id);
    if ((slot.consumed_batches || []).some((batchId) => reached.has(`batch:${batchId}`)))
      slotSet.add(slot.slot_id);
  }
  return { units, batches, samples, slot_ids: [...slotSet] };
}

function raiseHazard(command, state, now, emit) {
  const at = command.at || now;
  if (!command.revision_id) throw new DomainError("BAD_REVISION", "必须给出改线标识");
  if (state.revisions[command.revision_id]) throw new DomainError("REVISION_EXISTS", "改线标识已存在");
  if (!["contamination", "calibration"].includes(command.kind))
    throw new DomainError("BAD_HAZARD", "危害类型必须是 contamination 或 calibration");

  const impact = traceImpact(state, command.root);
  const suspend = impact.slot_ids.filter((slotId) => {
    const slot = state.slots[slotId];
    return slot && !TERMINAL_SLOT_STATUS.has(slot.status) && slot.status !== "suspended";
  });
  const pausedWaitlist = Object.values(state.waitlist)
    .filter(
      (entry) =>
        entry.status === "waiting" && entry.items.some((item) => impact.batches.includes(item.batch_id))
    )
    .map((entry) => entry.waitlist_id);

  emit({
    event_id: command.event_id || `evt-hazard-${command.revision_id}`,
    event_type: "HAZARD_RAISED",
    aggregate_type: "revision",
    aggregate_id: command.revision_id,
    occurred_at: at,
    summary:
      command.kind === "contamination"
        ? `发现污染，沿接触链定位受影响活动并启动改线 ${command.revision_id}`
        : `发现仪器校准失效，沿接触链定位受影响活动并启动改线 ${command.revision_id}`,
    revision_id: command.revision_id,
    hazard: command.kind,
    root: command.root,
    reason: command.reason || null,
    detected_slot_id: command.detected_slot_id || null,
    impacted_units: impact.units,
    impacted_batches: impact.batches,
    impacted_samples: impact.samples,
    impacted_slots: suspend,
    paused_waitlist: pausedWaitlist,
    plan: {
      clean_units: impact.units,
      recert_units: impact.units,
      substitute_batches: impact.batches,
      routes: suspend.map((slotId) => ({
        slot_id: slotId,
        recommended: "resume_or_replace_after_recert",
      })),
    },
  });

  for (const unitId of impact.units) {
    emit({
      event_id: `evt-quarantine-unit-${command.revision_id}-${unitId}`,
      event_type: "RESOURCE_QUARANTINED",
      aggregate_type: "resource_unit",
      aggregate_id: unitId,
      occurred_at: at,
      summary: `仪器 ${unitId} 沿接触链被判定受影响，进入隔离`,
      unit_id: unitId,
      revision_id: command.revision_id,
    });
  }
  for (const batchId of impact.batches) {
    emit({
      event_id: `evt-quarantine-batch-${command.revision_id}-${batchId}`,
      event_type: "RESOURCE_QUARANTINED",
      aggregate_type: "consumable_batch",
      aggregate_id: batchId,
      occurred_at: at,
      summary: `耗材批次 ${batchId} 沿接触链被判定受影响，进入隔离`,
      batch_id: batchId,
      revision_id: command.revision_id,
    });
  }
  for (const slotId of suspend) {
    emit({
      event_id: `evt-suspend-${command.revision_id}-${slotId}`,
      event_type: "SLOT_SUSPENDED",
      aggregate_type: "activity_slot",
      aggregate_id: slotId,
      occurred_at: at,
      summary: `仅暂停受影响的未完成活动槽 ${slotId}，已完成节点保留`,
      slot_id: slotId,
      revision_id: command.revision_id,
    });
  }
}

function resumeSlot(command, state, now, emit) {
  const at = command.at || now;
  const slot = requireSlot(state, command.slot_id);
  if (slot.status !== "suspended")
    throw new DomainError("SLOT_NOT_SUSPENDED", `活动槽 ${command.slot_id} 未暂停`);
  for (const unitId of slot.unit_ids) checkUnitReady(state.units[unitId], at);

  const changes = command.resource_changes || [];
  const releases = [];
  const additions = [];
  const held = state.reservations[command.slot_id] || {};
  for (const change of changes) {
    const oldQty = held[change.from_batch_id] || 0;
    if (oldQty <= 0)
      throw new DomainError("NOTHING_RESERVED", `活动槽没有批次 ${change.from_batch_id} 的未用预留可替换`);
    const target = requireBatch(state, change.to_batch_id);
    if (target.status !== "active")
      throw new DomainError("BATCH_UNAVAILABLE", `替代批次 ${change.to_batch_id} 不可用`);
    if (availableStock(target) < oldQty)
      throw new DomainError("INSUFFICIENT_STOCK", `替代批次 ${change.to_batch_id} 余量不足`);
    releases.push({ batch_id: change.from_batch_id, quantity: oldQty });
    additions.push({ batch_id: change.to_batch_id, quantity: oldQty });
  }

  emit({
    event_id: command.event_id || `evt-resume-${command.slot_id}`,
    event_type: "SLOT_RESUMED",
    aggregate_type: "activity_slot",
    aggregate_id: command.slot_id,
    occurred_at: at,
    summary:
      additions.length > 0
        ? `活动槽 ${command.slot_id} 清洁复检后恢复，耗材改走替代批次`
        : `活动槽 ${command.slot_id} 清洁复检后恢复`,
    slot_id: command.slot_id,
    revision_id: command.revision_id,
    prior_status: slot.prior_status || "started",
    releases,
    additions,
  });
  drainWaitlist(state, at, emit);
}

function proposeReplacement(command, state, now, emit) {
  const at = command.at || now;
  const original = requireSlot(state, command.original_slot_id);
  if (original.status !== "suspended")
    throw new DomainError("SLOT_NOT_SUSPENDED", `只能替换已暂停的活动槽：${command.original_slot_id}`);
  if (state.slots[command.new_slot_id]) throw new DomainError("SLOT_EXISTS", "新活动槽已存在");
  if (!command.equivalence_note)
    throw new DomainError("BAD_EQUIVALENCE", "替换活动必须说明目标等价关系");
  for (const unitId of command.unit_ids || []) checkUnitReady(state.units[unitId], at);
  const wants = {};
  for (const use of command.consumptions || []) {
    const batch = requireBatch(state, use.batch_id);
    if (batch.status !== "active") throw new DomainError("BATCH_UNAVAILABLE", `批次 ${use.batch_id} 不可用`);
    wants[use.batch_id] = (wants[use.batch_id] || 0) + use.quantity;
  }
  for (const [batchId, need] of Object.entries(wants)) {
    if (availableStock(state.batches[batchId]) < need)
      throw new DomainError("INSUFFICIENT_STOCK", `批次 ${batchId} 余量不足，无法安排替代路线`);
  }
  const held = state.reservations[command.original_slot_id] || {};
  const releases = Object.entries(held)
    .filter(([, qty]) => qty > 0)
    .map(([batch_id, quantity]) => ({ batch_id, quantity }));

  emit({
    event_id: `evt-lock-${command.new_slot_id}`,
    event_type: "RESOURCE_LOCKED",
    aggregate_type: "activity_slot",
    aggregate_id: command.new_slot_id,
    occurred_at: at,
    summary: `替代活动槽 ${command.new_slot_id} 锁定资源（替换 ${command.original_slot_id}）`,
    slot_id: command.new_slot_id,
    group_id: original.group_id,
    objective: command.objective,
    risk_group: original.risk_group,
    unit_ids: command.unit_ids || [],
    reservations: (command.consumptions || []).map((use) => ({ batch_id: use.batch_id, quantity: use.quantity })),
    calibration_snapshot: Object.fromEntries(
      (command.unit_ids || []).map((unitId) => [unitId, state.units[unitId].calibration_valid_until])
    ),
    replacement_of: command.original_slot_id,
    original_objective: original.objective,
    equivalence_note: command.equivalence_note,
    revision_id: command.revision_id,
  });
  emit({
    event_id: command.event_id || `evt-replaced-${command.original_slot_id}`,
    event_type: "SLOT_REPLACED",
    aggregate_type: "activity_slot",
    aggregate_id: command.original_slot_id,
    occurred_at: at,
    summary: `活动槽 ${command.original_slot_id} 改走替代路线 ${command.new_slot_id}，已采集合法证据保留来源`,
    slot_id: command.original_slot_id,
    replacement_slot_id: command.new_slot_id,
    revision_id: command.revision_id,
    releases,
  });
  drainWaitlist(state, at, emit);
}

// ---------------------------------------------------------------------------
// 事件归约
// ---------------------------------------------------------------------------

export function applyEvent(state, event) {
  // 重放去重由服务层按 event_id 判定；内核默认事件有效。
  state.seenEvents[event.event_id] = event.content_hash || null;
  if (event.command_id) state.seenCommands[event.command_id] = event.event_id;
  state.seq[event.aggregate_id] = Math.max(state.seq[event.aggregate_id] || 0, event.version || 1);

  switch (event.event_type) {
    case "MENTOR_REGISTERED":
      state.mentors[event.mentor_id] = {
        mentor_id: event.mentor_id,
        qualifications: event.qualifications,
      };
      break;

    case "UNIT_REGISTERED":
      state.units[event.unit_id] = {
        unit_id: event.unit_id,
        name: event.name,
        status: "active",
        calibration_valid_until: event.calibration_valid_until,
        ledger: [],
      };
      break;

    case "BATCH_REGISTERED":
      state.batches[event.batch_id] = {
        batch_id: event.batch_id,
        name: event.name,
        quantity: event.quantity,
        reserved: 0,
        consumed: 0,
        discarded: 0,
        status: "active",
        ledger: [
          {
            at: event.occurred_at,
            event_type: "BATCH_REGISTERED",
            ref: event.batch_id,
            reserved_delta: 0,
            consumed_delta: 0,
            available_after: event.quantity,
          },
        ],
      };
      break;

    case "GROUP_CONFIRMED":
      state.groups[event.group_id] = {
        group_id: event.group_id,
        headcount: event.headcount,
        mentor_ids: event.mentor_ids,
        risk_group: event.risk_group,
        slot_ids: event.slot_ids,
        status: "confirmed",
      };
      break;

    case "RESOURCE_LOCKED": {
      const reservations = event.reservations || [];
      state.slots[event.slot_id] = {
        slot_id: event.slot_id,
        group_id: event.group_id,
        status: "confirmed",
        objective: event.objective,
        risk_group: event.risk_group,
        unit_ids: event.unit_ids || [],
        replacement_of: event.replacement_of || null,
        original_objective: event.original_objective || null,
        equivalence_note: event.equivalence_note || null,
        consumed_batches: [],
      };
      const held = (state.reservations[event.slot_id] ||= {});
      for (const r of reservations) {
        const batch = state.batches[r.batch_id];
        batch.reserved += r.quantity;
        held[r.batch_id] = (held[r.batch_id] || 0) + r.quantity;
        batch.ledger.push({
          at: event.occurred_at,
          event_type: "RESOURCE_LOCKED",
          ref: event.slot_id,
          reserved_delta: r.quantity,
          consumed_delta: 0,
          available_after: availableStock(batch),
        });
      }
      break;
    }

    case "ACTIVITY_STARTED":
      state.slots[event.slot_id].status = "started";
      state.slots[event.slot_id].started_at = event.occurred_at;
      break;

    case "SLOT_COMPLETED":
      state.slots[event.slot_id].status = "completed";
      state.slots[event.slot_id].completed_at = event.occurred_at;
      markEvidencePreserved(state, event.slot_id, event.occurred_at);
      break;
    case "CONSUMABLES_ISSUED": {
      const slot = state.slots[event.slot_id];
      const held = state.reservations[event.slot_id] ||= {};
      for (const item of event.items) {
        const batch = state.batches[item.batch_id];
        batch.reserved -= item.quantity;
        batch.consumed += item.quantity;
        held[item.batch_id] -= item.quantity;
        if (!slot.consumed_batches.includes(item.batch_id)) slot.consumed_batches.push(item.batch_id);
        batch.ledger.push({
          at: event.occurred_at,
          event_type: "CONSUMABLES_ISSUED",
          ref: event.receipt_id || event.slot_id,
          reserved_delta: -item.quantity,
          consumed_delta: item.quantity,
          available_after: availableStock(batch),
        });
      }
      slot.last_receipt_id = event.receipt_id;
      if (event.receipt_id) {
        state.seenReceipts[event.receipt_id] = event.event_id;
        state.receipts[event.receipt_id] = {
          hash: event.receipt_hash || null,
          event_id: event.event_id,
        };
      }
      break;
    }

    case "RESERVATION_RELEASED":
      applyReleases(state, event.slot_id, event.releases, event.occurred_at);
      break;

    case "WAITLIST_REGISTERED": {
      state.waitlist[event.waitlist_id] = {
        waitlist_id: event.waitlist_id,
        group_id: event.group_id,
        target_slot_id: event.target_slot_id,
        cutoff: event.cutoff,
        items: event.items,
        status: "waiting",
        registered_seq: state.waitlistOrder.length,
      };
      state.waitlistOrder.push(event.waitlist_id);
      break;
    }

    case "WAITLIST_FULFILLED": {
      const entry = state.waitlist[event.waitlist_id];
      entry.status = "fulfilled";
      entry.fulfilled_at = event.occurred_at;
      const held = (state.reservations[event.target_slot_id] ||= {});
      for (const item of event.items) {
        const batch = state.batches[item.batch_id];
        batch.reserved += item.quantity;
        held[item.batch_id] = (held[item.batch_id] || 0) + item.quantity;
        batch.ledger.push({
          at: event.occurred_at,
          event_type: "WAITLIST_FULFILLED",
          ref: event.waitlist_id,
          reserved_delta: item.quantity,
          consumed_delta: 0,
          available_after: availableStock(batch),
        });
      }
      if (!state.slots[event.target_slot_id]) {
        state.slots[event.target_slot_id] = {
          slot_id: event.target_slot_id,
          group_id: entry.group_id,
          status: "reserved",
          unit_ids: [],
          objective: null,
          consumed_batches: [],
        };
      }
      break;
    }

    case "WAITLIST_EXPIRED":
      state.waitlist[event.waitlist_id].status = "expired";
      state.waitlist[event.waitlist_id].expired_at = event.occurred_at;
      state.waitlist[event.waitlist_id].expire_reason = event.reason;
      break;

    case "CONTACT_RECORDED":
      state.edges.push({
        from: event.from,
        to: event.to,
        via: event.via,
        slot_id: event.slot_id,
        at: event.occurred_at,
      });
      break;

    case "HAZARD_RAISED":
      state.revisions[event.revision_id] = {
        revision_id: event.revision_id,
        hazard: event.hazard,
        root: event.root,
        reason: event.reason,
        detected_slot_id: event.detected_slot_id,
        status: "open",
        impacted_units: event.impacted_units,
        impacted_batches: event.impacted_batches,
        impacted_samples: event.impacted_samples,
        suspended_slots: event.impacted_slots,
        paused_waitlist: event.paused_waitlist,
        resumed_slots: [],
        replacements: [],
        invalidated_evidence: [],
        raised_at: event.occurred_at,
      };
      for (const waitlistId of event.paused_waitlist) state.waitlist[waitlistId].status = "paused";
      break;

    case "RESOURCE_QUARANTINED":
      if (event.aggregate_type === "resource_unit") {
        state.units[event.unit_id].status = "quarantined";
        state.units[event.unit_id].quarantined_at = event.occurred_at;
      } else {
        state.batches[event.batch_id].status = "quarantined";
        state.batches[event.batch_id].quarantined_at = event.occurred_at;
      }
      break;

    case "SLOT_SUSPENDED": {
      const slot = state.slots[event.slot_id];
      slot.prior_status = slot.status;
      slot.status = "suspended";
      slot.suspended_at = event.occurred_at;
      slot.revision_id = event.revision_id;
      markEvidencePreserved(state, event.slot_id, event.occurred_at);
      break;
    }

    case "CLEANING_RECORDED":
      state.units[event.unit_id].status = "cleaning";
      state.units[event.unit_id].cleaned_at = event.occurred_at;
      break;

    case "CALIBRATION_RECERTIFIED": {
      const unit = state.units[event.unit_id];
      unit.status = "active";
      unit.calibration_valid_until = event.calibration_valid_until;
      unit.recertified_at = event.occurred_at;
      break;
    }

    case "BATCH_CLEARED": {
      const batch = state.batches[event.batch_id];
      if (event.disposition === "discarded") {
        // 物理上除已消耗外全部报废；账面预留随后续 SLOT_RESUMED/REPLACED 释放。
        const leftover = Math.max(0, batch.quantity - batch.consumed);
        batch.discarded += leftover;
        batch.status = "discarded";
        batch.ledger.push({
          at: event.occurred_at,
          event_type: "BATCH_CLEARED",
          ref: event.batch_id,
          reserved_delta: 0,
          consumed_delta: 0,
          discarded_delta: leftover,
          available_after: null,
        });
      } else {
        batch.status = "active";
        batch.ledger.push({
          at: event.occurred_at,
          event_type: "BATCH_CLEARED",
          ref: event.batch_id,
          reserved_delta: 0,
          consumed_delta: 0,
          discarded_delta: 0,
          available_after: availableStock(batch),
        });
      }
      batch.cleared_at = event.occurred_at;
      break;
    }

    case "SLOT_RESUMED": {
      const slot = state.slots[event.slot_id];
      applyReleases(state, event.slot_id, event.releases || [], event.occurred_at);
      const held = (state.reservations[event.slot_id] ||= {});
      for (const add of event.additions || []) {
        const batch = state.batches[add.batch_id];
        batch.reserved += add.quantity;
        held[add.batch_id] = (held[add.batch_id] || 0) + add.quantity;
        batch.ledger.push({
          at: event.occurred_at,
          event_type: "SLOT_RESUMED",
          ref: event.slot_id,
          reserved_delta: add.quantity,
          consumed_delta: 0,
          available_after: availableStock(batch),
        });
      }
      slot.status = event.prior_status === "confirmed" ? "confirmed" : "started";
      slot.resumed_at = event.occurred_at;
      const revision = state.revisions[event.revision_id];
      if (revision && !revision.resumed_slots.includes(event.slot_id)) revision.resumed_slots.push(event.slot_id);
      break;
    }

    case "SLOT_REPLACED": {
      applyReleases(state, event.slot_id, event.releases || [], event.occurred_at);
      const original = state.slots[event.slot_id];
      original.status = "replaced";
      original.replaced_at = event.occurred_at;
      original.replacement_slot_id = event.replacement_slot_id;
      markEvidencePreserved(state, event.slot_id, event.occurred_at);
      const revision = state.revisions[event.revision_id];
      if (revision)
        revision.replacements.push({
          original_slot_id: event.slot_id,
          replacement_slot_id: event.replacement_slot_id,
          equivalence_note: state.slots[event.replacement_slot_id].equivalence_note,
        });
      break;
    }

    case "EVIDENCE_ACCEPTED":
      state.evidence[event.evidence_id] = {
        evidence_id: event.evidence_id,
        slot_id: event.slot_id,
        source_ref: event.source_ref,
        collected_at: event.collected_at,
        status: "valid",
        preserved: event.preserved || false,
        accepted_at: event.occurred_at,
      };
      break;

    case "EVIDENCE_INVALIDATED": {
      const evidence = state.evidence[event.evidence_id];
      evidence.status = "invalid";
      evidence.invalid_reason = event.reason;
      evidence.invalidated_at = event.occurred_at;
      if (event.revision_id) {
        const revision = state.revisions[event.revision_id];
        if (revision)
          revision.invalidated_evidence.push({ evidence_id: event.evidence_id, reason: event.reason });
      }
      break;
    }

    case "REVISION_RESUMED":
      state.revisions[event.revision_id].resumed_at = event.occurred_at;
      for (const entry of Object.values(state.waitlist)) {
        if (entry.status !== "paused") continue;
        const blocked = entry.items.some((item) => state.batches[item.batch_id].status !== "active");
        entry.status = blocked ? "paused" : "waiting";
      }
      break;

    case "REVISION_CLOSED":
      state.revisions[event.revision_id].status = "closed";
      state.revisions[event.revision_id].closed_at = event.occurred_at;
      break;

    case "RECEIPT_QUARANTINED":
      state.quarantine[event.receipt_id] = {
        kind: "offline_receipt",
        id: event.receipt_id,
        reason: event.reason,
        prior_event_id: event.prior_event_id,
        received_at: event.occurred_at,
      };
      break;

    case "EVENT_QUARANTINED":
      // 同标识异内容事件的隔离登记本身也是只增事件，保证崩溃恢复后隔离区不丢。
      state.quarantine[event.event_ref] = {
        kind: "event",
        id: event.event_ref,
        reason: event.reason,
        received_at: event.occurred_at,
      };
      break;

    default:
      // 未知事件不阻断重放（向前兼容），但明确记录在案。
      break;
  }
  return state;
}

// 改线节点（暂停/替换/完成）时，把此前合法采集的证据标记为保留来源。
function markEvidencePreserved(state, slotId, boundary) {
  for (const evidence of Object.values(state.evidence)) {
    if (evidence.slot_id === slotId && timeLE(evidence.collected_at, boundary)) evidence.preserved = true;
  }
}

function applyReleases(state, slotId, releases, at) {
  const held = state.reservations[slotId] || {};
  for (const r of releases) {
    const qty = Math.min(r.quantity, held[r.batch_id] || 0);
    if (qty <= 0) continue;
    const batch = state.batches[r.batch_id];
    batch.reserved -= qty;
    held[r.batch_id] -= qty;
    batch.ledger.push({
      at,
      event_type: "RESERVATION_RELEASED",
      ref: slotId,
      reserved_delta: -qty,
      consumed_delta: 0,
      available_after: batch.status === "active" ? availableStock(batch) : null,
    });
  }
}
