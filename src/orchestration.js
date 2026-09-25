import { createHash } from "node:crypto";

import { EventStore, canonicalFingerprint } from "./eventStore.js";
import { ValidationRejected, EventConflictError } from "./errors.js";
import {
  fold,
  balanceOf,
  occupancyOf,
  traceContactChain,
} from "./projection.js";

const INSTRUMENT = "instrument";
const CONSUMABLE = "consumable_lot";

function stable(parts) {
  return createHash("sha1").update(parts.join("|")).digest("hex").slice(0, 12);
}

/**
 * 研学实操编排服务。
 * 所有写操作都以“一个原子事件批次”提交：要么全部落库，要么整体拒绝，
 * 因此“确认=同时锁定五条件”“释放预留=候补同批晋升”不会出现中间态。
 */
export class OrchestrationService {
  constructor(store = new EventStore(), clock = () => new Date()) {
    this.store = store;
    this.clock = clock;
    this.state = fold(store.events());
    // 已处理但整批被隔离冲突中止的回执登记，避免隔离回执被当作正常扣减重试
    this._conflictReceipts = new Map();
    // 进程内自增后缀，保证同批次内多条事件的自动标识唯一
    this._idCounter = store.size;
  }

  // ---------- 基础 ----------

  now() {
    return this.clock() instanceof Date ? this.clock().toISOString() : new Date(this.clock()).toISOString();
  }

  _draft(eventType, aggregateType, aggregateId, summary, payload) {
    const seq = this.store.nextVersion(aggregateId);
    const suffix = this._idCounter++;
    const event = {
      event_id: `evt-${aggregateId}-${seq}-${eventType}-${suffix}`,
      event_type: eventType,
      aggregate_type: aggregateType,
      aggregate_id: aggregateId,
      occurred_at: this.now(),
      summary,
      ...payload,
    };
    if (event.event_id === undefined || event.event_id === null) {
      event.event_id = `evt-${aggregateId}-${seq}-${eventType}-${suffix}`;
    }
    return event;
  }

  /** 原子提交；冲突时记录隔离信息并原样抛出。 */
  _commit(drafts) {
    try {
      return this.store.appendBatch(drafts);
    } catch (error) {
      if (error instanceof EventConflictError) {
        for (const d of drafts) {
          if (d.event_type === "CHECKOUT_RECORDED") {
            this._conflictReceipts.set(d.receipt_id, {
              receipt_id: d.receipt_id,
              slot_id: d.slot_id,
              reason: "SAME_ID_DIFFERENT_CONTENT",
              received_fingerprint: d.fingerprint,
              stored_fingerprint: canonicalFingerprint(error.details.existing ?? {}),
            });
          }
        }
      }
      throw error;
    } finally {
      this.state = fold(this.store.events());
    }
  }

  // ---------- 注册与建档 ----------

  registerInstrument({ instrument_id, name, calibrated_until, event_id } = {}) {
    if (!instrument_id) throw new ValidationRejected("BAD_INPUT", "缺少 instrument_id");
    if (this.state.resources.has(instrument_id)) throw new ValidationRejected("ALREADY_EXISTS", `仪器已存在：${instrument_id}`);
    this._commit([
      this._draft("RESOURCE_REGISTERED", "resource_unit", instrument_id, `登记仪器 ${name ?? instrument_id}`, {
        event_id,
        resource_id: instrument_id,
        kind: INSTRUMENT,
        name,
        calibrated_until: calibrated_until ?? null,
      }),
    ]);
    return instrument_id;
  }

  registerConsumableLot({ lot_id, name, quantity, unit = "份", event_id } = {}) {
    if (!lot_id) throw new ValidationRejected("BAD_INPUT", "缺少 lot_id");
    if (!Number.isInteger(quantity) || quantity <= 0) throw new ValidationRejected("BAD_INPUT", "耗材初始数量必须为正整数");
    if (this.state.resources.has(lot_id)) throw new ValidationRejected("ALREADY_EXISTS", `耗材批次已存在：${lot_id}`);
    this._commit([
      this._draft("RESOURCE_REGISTERED", "resource_unit", lot_id, `登记耗材批次 ${name ?? lot_id}`, {
        event_id,
        resource_id: lot_id,
        kind: CONSUMABLE,
        name,
        unit,
        initial_quantity: quantity,
      }),
    ]);
    return lot_id;
  }

  /** 登记样品：样品只参与器材-样品接触链追踪，不作为可预留资源。 */
  registerSample({ sample_id, name, event_id } = {}) {
    if (!sample_id) throw new ValidationRejected("BAD_INPUT", "缺少 sample_id");
    if (this.state.resources.has(sample_id)) throw new ValidationRejected("ALREADY_EXISTS", `样品已存在：${sample_id}`);
    this._commit([
      this._draft("RESOURCE_REGISTERED", "resource_unit", sample_id, `登记样品 ${name ?? sample_id}`, {
        event_id,
        resource_id: sample_id,
        kind: "sample",
        name,
        consumable: false,
      }),
    ]);
    return sample_id;
  }

  /** 记录器材/样品间的接触链（如同一台仪器处理过某样品、样品制备用到某耗材批次）。 */
  linkContact({ source_resource_id, target_resource_id, event_id, summary } = {}) {
    if (!this.state.resources.has(source_resource_id) || !this.state.resources.has(target_resource_id)) {
      throw new ValidationRejected("UNKNOWN_RESOURCE", "接触链两端必须都是已登记资源", {
        source_resource_id,
        target_resource_id,
      });
    }
    const linkId = stable(["contact", source_resource_id, target_resource_id].sort());
    this._commit([
      this._draft("CONTACT_LINKED", "resource_unit", `contact-${linkId}`, summary ?? "记录器材样品接触链", {
        event_id,
        source_resource_id,
        target_resource_id,
      }),
    ]);
  }

  registerMentor({ mentor_id, name, certifications = [], event_id } = {}) {
    if (!mentor_id) throw new ValidationRejected("BAD_INPUT", "缺少 mentor_id");
    this._commit([
      this._draft("MENTOR_REGISTERED", "mentor", mentor_id, `登记导师 ${name ?? mentor_id}`, {
        event_id,
        mentor_id,
        name,
        certifications,
      }),
    ]);
    return mentor_id;
  }

