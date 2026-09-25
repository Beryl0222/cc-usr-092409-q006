/**
 * 只读投影：把 append-only 事件日志折叠为当前状态。
 * 服务重启后对完整日志重跑 foldEvent 即可恢复全部状态，不依赖任何外部数据库。
 */

export function initialState() {
  return {
    resources: new Map(),
    contacts: new Map(), // resource_id -> Set(resource_id)，无向接触图
    mentors: new Map(),
    groups: new Map(),
    slots: new Map(),
    reservations: new Map(),
    waitlist: {
      seq: 0,
      entries: new Map(),
      byResource: new Map(), // resource_id -> [request_id]（按申请顺序）
    },
    evidence: new Map(),
    maintenance: new Map(),
    revisions: new Map(),
    receipts: new Map(), // receipt_id -> {status, fingerprint, slot_id}
    ledger: new Map(), // resource_id -> [entry]
    recoveries: [],
  };
}

function ledger(state, resourceId) {
  if (!state.ledger.has(resourceId)) state.ledger.set(resourceId, []);
  return state.ledger.get(resourceId);
}

function postLedger(state, event, deltas, reason, extra = {}) {
  for (const [resourceId, delta] of Object.entries(deltas)) {
    if (!delta.held && !delta.checked_out && !delta.frozen) continue;
    ledger(state, resourceId).push({
      resource_id: resourceId,
      held: delta.held ?? 0,
      checked_out: delta.checked_out ?? 0,
      frozen: delta.frozen ?? 0,
      reason,
      revision_id: event.revision_id ?? null,
      at: event.occurred_at,
      event_id: event.event_id,
      ...extra,
    });
  }
}

function touchContact(state, a, b) {
  if (!state.contacts.has(a)) state.contacts.set(a, new Set());
  if (!state.contacts.has(b)) state.contacts.set(b, new Set());
  state.contacts.get(a).add(b);
  state.contacts.get(b).add(a);
}

/** 沿器材-样品接触链求传递闭包，返回 Map(resource_id -> 距离)。 */
export function traceContactChain(state, rootId) {
  const reached = new Map();
  if (!state.resources.has(rootId)) return reached;
  reached.set(rootId, 0);
  const queue = [rootId];
  while (queue.length) {
    const current = queue.shift();
    for (const next of state.contacts.get(current) ?? []) {
      if (!reached.has(next)) {
        reached.set(next, reached.get(current) + 1);
        queue.push(next);
      }
    }
  }
  return reached;
}

function reservationLines(event) {
  return (event.lines ?? []).map((line) => ({
    reservation_id: line.reservation_id,
    resource_id: line.resource_id,
    quantity: line.quantity,
  }));
}