  registerGroup({ group_id, name, size, risk_group, event_id } = {}) {
    if (!group_id || !Number.isInteger(size) || size <= 0) {
      throw new ValidationRejected("BAD_INPUT", "团组标识与人数必填且人数为正整数");
    }
    this._commit([
      this._draft("GROUP_REGISTERED", "student_group", group_id, `登记团组 ${name ?? group_id}`, {
        event_id,
        group_id,
        name,
        size,
        risk_group: risk_group ?? null,
      }),
    ]);
    return group_id;
  }

  planSlot({
    slot_id,
    group_id,
    title,
    venue,
    scheduled_start,
    risk_level = 1,
    required_certifications = [],
    requirements = [],
    event_id,
  } = {}) {
    if (!slot_id || !group_id) throw new ValidationRejected("BAD_INPUT", "活动槽与团组标识必填");
    if (!this.state.groups.has(group_id)) throw new ValidationRejected("UNKNOWN_GROUP", `团组不存在：${group_id}`);
    this._commit([
      this._draft("SLOT_PLANNED", "activity_slot", slot_id, `规划活动 ${title ?? slot_id}`, {
        event_id,
        slot_id,
        group_id,
        title,
        venue: venue ?? null,
        scheduled_start,
        risk_level,
        required_certifications,
        requirements,
      }),
    ]);
    return slot_id;
  }

  // ---------- 确认：五条件同时锁定 ----------

  /**
   * 确认团组在活动槽的方案，同一事务锁定：
   * 人数（实到与登记一致）、导师资格（证书覆盖活动要求且在有效期）、
   * 仪器校准（在 scheduled_start 当日仍有效、且有空闲容量）、
   * 耗材批次（余量足够）、风险分组（团组风险许可覆盖活动风险等级）。
   * 任一不满足 → 整体拒绝，不产生任何预留。
   */
  confirmGroup({ group_id, slot_id, headcount, mentor_id, lines, event_id } = {}) {
    const group = this.state.groups.get(group_id);
    const slot = this.state.slots.get(slot_id);
    if (!group) throw new ValidationRejected("UNKNOWN_GROUP", `团组不存在：${group_id}`);
    if (!slot) throw new ValidationRejected("UNKNOWN_SLOT", `活动槽不存在：${slot_id}`);
    if (slot.group_id !== group_id) throw new ValidationRejected("SLOT_GROUP_MISMATCH", "活动槽不属于该团组");
    if (slot.status !== "planned") {
      throw new ValidationRejected("SLOT_NOT_PLANNED", `活动槽当前状态 ${slot.status} 不可确认`, { status: slot.status });
    }

    const failures = [];
    const locked = {};

    // 1) 人数
    if (!Number.isInteger(headcount) || headcount <= 0) failures.push("HEADCOUNT_INVALID");
    else if (headcount !== group.size) failures.push("HEADCOUNT_MISMATCH");
    locked.headcount = { declared: group.size, actual: headcount, ok: headcount === group.size };

    // 2) 导师资格
    const mentor = this.state.mentors.get(mentor_id);
    const certResults = [];
    if (!mentor) {
      failures.push("MENTOR_UNKNOWN");
    } else {
      const at = Date.parse(slot.scheduled_start ?? this.now());
      for (const certId of slot.required_certifications) {
        const validUntil = mentor.certifications.get(certId);
        const ok = Boolean(validUntil && Date.parse(validUntil) >= at);
        certResults.push({ cert_id: certId, valid_until: validUntil ?? null, ok });
        if (!ok) failures.push(`MENTOR_CERT_${certId}_INVALID`);
      }
    }
    locked.mentor = { mentor_id, certifications: certResults };

    // 5) 风险分组
    const clearance = this._riskClearance(group.risk_group);
    const riskOk = clearance >= (slot.risk_level ?? 1);
    if (!riskOk) failures.push("RISK_GROUP_CLEARANCE_INSUFFICIENT");
    locked.risk_group = { group: group.risk_group, clearance, required: slot.risk_level ?? 1, ok: riskOk };

    // 3)+4) 仪器校准/容量、耗材余量（聚合同 slot 多行的需求量）
    const needed = new Map();
    for (const line of lines ?? []) {
      needed.set(line.resource_id, (needed.get(line.resource_id) ?? 0) + line.quantity);
    }
    const lineResults = [];
    for (const [resourceId, quantity] of needed) {
      const resource = this.state.resources.get(resourceId);
      if (!resource) {
        failures.push(`RESOURCE_UNKNOWN_${resourceId}`);
        lineResults.push({ resource_id: resourceId, quantity, ok: false, reason: "UNKNOWN" });
        continue;
      }
      if (resource.kind === "sample") {
        failures.push(`SAMPLE_NOT_ALLOCATABLE_${resourceId}`);
        lineResults.push({ resource_id: resourceId, quantity, ok: false, reason: "SAMPLE_NOT_ALLOCATABLE" });
        continue;
      }
      if (resource.consumable) {
        const balance = balanceOf(this.state, resourceId);
        const ok = balance.available >= quantity;
        lineResults.push({
          resource_id: resourceId,
          quantity,
          kind: CONSUMABLE,
          available: balance.available,
          ok,
          reason: ok ? null : "INSUFFICIENT_STOCK",
        });
        if (!ok) failures.push(`CONSUMABLE_SHORTAGE_${resourceId}`);
      } else {
        const occupied = occupancyOf(this.state, resourceId);
        const capacity = resource.capacity ?? 1;
        const calOk = this._calibrationValid(resource, slot.scheduled_start);
        const capOk = occupied + quantity <= capacity;
        lineResults.push({
          resource_id: resourceId,
          quantity,
          kind: INSTRUMENT,
          occupied,
          capacity,
          calibrated_until: resource.calibrated_until,
          calibration_ok: calOk,
          capacity_ok: capOk,
          status: resource.status,
          ok: calOk && capOk && resource.status === "available",
          reason: !calOk ? "CALIBRATION_EXPIRED" : !capOk ? "CAPACITY_FULL" : resource.status !== "available" ? `RESOURCE_${resource.status}` : null,
        });
        if (!calOk) failures.push(`CALIBRATION_EXPIRED_${resourceId}`);
        if (!capOk) failures.push(`CAPACITY_FULL_${resourceId}`);
        if (resource.status !== "available") failures.push(`RESOURCE_UNAVAILABLE_${resourceId}`);
      }
    }
    locked.resources = lineResults;

    if (failures.length) {
      throw new ValidationRejected("CONFIRMATION_PRECONDITIONS_FAILED", "方案确认条件未全部满足，未产生任何锁定", {
        slot_id,
        failures,
        locked,
      });
    }

    const allocationLines = (lines ?? []).map((line, index) => ({
      reservation_id: line.reservation_id ?? `rsv-${slot_id}-${line.resource_id}-${index}`,
      resource_id: line.resource_id,
      quantity: line.quantity,
    }));

    const drafts = [
      this._draft("GROUP_CONFIRMED", "student_group", group_id, `团组 ${group_id} 确认活动 ${slot_id}，五条件同时锁定`, {
        event_id,
        group_id,
        slot_id,
        mentor_id,
        headcount,
        locked,
      }),
      this._draft("RESOURCE_ALLOCATED", "activity_slot", slot_id, `活动 ${slot_id} 原子锁定器材与耗材`, {
        event_id: event_id ? `${event_id}-alloc` : undefined,
        slot_id,
        group_id,
        source: "confirmation",
        lines: allocationLines,
      }),
    ];
    this._commit(drafts);
    return {
      group_id,
      slot_id,
      locked,
      reservations: allocationLines.map((l) => l.reservation_id),
    };
  }

  _riskClearance(riskGroup) {
    // A/B/C 风险分组对应可承担的最高风险等级；未分组按最低等级处理
    const table = { A: 3, B: 2, C: 1 };
    return table[riskGroup] ?? 0;
  }

  _calibrationValid(resource, whenIso) {
    if (resource.kind !== INSTRUMENT) return true;
    if (!resource.calibrated_until) return false;
    const at = whenIso ? Date.parse(whenIso) : Date.now();
    return Date.parse(resource.calibrated_until) >= at;
  }

  // ---------- 候补 ----------

  requestWaitlist({ request_id, group_id, slot_id, resource_id, quantity, expires_at, event_id } = {}) {
    if (!request_id || !resource_id) throw new ValidationRejected("BAD_INPUT", "候补申请标识与资源必填");
    if (this.state.waitlist.entries.has(request_id)) {
      throw new ValidationRejected("ALREADY_EXISTS", `候补申请已存在：${request_id}`);
    }
    this._commit([
      this._draft("WAITLIST_REQUESTED", "resource_unit", resource_id, `候补登记 ${request_id}`, {
        event_id,
        request_id,
        group_id,
        slot_id,
        resource_id,
        quantity,
        expires_at: expires_at ?? null,
      }),
    ]);
    return request_id;
  }

  // ---------- 活动开始与实际领用 ----------

  startActivity({ slot_id, event_id } = {}) {
    const slot = this.state.slots.get(slot_id);
    if (!slot) throw new ValidationRejected("UNKNOWN_SLOT", `活动槽不存在：${slot_id}`);
    if (!["confirmed", "rerouted", "resumed"].includes(slot.status) && slot.status !== "started") {
      throw new ValidationRejected("SLOT_NOT_CONFIRMED", `活动槽状态 ${slot.status} 不可开始`);
    }
    if (slot.status === "started") return { slot_id, deduplicated: true };
    this._commit([
      this._draft("ACTIVITY_STARTED", "activity_slot", slot_id, `活动 ${slot_id} 开始`, { event_id, slot_id }),
    ]);
    return { slot_id, deduplicated: false };
  }