export function foldEvent(state, event) {
  const p = event;
  switch (p.event_type) {
    case "RESOURCE_REGISTERED": {
      state.resources.set(p.resource_id, {
        resource_id: p.resource_id,
        kind: p.kind, // instrument | consumable_lot
        consumable: p.kind === "consumable_lot",
        name: p.name,
        unit: p.unit ?? (p.kind === "consumable_lot" ? "份" : "台"),
        capacity: p.capacity ?? null,
        initial_quantity: p.initial_quantity ?? null,
        calibrated_until: p.calibrated_until ?? null,
        status: "available",
        contamination: null,
      });
      break;
    }

    case "CONTACT_LINKED": {
      touchContact(state, p.source_resource_id, p.target_resource_id);
      break;
    }

    case "MENTOR_REGISTERED": {
      const certs = new Map();
      for (const c of p.certifications ?? []) certs.set(c.cert_id, c.valid_until);
      state.mentors.set(p.mentor_id, { mentor_id: p.mentor_id, name: p.name, certifications: certs });
      break;
    }

    case "GROUP_REGISTERED": {
      state.groups.set(p.group_id, {
        group_id: p.group_id,
        name: p.name,
        size: p.size,
        risk_group: p.risk_group ?? null,
        risk_clearance: p.risk_clearance ?? null,
        status: "registered",
        mentor_id: null,
        headcount: null,
        confirmed_at: null,
      });
      break;
    }

    case "SLOT_PLANNED": {
      state.slots.set(p.slot_id, {
        slot_id: p.slot_id,
        group_id: p.group_id,
        title: p.title,
        venue: p.venue ?? null,
        scheduled_start: p.scheduled_start,
        risk_level: p.risk_level ?? 1,
        required_certifications: p.required_certifications ?? [],
        requirements: p.requirements ?? [],
        status: "planned",
        revision_id: null,
        suspended_reason: null,
        routes: [],
      });
      break;
    }

    case "GROUP_CONFIRMED": {
      const group = state.groups.get(p.group_id);
      if (group) {
        group.status = "confirmed";
        group.mentor_id = p.mentor_id;
        group.headcount = p.headcount;
        group.confirmed_at = p.occurred_at;
        group.locked_checks = p.locked;
      }
      break;
    }

    case "RESOURCE_ALLOCATED": {
      const slot = state.slots.get(p.slot_id);
      if (slot && slot.status === "planned") slot.status = "confirmed";
      for (const line of reservationLines(p)) {
        state.reservations.set(line.reservation_id, {
          reservation_id: line.reservation_id,
          slot_id: p.slot_id,
          group_id: p.group_id,
          resource_id: line.resource_id,
          quantity: line.quantity,
          status: "held",
          source: p.source ?? "confirmation", // confirmation | substitution | waitlist
          revision_id: p.revision_id ?? null,
        });
        postLedger(state, p, { [line.resource_id]: { held: line.quantity } }, "RESERVATION_HOLD");
      }
      break;
    }

    case "WAITLIST_REQUESTED": {
      const id = p.request_id;
      state.waitlist.entries.set(id, {
        request_id: id,
        group_id: p.group_id,
        slot_id: p.slot_id,
        resource_id: p.resource_id,
        quantity: p.quantity,
        expires_at: p.expires_at,
        status: "waiting",
        seq: state.waitlist.seq++,
      });
      const list = state.waitlist.byResource.get(p.resource_id) ?? [];
      list.push(id);
      state.waitlist.byResource.set(p.resource_id, list);
      break;
    }

    case "WAITLIST_EXPIRED": {
      const entry = state.waitlist.entries.get(p.request_id);
      if (entry) entry.status = "expired";
      break;
    }

    case "WAITLIST_PROMOTED": {
      const entry = state.waitlist.entries.get(p.request_id);
      if (entry) entry.status = "promoted";
      for (const line of reservationLines(p)) {
        state.reservations.set(line.reservation_id, {
          reservation_id: line.reservation_id,
          slot_id: entry?.slot_id ?? p.slot_id,
          group_id: entry?.group_id ?? p.group_id,
          resource_id: line.resource_id,
          quantity: line.quantity,
          status: "held",
          source: "waitlist",
          revision_id: p.revision_id ?? null,
        });
        postLedger(state, p, { [line.resource_id]: { held: line.quantity } }, "WAITLIST_PROMOTION");
      }
      break;
    }

    case "ACTIVITY_STARTED": {
      const slot = state.slots.get(p.slot_id);
      if (slot) slot.status = "started";
      break;
    }

    case "CHECKOUT_RECORDED": {
      state.receipts.set(p.receipt_id, {
        status: "recorded",
        slot_id: p.slot_id,
        fingerprint: p.fingerprint,
      });
      for (const line of p.lines ?? []) {
        const reservation = state.reservations.get(line.reservation_id);
        if (reservation) {
          reservation.checked_out_quantity = (reservation.checked_out_quantity ?? 0) + line.quantity;
          const remaining = reservation.quantity - reservation.checked_out_quantity;
          reservation.status = remaining > 0 ? "partially_checked_out" : "checked_out";
        }
        postLedger(
          state,
          p,
          { [line.resource_id]: { held: -line.quantity, checked_out: line.quantity } },
          "ACTUAL_CHECKOUT",
          { reservation_id: line.reservation_id, receipt_id: p.receipt_id }
        );
      }
      break;
    }

    case "RECEIPT_QUARANTINED": {
      state.receipts.set(p.receipt_id, {
        status: "quarantined",
        slot_id: p.slot_id,
        reason: p.reason,
        received_fingerprint: p.received_fingerprint,
        stored_fingerprint: p.stored_fingerprint,
      });
      break;
    }

    case "RESERVATION_RELEASED": {
      const reservation = state.reservations.get(p.reservation_id);
      const heldRemaining = reservation
        ? reservation.quantity - (reservation.checked_out_quantity ?? 0)
        : 0;
      if (reservation && heldRemaining > 0 && reservation.status !== "released") {
        const released = Math.min(p.quantity, heldRemaining);
        if (released >= heldRemaining) reservation.status = p.to === "waitlist" ? "promoted_away" : "released";
        const resource = state.resources.get(p.resource_id);
        const reason =
          p.to === "waitlist"
            ? "RELEASE_TO_WAITLIST"
            : p.to === "substitution"
              ? "SUBSTITUTION_RELEASE"
              : "UNUSED_RELEASE";
        postLedger(state, p, { [p.resource_id]: { held: -released } }, reason);
        // 资源已隔离时（如污染批次），释放出的未用数量不得回到可领用余量，立即冻结，
        // 也不能被候补承接（命令层在选择候补前已拒绝该路径）。
        if (resource?.status === "quarantined" && p.to !== "waitlist") {
          postLedger(
            state,
            p,
            { [p.resource_id]: { frozen: released } },
            "QUARANTINE_FREEZE_ON_RELEASE",
            { root_resource_id: resource.contamination?.root ?? null }
          );
        }
      }
      break;
    }

    case "CONTAMINATION_REPORTED": {
      // 触发事件，闭包明细在 CONTAMINATION_RECORDED / SLOT_SUSPENDED 中展开。
      break;
    }

    case "CONTAMINATION_RECORDED": {
      const resource = state.resources.get(p.resource_id);
      if (resource) {
        resource.contamination = { root: p.root_resource_id, kind: p.kind, since: p.occurred_at };
        if (p.action === "quarantine") resource.status = "quarantined";
        else if (p.action === "maintenance") resource.status = "maintenance";
      }
      if (p.freeze_quantity > 0) {
        postLedger(
          state,
          p,
          { [p.resource_id]: { frozen: p.freeze_quantity } },
          "QUARANTINE_FREEZE",
          { root_resource_id: p.root_resource_id }
        );
      }
      break;
    }

    case "SLOT_SUSPENDED": {
      const slot = state.slots.get(p.slot_id);
      if (slot) {
        slot.status = "suspended";
        slot.revision_id = p.revision_id;
        slot.suspended_reason = p.reason;
      }
      break;
    }

    case "EVIDENCE_ACCEPTED": {
      state.evidence.set(p.evidence_id, {
        evidence_id: p.evidence_id,
        slot_id: p.slot_id,
        group_id: p.group_id,
        source_resource_id: p.source_resource_id ?? null,
        source_ref: p.source_ref ?? null,
        kind: p.kind,
        collected_at: p.collected_at,
        status: "valid",
        invalidated_reason: null,
        revision_id: null,
      });
      break;
    }

    case "EVIDENCE_INVALIDATED": {
      const evidence = state.evidence.get(p.evidence_id);
      if (evidence) {
        evidence.status = "invalidated";
        evidence.invalidated_reason = p.reason;
        evidence.revision_id = p.revision_id;
      }
      break;
    }

    case "MAINTENANCE_ORDERED": {
      state.maintenance.set(p.resource_id, {
        resource_id: p.resource_id,
        reason: p.reason,
        revision_id: p.revision_id ?? null,
        ordered_at: p.occurred_at,
        status: "open",
        completed_at: null,
        reinspection_passed: null,
      });
      const resource = state.resources.get(p.resource_id);
      if (resource && resource.status !== "quarantined") resource.status = "maintenance";
      break;
    }

    case "MAINTENANCE_COMPLETED": {
      const maintenance = state.maintenance.get(p.resource_id);
      if (maintenance) {
        // 复检未通过时维护单保持 open，记录最近一次结果，等待再次清洁/复检或替代路线
        maintenance.last_attempt_at = p.occurred_at;
        maintenance.last_passed = p.reinspection_passed;
        if (p.reinspection_passed) {
          maintenance.status = "closed";
          maintenance.completed_at = p.occurred_at;
          maintenance.reinspection_passed = true;
        }
      }
      const resource = state.resources.get(p.resource_id);
      if (resource && p.reinspection_passed) {
        resource.status = "available";
        if (p.calibrated_until) resource.calibrated_until = p.calibrated_until;
        resource.contamination = null;
      }
      break;
    }

    case "SLOT_REROUTED": {
      const slot = state.slots.get(p.slot_id);
      if (slot) {
        slot.routes.push({
          revision_id: p.revision_id,
          route: p.route,
          replaced: p.replaced ?? [],
          equivalence: p.objective_equivalence ?? null,
          at: p.occurred_at,
        });
        slot.revision_id = p.revision_id;
        if (p.route === "substitution") slot.status = "rerouted";
      }
      break;
    }

    case "ACTIVITY_RESUMED": {
      const slot = state.slots.get(p.slot_id);
      if (slot) slot.status = "resumed";
      break;
    }

    case "ACTIVITY_COMPLETED": {
      const slot = state.slots.get(p.slot_id);
      if (slot) slot.status = "completed";
      break;
    }

    case "ITINERARY_REVISED": {
      // 同一 revision_id 的后继事件用于追加替代链接/更新状态，采用合并而非覆盖，
      // 保留首次开账时间与既有明细（事件本身仍完整保存在日志中，不原地改写）。
      const prior = state.revisions.get(p.revision_id);
      const merged = {
        revision_id: p.revision_id,
        group_id: p.group_id,
        trigger: p.trigger,
        root_resource_id: p.root_resource_id,
        status: p.status,
        opened_at: prior?.opened_at ?? p.occurred_at,
        updated_at: p.occurred_at,
        closed_at: p.closed_at ?? prior?.closed_at ?? null,
        cause: p.cause ?? prior?.cause ?? null,
        preserved_slots: p.preserved_slots ?? prior?.preserved_slots ?? [],
        suspended_slots: p.suspended_slots ?? prior?.suspended_slots ?? [],
        resumed_slots: p.resumed_slots ?? prior?.resumed_slots ?? [],
        replacement_links: p.replacement_links ?? prior?.replacement_links ?? [],
        invalidated_evidence: p.invalidated_evidence ?? prior?.invalidated_evidence ?? [],
        consumable_changes: p.consumable_changes ?? prior?.consumable_changes ?? [],
        event_ids: [...(prior?.event_ids ?? []), p.event_id],
      };
      state.revisions.set(p.revision_id, merged);
      break;
    }

    case "RECOVERY_COMPLETED": {
      state.recoveries.push({
        recovery_id: p.recovery_id,
        at: p.occurred_at,
        recovered_from_event: p.recovered_from_event,
        expired: p.expired ?? [],
        promoted: p.promoted ?? [],
        pending_reinspection: p.pending_reinspection ?? [],
      });
      break;
    }

    default:
      break;
  }
  return state;
}

export function fold(events) {
  return events.reduce((state, event) => foldEvent(state, event), initialState());
}

/** 耗材台账汇总。available 为当前可领用余量。 */
export function balanceOf(state, resourceId) {
  const resource = state.resources.get(resourceId);
  const entries = state.ledger.get(resourceId) ?? [];
  let held = 0;
  let checked_out = 0;
  let frozen = 0;
  for (const e of entries) {
    held += e.held;
    checked_out += e.checked_out;
    frozen += e.frozen;
  }
  const initial = resource?.initial_quantity ?? 0;
  return {
    resource_id: resourceId,
    initial,
    held,
    checked_out,
    frozen,
    available: initial - held - checked_out - frozen,
    entries,
  };
}

/** 仪器占用：当前有效预留（活动未完成、未释放）占用的数量。 */
export function occupancyOf(state, resourceId) {
  let used = 0;
  for (const r of state.reservations.values()) {
    if (r.resource_id !== resourceId) continue;
    if (!["held", "partially_checked_out", "checked_out"].includes(r.status)) continue;
    const slot = state.slots.get(r.slot_id);
    if (slot && (slot.status === "completed" || slot.status === "cancelled")) continue;
    used += r.quantity;
  }
  return used;
}