  /**
   * 活动开始后按实际领用扣减。
   * receipt_id 幂等：离线回执完整重放（同标识同内容）不重复扣减；
   * 同标识异内容 → RECEIPT_QUARANTINED 隔离，不产生任何扣减。
   */
  recordCheckout({ receipt_id, slot_id, lines } = {}) {
    if (!receipt_id || !slot_id) throw new ValidationRejected("BAD_INPUT", "回执标识与活动槽必填");

    // 先把入参行规范化为标准领用行（解析出 resource_id），用于回执指纹比对。
    // 规范化只依赖预留存在与归属，不依赖活动状态——服务重启后重放回执时活动可能已完成。
    const checkoutLines = [];
    for (const line of lines ?? []) {
      const reservation = this.state.reservations.get(line.reservation_id);
      if (!reservation || reservation.slot_id !== slot_id) {
        throw new ValidationRejected("UNKNOWN_RESERVATION", "领用行必须对应该活动的有效预留", line);
      }
      if (!Number.isInteger(line.quantity) || line.quantity <= 0) {
        throw new ValidationRejected("CHECKOUT_QUANTITY_INVALID", "领用数量必须为正整数", line);
      }
      checkoutLines.push({
        reservation_id: line.reservation_id,
        resource_id: reservation.resource_id,
        quantity: line.quantity,
      });
    }
    const fingerprint = this._receiptFingerprint(receipt_id, slot_id, checkoutLines);

    // 同标识回执的幂等/隔离判定优先于一切业务状态校验：
    // 内容一致 → 幂等不重复扣减；内容不一致 → 隔离（不扣减）；已隔离 → 保持隔离。
    if (this._conflictReceipts.has(receipt_id)) {
      return { receipt_id, status: "quarantined", deduplicated: false, reason: "SAME_ID_DIFFERENT_CONTENT" };
    }
    const storedReceipt = this.state.receipts.get(receipt_id);
    if (storedReceipt) {
      if (storedReceipt.status === "quarantined") {
        return { receipt_id, status: "quarantined", deduplicated: false, reason: storedReceipt.reason };
      }
      if (storedReceipt.fingerprint === fingerprint) {
        return { receipt_id, status: "recorded", deduplicated: true };
      }
      this._quarantineReceipt({
        receipt_id,
        slot_id,
        reason: "SAME_ID_DIFFERENT_CONTENT",
        received_fingerprint: fingerprint,
        stored_fingerprint: storedReceipt.fingerprint,
      });
      this._conflictReceipts.set(receipt_id, { receipt_id, slot_id, reason: "SAME_ID_DIFFERENT_CONTENT" });
      return { receipt_id, status: "quarantined", deduplicated: false, reason: "SAME_ID_DIFFERENT_CONTENT" };
    }

    // 新回执：执行业务校验
    const slot = this.state.slots.get(slot_id);
    if (!slot) throw new ValidationRejected("UNKNOWN_SLOT", `活动槽不存在：${slot_id}`);
    if (!["started", "resumed", "rerouted"].includes(slot.status)) {
      throw new ValidationRejected("ACTIVITY_NOT_STARTED", "活动尚未开始，不能记录实际领用", { status: slot.status });
    }
    for (const line of checkoutLines) {
      const reservation = this.state.reservations.get(line.reservation_id);
      const resource = this.state.resources.get(reservation.resource_id);
      // 隔离/维护中的资源禁止实际领用——即便旧预留仍在，也不能让其他组继续领出污染批次
      if (resource?.status === "quarantined") {
        throw new ValidationRejected("RESOURCE_QUARANTINED", "资源已隔离，禁止领用", {
          resource_id: reservation.resource_id,
        });
      }
      if (resource?.status === "maintenance") {
        throw new ValidationRejected("RESOURCE_IN_MAINTENANCE", "仪器处于清洁/复检维护中，禁止领用", {
          resource_id: reservation.resource_id,
        });
      }
      if (!["held", "partially_checked_out"].includes(reservation.status)) {
        throw new ValidationRejected("RESERVATION_NOT_HELD", `预留 ${line.reservation_id} 状态 ${reservation.status} 不可领用`);
      }
      const remaining = reservation.quantity - (reservation.checked_out_quantity ?? 0);
      if (line.quantity > remaining) {
        throw new ValidationRejected("CHECKOUT_QUANTITY_INVALID", "领用数量超过预留余量", {
          reservation_id: line.reservation_id,
          remaining,
          requested: line.quantity,
        });
      }
    }

    // 事件标识由回执标识派生：跨进程重放时底层存储也能识别同一回执
    const receiptDraft = this._draft(
      "CHECKOUT_RECORDED",
      "activity_slot",
      slot_id,
      `活动 ${slot_id} 实际领用回执 ${receipt_id}`,
      {
        event_id: `evt-receipt-${receipt_id}`,
        receipt_id,
        slot_id,
        lines: checkoutLines,
        fingerprint,
      }
    );

    try {
      this._commit([receiptDraft]);
    } catch (error) {
      if (error instanceof EventConflictError) {
        const existing = error.details.existing;
        if (existing?.fingerprint === fingerprint) {
          return { receipt_id, status: "recorded", deduplicated: true };
        }
        this._conflictReceipts.set(receipt_id, {
          receipt_id,
          slot_id,
          reason: "SAME_ID_DIFFERENT_CONTENT",
          received_fingerprint: fingerprint,
          stored_fingerprint: existing?.fingerprint ?? null,
        });
        this._quarantineReceipt({
          receipt_id,
          slot_id,
          reason: "SAME_ID_DIFFERENT_CONTENT",
          received_fingerprint: fingerprint,
          stored_fingerprint: existing?.fingerprint ?? null,
        });
        return { receipt_id, status: "quarantined", deduplicated: false, reason: "SAME_ID_DIFFERENT_CONTENT" };
      }
      throw error;
    }
    return { receipt_id, status: "recorded", deduplicated: false, lines: checkoutLines };
  }

  _receiptFingerprint(receiptId, slotId, lines) {
    return createHash("sha256")
      .update(JSON.stringify({ receipt_id: receiptId, slot_id: slotId, lines }))
      .digest("hex");
  }

  _quarantineReceipt({ receipt_id, slot_id, reason, received_fingerprint, stored_fingerprint }) {
    if (this.state.receipts.get(receipt_id)?.status === "quarantined") return;
    this._commit([
      this._draft("RECEIPT_QUARANTINED", "activity_slot", slot_id, `回执 ${receipt_id} 进入隔离：${reason}`, {
        event_id: `evt-receipt-quarantine-${receipt_id}`,
        receipt_id,
        slot_id,
        reason,
        received_fingerprint,
        stored_fingerprint,
      }),
    ]);
  }

  // ---------- 未使用预留原子释放给候补 ----------

  /**
   * 原子释放未使用预留。给 to_waitlist 时，释放与候补晋升在同一批次提交：
   * 要么候补拿到预留，要么都不发生，不存在“释放了但没人接住”的中间态。
   * 仅取“仍被持有、尚未实际领用”的数量；已领用部分不释放。
   */
  releaseUnused({ reservation_id, to_waitlist: toWaitlist = null, revision_id = null, event_id } = {}) {
    const reservation = this.state.reservations.get(reservation_id);
    if (!reservation) throw new ValidationRejected("UNKNOWN_RESERVATION", `预留不存在：${reservation_id}`);
    const remaining = this._heldRemaining(reservation);
    if (remaining <= 0) {
      throw new ValidationRejected("NOTHING_TO_RELEASE", "预留没有未使用的持有数量", {
        reservation_id,
        status: reservation.status,
      });
    }

    let chosen = null;
    const resource = this.state.resources.get(reservation.resource_id);
    if (toWaitlist) {
      if (resource?.status === "quarantined" || resource?.status === "maintenance") {
        throw new ValidationRejected("RESOURCE_UNAVAILABLE", "资源处于隔离/维护中，未用数量不得转移给候补", {
          resource_id: reservation.resource_id,
          status: resource.status,
        });
      }
      chosen = this._pickWaitlistEntry(reservation.resource_id, remaining, toWaitlist.now ?? this.now());
      if (!chosen) throw new ValidationRejected("NO_ELIGIBLE_WAITLIST", "没有可承接该释放数量的候补申请");
    }

    const drafts = [
      this._draft(
        "RESERVATION_RELEASED",
        "activity_slot",
        reservation.slot_id,
        `预留 ${reservation_id} 释放未使用数量 ${remaining}${chosen ? ` 给候补 ${chosen.request_id}` : ""}`,
        {
          event_id,
          reservation_id,
          resource_id: reservation.resource_id,
          quantity: remaining,
          to: chosen ? "waitlist" : "available",
          revision_id,
        }
      ),
    ];
    if (chosen) {
      drafts.push(
        this._draft(
          "WAITLIST_PROMOTED",
          "resource_unit",
          reservation.resource_id,
          `候补 ${chosen.request_id} 原子承接释放数量`,
          {
            event_id: event_id ? `${event_id}-promote` : undefined,
            request_id: chosen.request_id,
            slot_id: chosen.slot_id,
            group_id: chosen.group_id,
            resource_id: reservation.resource_id,
            revision_id,
            lines: [
              {
                reservation_id: `rsv-waitlist-${chosen.request_id}`,
                resource_id: reservation.resource_id,
                quantity: chosen.take,
              },
            ],
          }
        )
      );
    }
    this._commit(drafts);
    return {
      reservation_id,
      released: remaining,
      promoted: chosen
        ? { request_id: chosen.request_id, quantity: chosen.take, reservation_id: `rsv-waitlist-${chosen.request_id}` }
        : null,
    };
  }

  _heldRemaining(reservation) {
    if (!["held", "partially_checked_out"].includes(reservation.status)) return 0;
    return reservation.quantity - (reservation.checked_out_quantity ?? 0);
  }

  /** 按申请顺序挑选未过期、数量可满足的最早候补；take 为实际承接数量。 */
  _pickWaitlistEntry(resourceId, availableQuantity, nowIso) {
    const ids = this.state.waitlist.byResource.get(resourceId) ?? [];
    const nowMs = Date.parse(nowIso);
    let fallback = null; // 资源为仪器时允许“数量可拆分/降级”，但耗材按数量匹配
    for (const id of ids) {
      const entry = this.state.waitlist.entries.get(id);
      if (!entry || entry.status !== "waiting") continue;
      if (entry.expires_at && Date.parse(entry.expires_at) < nowMs) continue;
      if (entry.quantity <= availableQuantity) return { ...entry, take: entry.quantity };
      fallback ??= entry;
    }
    // 数量大于释放量的申请：仪器（按台计、capacity 语义）不晋升；耗材允许部分承接
    if (fallback) {
      const resource = this.state.resources.get(resourceId);
      if (resource?.consumable) return { ...fallback, take: availableQuantity };
    }
    return null;
  }

  // ---------- 学习证据 ----------

  acceptEvidence({ evidence_id, slot_id, group_id, kind, source_resource_id, source_ref, collected_at, event_id } = {}) {
    if (!evidence_id || !slot_id) throw new ValidationRejected("BAD_INPUT", "证据标识与活动槽必填");
    if (this.state.evidence.has(evidence_id)) throw new ValidationRejected("ALREADY_EXISTS", `证据已存在：${evidence_id}`);
    this._commit([
      this._draft("EVIDENCE_ACCEPTED", "learning_evidence", evidence_id, `采纳学习证据 ${evidence_id}`, {
        event_id,
        evidence_id,
        slot_id,
        group_id: group_id ?? this.state.slots.get(slot_id)?.group_id,
        kind,
        source_resource_id: source_resource_id ?? null,
        source_ref: source_ref ?? null,
        collected_at: collected_at ?? this.now(),
      }),
    ]);
    return evidence_id;
  }

  // ---------- 污染发现：沿接触链定位 + 只暂停未完成节点 ----------

  /**
   * 报告样品/器材污染或校准失效。
   * - 沿器材-样品接触链（传递闭包）定位全部受影响资源；
   * - 受影响耗材批次冻结剩余余量，受影响仪器进入隔离/维护；
   * - 仅暂停“尚未完成”的活动节点；已完成或已在暂停态的节点不重复暂停；
   * - 已采集证据默认保留（其来源被记录）；只有明确受污染来源影响的证据才失效。
   * 同一根因用 revision_id 汇聚成一次改线。
   */
  reportContamination({
    root_resource_id,
    kind = "contamination",
    observed_in_slot_id = null,
    invalidate_evidence: invalidateEvidenceIds = [],
    revision_id = null,
    event_id,
    cause,
  } = {}) {
    const root = this.state.resources.get(root_resource_id);
    if (!root) throw new ValidationRejected("UNKNOWN_RESOURCE", `根因资源不存在：${root_resource_id}`);

    const chain = traceContactChain(this.state, root_resource_id);
    const affectedResourceIds = [...chain.keys()];

    // 受影响活动：使用了任一受影响资源且未完成
    const affectedSlots = new Map();
    for (const reservation of this.state.reservations.values()) {
      if (!chain.has(reservation.resource_id)) continue;
      if (!["held", "partially_checked_out", "checked_out"].includes(reservation.status)) continue;
      const slot = this.state.slots.get(reservation.slot_id);
      if (!slot) continue;
      if (["completed", "cancelled"].includes(slot.status)) continue;
      if (!affectedSlots.has(slot.slot_id)) {
        affectedSlots.set(slot.slot_id, { resources: new Set() });
      }
      affectedSlots.get(slot.slot_id).resources.add(reservation.resource_id);
    }

    const revision = revision_id ?? `rev-${stable([root_resource_id, this.now()])}`;
    const drafts = [];

    drafts.push(
      this._draft("CONTAMINATION_REPORTED", "resource_unit", root_resource_id, `发现${kind === "calibration" ? "校准失效" : "污染"}：${root.name ?? root_resource_id}`, {
        event_id,
        root_resource_id,
        kind,
        observed_in_slot_id,
        affected_resource_ids: affectedResourceIds,
        affected_slot_ids: [...affectedSlots.keys()],
        contact_distances: Object.fromEntries([...chain.entries()].map(([id, d]) => [id, d])),
        revision_id: revision,
        cause: cause ?? null,
      })
    );

    for (const resourceId of affectedResourceIds) {
      const resource = this.state.resources.get(resourceId);
      // 仪器 → 清洁/复检维护单；耗材批次与样品 → 隔离（耗材同时冻结余量）
      const action = resource.kind === INSTRUMENT ? "maintenance" : "quarantine";
      let freeze = 0;
      if (resource.consumable) freeze = Math.max(0, balanceOf(this.state, resourceId).available);
      drafts.push(
        this._draft("CONTAMINATION_RECORDED", "resource_unit", resourceId, `资源 ${resourceId} 经接触链判定受影响，${action === "quarantine" ? "隔离并冻结余量" : "送修复检"}`, {
          event_id: event_id ? `${event_id}-res-${resourceId}` : undefined,
          root_resource_id,
          resource_id: resourceId,
          kind,
          action,
          freeze_quantity: freeze,
          revision_id: revision,
        })
      );
      if (action === "maintenance") {
        drafts.push(
          this._draft("MAINTENANCE_ORDERED", "resource_unit", resourceId, `仪器 ${resourceId} 因${kind === "calibration" ? "校准失效" : "污染链"}安排清洁/复检`, {
            event_id: event_id ? `${event_id}-mnt-${resourceId}` : undefined,
            resource_id: resourceId,
            reason: kind === "calibration" ? "CALIBRATION_INVALID" : "CONTACT_CHAIN_CONTAMINATION",
            revision_id: revision,
          })
        );
      }
    }

    // 仅暂停未完成节点
    const suspendedSlots = [];
    const alreadySuspendedSlots = [];
    const preservedSlots = [];
    for (const [slotId] of affectedSlots) {
      const slot = this.state.slots.get(slotId);
      if (slot.status === "suspended") {
        // 已被前次改线暂停：不重复暂停，也不属于本次“保留继续运行”的节点
        alreadySuspendedSlots.push(slotId);
        continue;
      }
      suspendedSlots.push(slotId);
      drafts.push(
        this._draft("SLOT_SUSPENDED", "activity_slot", slotId, `活动 ${slotId} 因污染链暂停（未完成节点）`, {
          event_id: event_id ? `${event_id}-sus-${slotId}` : undefined,
          slot_id: slotId,
          reason: kind === "calibration" ? "CALIBRATION_INVALID" : "CONTACT_CHAIN_CONTAMINATION",
          affected_resources: [...affectedSlots.get(slotId).resources],
          revision_id: revision,
        })
      );
    }

    // 证据：默认保留；显式声明受污染来源影响的证据失效，保留来源指针
    const invalidated = [];
    for (const evidenceId of invalidateEvidenceIds) {
      const evidence = this.state.evidence.get(evidenceId);
      if (!evidence || evidence.status !== "valid") continue;
      invalidated.push(evidenceId);
      drafts.push(
        this._draft("EVIDENCE_INVALIDATED", "learning_evidence", evidenceId, `证据 ${evidenceId} 因污染来源失效，保留来源指针`, {
          event_id: event_id ? `${event_id}-ev-${evidenceId}` : undefined,
          evidence_id: evidenceId,
          reason: "CONTAMINATED_SOURCE",
          source_resource_id: evidence.source_resource_id,
          source_ref: evidence.source_ref,
          revision_id: revision,
        })
      );
    }

    // 未受影响的同团组节点属于保留节点（已完成/正常进行/待开始均保留；
    // 已被其他改线暂停或已取消的节点不计为“保留继续运行”）
    const observedGroupId = this.state.slots.get(observed_in_slot_id ?? "")?.group_id;
    for (const slot of this.state.slots.values()) {
      if (slot.group_id === observedGroupId && !affectedSlots.has(slot.slot_id)) {
        if (["planned", "confirmed", "started", "resumed", "completed"].includes(slot.status)) {
          preservedSlots.push(slot.slot_id);
        }
      }
    }

    // 耗材余量变化快照（冻结导致的可领用余量下降）
    const consumableChanges = affectedResourceIds
      .filter((id) => this.state.resources.get(id)?.consumable)
      .map((id) => {
        const balance = balanceOf(this.state, id);
        return {
          resource_id: id,
          frozen: Math.max(0, balance.available),
          available_before: balance.available,
          available_after: 0,
          reason: "QUARANTINE_FREEZE",
        };
      });

    const revisionGroupId = this._revisionGroup(observed_in_slot_id, suspendedSlots);
    drafts.push(
      this._draft("ITINERARY_REVISED", "student_group", revisionGroupId, `改线 ${revision}：暂停 ${suspendedSlots.length} 个未完成节点，保留 ${new Set(preservedSlots).size} 个节点`, {
        event_id: event_id ? `${event_id}-rev` : undefined,
        revision_id: revision,
        group_id: revisionGroupId,
        trigger: kind === "calibration" ? "CALIBRATION_INVALID" : "CONTAMINATION",
        root_resource_id,
        status: "open",
        cause: cause ?? null,
        preserved_slots: [...new Set(preservedSlots)],
        suspended_slots: suspendedSlots,
        resumed_slots: [],
        replacement_links: [],
        invalidated_evidence: invalidated,
        consumable_changes: consumableChanges,
      })
    );

    this._commit(drafts);
    return {
      revision_id: revision,
      affected_resource_ids: affectedResourceIds,
      contact_distances: Object.fromEntries(chain.entries()),
      suspended_slots: suspendedSlots,
      already_suspended_slots: alreadySuspendedSlots,
      preserved_slots: [...new Set(preservedSlots)],
      invalidated_evidence: invalidated,
      consumable_changes: consumableChanges,
    };
  }

  _revisionGroup(observedInSlotId, suspendedSlots) {
    if (observedInSlotId && this.state.slots.get(observedInSlotId)) {
      return this.state.slots.get(observedInSlotId).group_id;
    }
    for (const slotId of suspendedSlots) {
      const slot = this.state.slots.get(slotId);
      if (slot) return slot.group_id;
    }
    return "unknown-group";
  }

  // ---------- 清洁 / 复检 ----------

  /** 完成清洁或校准复检；通过则资源解除隔离，可继续安排替代/恢复。 */
  completeMaintenance({ resource_id, reinspection_passed, calibrated_until, event_id } = {}) {
    const maintenance = this.state.maintenance.get(resource_id);
    if (!maintenance || maintenance.status !== "open") {
      throw new ValidationRejected("NO_OPEN_MAINTENANCE", `资源 ${resource_id} 没有进行中的维护/复检单`);
    }
    if (!reinspection_passed) {
      // 复检未通过：保持维护状态，等待替代路线或再次清洁（仍记录事件以便追溯）
    }
    this._commit([
      this._draft("MAINTENANCE_COMPLETED", "resource_unit", resource_id, `资源 ${resource_id} 清洁/复检${reinspection_passed ? "通过" : "未通过"}`, {
        event_id,
        resource_id,
        reinspection_passed,
        calibrated_until: reinspection_passed ? calibrated_until ?? null : null,
      }),
    ]);
    return { resource_id, reinspection_passed };
  }

  // ---------- 替代路线：说明目标等价关系 ----------

  /**
   * 为暂停的活动安排替代路线。
   * @param {object} params
   * @param {"cleaning"|"reinspection"|"substitution"} params.route
   *   cleaning：原资源清洁后复用；reinspection：校准复检后复用；substitution：换用替代资源
   * @param {Array<{from_reservation_id:string, to_resource_id:string, quantity:number, reservation_id?:string}>} params.replacements
   * @param {object} params.objective_equivalence 必须说明替代活动与原活动的目标等价关系
   */
  rerouteSlot({
    slot_id,
    route,
    replacements = [],
    objective_equivalence,
    revision_id = null,
    resume = false,
    event_id,
  } = {}) {
    const slot = this.state.slots.get(slot_id);
    if (!slot) throw new ValidationRejected("UNKNOWN_SLOT", `活动槽不存在：${slot_id}`);
    if (!["suspended", "rerouted"].includes(slot.status) && !resume) {
      throw new ValidationRejected("SLOT_NOT_SUSPENDED", `活动槽状态 ${slot.status} 不可改线`);
    }
    if (!["cleaning", "reinspection", "substitution"].includes(route)) {
      throw new ValidationRejected("BAD_ROUTE", "route 必须是 cleaning/reinspection/substitution");
    }
    if (!objective_equivalence || !objective_equivalence.objective || !objective_equivalence.equivalence_basis) {
      throw new ValidationRejected("EQUIVALENCE_REQUIRED", "替代活动必须说明目标等价关系（objective + equivalence_basis）");
    }

    const revision = revision_id ?? slot.revision_id ?? `rev-${stable(["reroute", slot_id, this.now()])}`;
    const drafts = [];
    const releaseIds = [];
    const allocationLines = [];
    const replacementLinks = [];

    for (const replacement of replacements) {
      const old = this.state.reservations.get(replacement.from_reservation_id);
      if (!old) throw new ValidationRejected("UNKNOWN_RESERVATION", `原预留不存在：${replacement.from_reservation_id}`);
      const target = this.state.resources.get(replacement.to_resource_id);
      if (!target) throw new ValidationRejected("UNKNOWN_RESOURCE", `替代资源不存在：${replacement.to_resource_id}`);

      if (target.consumable) {
        const balance = balanceOf(this.state, replacement.to_resource_id);
        if (balance.available < replacement.quantity) {
          throw new ValidationRejected("INSUFFICIENT_STOCK", "替代耗材余量不足", { resource_id: replacement.to_resource_id });
        }
      } else {
        if (target.status !== "available") {
          throw new ValidationRejected("RESOURCE_UNAVAILABLE", `替代仪器状态 ${target.status}，不可用`);
        }
        if (!this._calibrationValid(target, slot.scheduled_start)) {
          throw new ValidationRejected("CALIBRATION_EXPIRED", "替代仪器校准无效");
        }
        if (occupancyOf(this.state, replacement.to_resource_id) + replacement.quantity > (target.capacity ?? 1)) {
          throw new ValidationRejected("CAPACITY_FULL", "替代仪器容量不足");
        }
      }

      const remaining = this._heldRemaining(old);
      if (remaining > 0) releaseIds.push({ reservation: old, quantity: remaining });
      const newReservationId = replacement.reservation_id ?? `rsv-sub-${slot_id}-${replacement.to_resource_id}-${stable([replacement.from_reservation_id])}`;
      allocationLines.push({
        reservation_id: newReservationId,
        resource_id: replacement.to_resource_id,
        quantity: replacement.quantity,
      });
      replacementLinks.push({
        from_reservation_id: old.reservation_id,
        to_reservation_id: newReservationId,
        from_resource_id: old.resource_id,
        to_resource_id: replacement.to_resource_id,
      });
    }

    for (const item of releaseIds) {
      drafts.push(
        this._draft("RESERVATION_RELEASED", "activity_slot", slot_id, `改线释放原预留 ${item.reservation.reservation_id}`, {
          event_id: event_id ? `${event_id}-rel-${item.reservation.reservation_id}` : undefined,
          reservation_id: item.reservation.reservation_id,
          resource_id: item.reservation.resource_id,
          quantity: item.quantity,
          to: "substitution",
          revision_id: revision,
        })
      );
    }
    if (allocationLines.length) {
      drafts.push(
        this._draft("RESOURCE_ALLOCATED", "activity_slot", slot_id, `改线为活动 ${slot_id} 锁定替代资源`, {
          event_id: event_id ? `${event_id}-alloc` : undefined,
          slot_id,
          group_id: slot.group_id,
          source: "substitution",
          revision_id: revision,
          lines: allocationLines,
        })
      );
    }
    drafts.push(
      this._draft("SLOT_REROUTED", "activity_slot", slot_id, `活动 ${slot_id} 采用${route}路线，目标等价关系已记录`, {
        event_id: event_id ? `${event_id}-route` : undefined,
        slot_id,
        route,
        replaced: replacementLinks,
        objective_equivalence,
        revision_id: revision,
      })
    );
    if (resume) {
      drafts.push(
        this._draft("ACTIVITY_RESUMED", "activity_slot", slot_id, `活动 ${slot_id} 沿替代路线恢复`, {
          event_id: event_id ? `${event_id}-resume` : undefined,
          slot_id,
          revision_id: revision,
        })
      );
    }

    this._commit(drafts);

    // 在改线台账上补充替代链接（后继事件，不改写原 ITINERARY_REVISED）
    this._appendRevisionLinks(revision, slot_id, replacementLinks, route, resume);

    return {
      slot_id,
      revision_id: revision,
      route,
      replacement_links: replacementLinks,
      resumed: Boolean(resume),
    };
  }

  _appendRevisionLinks(revisionId, slotId, links, route, resumed = false) {
    const revision = this.state.revisions.get(revisionId);
    if (!revision) return;
    const groupId = revision.group_id;
    const resumedSet = new Set(revision.resumed_slots);
    if (resumed) resumedSet.add(slotId);
    const nextLinks = links.length ? [...revision.replacement_links, ...links] : revision.replacement_links;
    this._commit([
      this._draft("ITINERARY_REVISED", "student_group", groupId, `改线 ${revisionId} 追加替代链接`, {
        revision_id: revisionId,
        group_id: groupId,
        trigger: revision.trigger,
        root_resource_id: revision.root_resource_id,
        status: "open",
        cause: revision.cause,
        preserved_slots: revision.preserved_slots,
        suspended_slots: revision.suspended_slots,
        resumed_slots: [...resumedSet],
        replacement_links: nextLinks,
        invalidated_evidence: revision.invalidated_evidence,
        consumable_changes: revision.consumable_changes,
      }),
    ]);
  }

  resumeActivity({ slot_id, revision_id = null, event_id } = {}) {
    const slot = this.state.slots.get(slot_id);
    if (!slot) throw new ValidationRejected("UNKNOWN_SLOT", `活动槽不存在：${slot_id}`);
    if (!["suspended", "rerouted"].includes(slot.status)) {
      throw new ValidationRejected("SLOT_NOT_RESUMABLE", `活动槽状态 ${slot.status} 不可恢复`);
    }
    this._commit([
      this._draft("ACTIVITY_RESUMED", "activity_slot", slot_id, `活动 ${slot_id} 恢复`, {
        event_id,
        slot_id,
        revision_id: revision_id ?? slot.revision_id,
      }),
    ]);
    return { slot_id };
  }

  completeActivity({ slot_id, event_id } = {}) {
    const slot = this.state.slots.get(slot_id);
    if (!slot) throw new ValidationRejected("UNKNOWN_SLOT", `活动槽不存在：${slot_id}`);
    if (slot.status === "completed") return { slot_id, deduplicated: true };
    if (!["started", "resumed", "rerouted"].includes(slot.status)) {
      throw new ValidationRejected("SLOT_NOT_ACTIVE", `活动槽状态 ${slot.status} 不可完成`);
    }
    this._commit([
      this._draft("ACTIVITY_COMPLETED", "activity_slot", slot_id, `活动 ${slot_id} 完成`, { event_id, slot_id }),
    ]);
    return { slot_id, deduplicated: false };
  }

  /**
   * 关闭一次改线单：其下暂停的节点必须全部已恢复/完成。关闭后领队视图显示闭环时间；
   * 若仍有节点停留在 suspended，拒绝关闭（避免“改了线但节点挂起”被误报为已恢复）。
   */
  closeRevision({ revision_id, event_id } = {}) {
    const revision = this.state.revisions.get(revision_id);
    if (!revision) throw new ValidationRejected("UNKNOWN_REVISION", `改线单不存在：${revision_id}`);
    const pending = revision.suspended_slots.filter((slotId) => {
      const slot = this.state.slots.get(slotId);
      return slot && !["resumed", "completed", "rerouted"].includes(slot.status);
    });
    if (pending.length) {
      throw new ValidationRejected("REVISION_HAS_OPEN_SLOTS", "仍有暂停节点未恢复，不能关闭改线单", { pending });
    }
    // 刷新耗材变化为当前余量视角（冻结/可领用的最终去向）
    const consumableChanges = revision.consumable_changes.map((change) => {
      const balance = balanceOf(this.state, change.resource_id);
      return {
        ...change,
        current_frozen: balance.frozen,
        current_available: balance.available,
      };
    });
    this._commit([
      this._draft("ITINERARY_REVISED", "student_group", revision.group_id, `改线 ${revision_id} 闭环：暂停节点全部恢复`, {
        event_id,
        revision_id,
        group_id: revision.group_id,
        trigger: revision.trigger,
        root_resource_id: revision.root_resource_id,
        status: "closed",
        closed_at: this.now(),
        cause: revision.cause,
        preserved_slots: revision.preserved_slots,
        suspended_slots: revision.suspended_slots,
        resumed_slots: [...new Set(revision.resumed_slots)],
        replacement_links: revision.replacement_links,
        invalidated_evidence: revision.invalidated_evidence,
        consumable_changes: consumableChanges,
      }),
    ]);
    return { revision_id, status: "closed" };
  }

  // ---------- 服务恢复：按原截止点继续候补与复检 ----------

  /**
   * 服务恢复后重放：对每个未完成候补，按其原 expires_at 截止点判定——
   * 已过截止点 → WAITLIST_EXPIRED；仍有效则保留 waiting，可继续等待释放。
   * 同时返回仍待复检的资源清单，供主管继续复检流程。
   */
  recover({ recovery_id = null, now: nowIso = null, event_id } = {}) {
    const now = nowIso ?? this.now();
    const nowMs = Date.parse(now);
    const expired = [];
    const drafts = [];
    for (const entry of this.state.waitlist.entries.values()) {
      if (entry.status !== "waiting") continue;
      if (entry.expires_at && Date.parse(entry.expires_at) < nowMs) {
        expired.push(entry.request_id);
        drafts.push(
          this._draft("WAITLIST_EXPIRED", "resource_unit", entry.resource_id, `候补 ${entry.request_id} 已过原截止点 ${entry.expires_at}`, {
            event_id: event_id ? `${event_id}-exp-${entry.request_id}` : undefined,
            request_id: entry.request_id,
            resource_id: entry.resource_id,
            expires_at: entry.expires_at,
          })
        );
      }
    }
    const pendingReinspection = [...this.state.maintenance.values()]
      .filter((m) => m.status === "open")
      .map((m) => ({ resource_id: m.resource_id, reason: m.reason, revision_id: m.revision_id }));

    const recoveryId = recovery_id ?? `rec-${stable([now, String(this.store.size)])}`;
    drafts.push(
      this._draft("RECOVERY_COMPLETED", "student_group", "service-recovery", `服务恢复重放：过期候补 ${expired.length} 条，待复检 ${pendingReinspection.length} 项`, {
        event_id,
        recovery_id: recoveryId,
        recovered_from_event: this.store.size,
        now,
        expired,
        promoted: [],
        pending_reinspection: pendingReinspection,
      })
    );
    this._commit(drafts);
    return { recovery_id: recoveryId, expired, pending_reinspection: pendingReinspection };
  }

  /** 活动结束后批量释放所有未使用预留（不指定候补时回到可领用余量）。 */
  releaseAllUnusedForSlot({ slot_id, to_waitlist = false, event_id } = {}) {
    const results = [];
    for (const reservation of [...this.state.reservations.values()]) {
      if (reservation.slot_id !== slot_id) continue;
      if (this._heldRemaining(reservation) <= 0) continue;
      results.push(
        this.releaseUnused({
          reservation_id: reservation.reservation_id,
          to_waitlist: to_waitlist ? {} : null,
          event_id: event_id ? `${event_id}-${reservation.reservation_id}` : undefined,
        })
      );
    }
    return results;
  }

  // ---------- 查询 ----------

  get state() {
    return this._state;
  }

  set state(value) {
    this._state = value;
  }

  snapshot() {
    return this._state;
  }

  revision(revisionId) {
    return this._state.revisions.get(revisionId) ?? null;
  }
}
