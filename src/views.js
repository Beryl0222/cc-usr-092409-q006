import { balanceOf, traceContactChain } from "./projection.js";

/**
 * 领队只读视图。所有结论均由事件投影推导，不保存额外可变状态。
 */

/** 单个资源余量及“为何变化”的台账（含改线归因）。 */
export function resourceBalanceView(service, resourceId) {
  const state = service.snapshot();
  const resource = state.resources.get(resourceId);
  const balance = balanceOf(state, resourceId);
  return {
    resource_id: resourceId,
    name: resource?.name ?? null,
    kind: resource?.kind ?? null,
    status: resource?.status ?? null,
    initial_quantity: balance.initial,
    held: balance.held,
    checked_out: balance.checked_out,
    frozen: balance.frozen,
    available: balance.available,
    movements: balance.entries.map((e) => ({
      at: e.at,
      reason: e.reason,
      held_delta: e.held,
      checked_out_delta: e.checked_out,
      frozen_delta: e.frozen,
      revision_id: e.revision_id,
      event_id: e.event_id,
    })),
  };
}

/**
 * 一次改线的完整说明：保留了哪些节点、暂停/恢复了哪些节点、
 * 替代关系与目标等价说明、哪些证据失效、耗材余量为何变化。
 */
export function revisionView(service, revisionId) {
  const state = service.snapshot();
  const revision = state.revisions.get(revisionId);
  if (!revision) return null;

  const routesBySlot = new Map();
  for (const slot of state.slots.values()) {
    for (const route of slot.routes ?? []) {
      if (route.revision_id === revisionId) {
        if (!routesBySlot.has(slot.slot_id)) routesBySlot.set(slot.slot_id, []);
        routesBySlot.get(slot.slot_id).push(route);
      }
    }
  }

  const slotInfo = (slotId) => {
    const slot = state.slots.get(slotId);
    return slot
      ? {
          slot_id: slotId,
          title: slot.title,
          status: slot.status,
          venue: slot.venue,
          routes: (routesBySlot.get(slotId) ?? []).map((r) => ({
            route: r.route,
            equivalence: r.equivalence,
            replaced: r.replaced,
            at: r.at,
          })),
        }
      : { slot_id: slotId, status: "unknown" };
  };

  const invalidatedEvidence = revision.invalidated_evidence.map((evidenceId) => {
    const evidence = state.evidence.get(evidenceId);
    return {
      evidence_id: evidenceId,
      slot_id: evidence?.slot_id ?? null,
      kind: evidence?.kind ?? null,
      reason: evidence?.invalidated_reason ?? "CONTAMINATED_SOURCE",
      // 失效证据仍保留来源，便于审计与补采
      source_resource_id: evidence?.source_resource_id ?? null,
      source_ref: evidence?.source_ref ?? null,
      collected_at: evidence?.collected_at ?? null,
    };
  });

  // 同一团组下未受改线影响且仍然有效的证据/节点，明确列为“保留证据”
  const retainedEvidence = [...state.evidence.values()]
    .filter(
      (e) =>
        e.group_id === revision.group_id &&
        e.status === "valid" &&
        !revision.invalidated_evidence.includes(e.evidence_id)
    )
    .map((e) => ({
      evidence_id: e.evidence_id,
      slot_id: e.slot_id,
      kind: e.kind,
      source_resource_id: e.source_resource_id,
      source_ref: e.source_ref,
    }));

  const consumableChanges = revision.consumable_changes.map((change) => {
    const current = balanceOf(state, change.resource_id);
    return {
      resource_id: change.resource_id,
      name: state.resources.get(change.resource_id)?.name ?? null,
      reason: change.reason,
      frozen_at_revision: change.frozen,
      available_before: change.available_before,
      available_after: change.available_after,
      current_available: current.available,
      current_frozen: current.frozen,
    };
  });

  return {
    revision_id: revisionId,
    status: revision.status,
    trigger: revision.trigger,
    root_resource_id: revision.root_resource_id,
    cause: revision.cause,
    opened_at: revision.opened_at,
    closed_at: revision.closed_at,
    preserved_slots: revision.preserved_slots.map(slotInfo),
    suspended_slots: revision.suspended_slots.map(slotInfo),
    resumed_slots: [...new Set(revision.resumed_slots)].map(slotInfo),
    replacement_links: revision.replacement_links,
    invalidated_evidence: invalidatedEvidence,
    retained_evidence: retainedEvidence,
    consumable_changes: consumableChanges,
  };
}

/** 团组当前编排全貌：节点状态、证据、涉及资源余量。 */
export function groupView(service, groupId) {
  const state = service.snapshot();
  const group = state.groups.get(groupId);
  if (!group) return null;
  const slots = [...state.slots.values()]
    .filter((s) => s.group_id === groupId)
    .map((slot) => ({
      slot_id: slot.slot_id,
      title: slot.title,
      venue: slot.venue,
      status: slot.status,
      revision_id: slot.revision_id,
      suspended_reason: slot.suspended_reason,
      routes: (slot.routes ?? []).map((r) => ({
        route: r.route,
        revision_id: r.revision_id,
        equivalence_objective: r.equivalence?.objective ?? null,
      })),
      reservations: [...state.reservations.values()]
        .filter((r) => r.slot_id === slot.slot_id)
        .map((r) => ({
          reservation_id: r.reservation_id,
          resource_id: r.resource_id,
          quantity: r.quantity,
          checked_out_quantity: r.checked_out_quantity ?? 0,
          status: r.status,
          source: r.source,
        })),
    }));

  const evidence = [...state.evidence.values()]
    .filter((e) => e.group_id === groupId)
    .map((e) => ({
      evidence_id: e.evidence_id,
      slot_id: e.slot_id,
      kind: e.kind,
      status: e.status,
      source_resource_id: e.source_resource_id,
      source_ref: e.source_ref,
      invalidated_reason: e.invalidated_reason,
    }));

  // 一次污染改线可能跨团组暂停（如另一组共用污染批次），
  // 因此团组可见的改线 = 挂在本团组的改线 + 任何触及本团组槽位的改线。
  const groupSlotIds = new Set(slots.map((s) => s.slot_id));
  const revisions = [...state.revisions.values()]
    .filter((r) => {
      if (r.group_id === groupId) return true;
      return [r.preserved_slots, r.suspended_slots, r.resumed_slots].some((list) =>
        (list ?? []).some((slotId) => groupSlotIds.has(slotId))
      );
    })
    .map((r) => r.revision_id);

  return {
    group_id: groupId,
    name: group.name,
    size: group.size,
    headcount_locked: group.headcount,
    risk_group: group.risk_group,
    status: group.status,
    mentor_id: group.mentor_id,
    slots,
    evidence,
    revisions,
  };
}

/** 污染影响面视图：从根因资源出发的接触链距离与受影响活动。 */
export function impactView(service, rootResourceId) {
  const state = service.snapshot();
  const chain = traceContactChain(state, rootResourceId);
  const slotImpacts = new Map();
  for (const reservation of state.reservations.values()) {
    const distance = chain.get(reservation.resource_id);
    if (distance === undefined) continue;
    if (!slotImpacts.has(reservation.slot_id)) slotImpacts.set(reservation.slot_id, new Map());
    const byResource = slotImpacts.get(reservation.slot_id);
    byResource.set(reservation.resource_id, {
      distance,
      reservation_status: reservation.status,
    });
  }
  return {
    root_resource_id: rootResourceId,
    contact_chain: [...chain.entries()].map(([resource_id, distance]) => {
      const resource = state.resources.get(resource_id);
      return { resource_id, distance, kind: resource?.kind, status: resource?.status };
    }),
    affected_slots: [...slotImpacts.entries()].map(([slot_id, resources]) => ({
      slot_id,
      status: state.slots.get(slot_id)?.status ?? "unknown",
      resources: [...resources.entries()].map(([resource_id, info]) => ({ resource_id, ...info })),
    })),
  };
}

/**
 * 领队报告：团组每次改线保留了哪些节点、哪些证据失效、耗材余量为何变化。
 */
export function leaderReport(service, groupId) {
  const overview = groupView(service, groupId);
  if (!overview) return null;
  return {
    group: {
      group_id: overview.group_id,
      name: overview.name,
      status: overview.status,
    },
    itinerary: overview.slots.map((s) => ({
      slot_id: s.slot_id,
      title: s.title,
      status: s.status,
      revision_id: s.revision_id,
    })),
    evidence_valid: overview.evidence.filter((e) => e.status === "valid").map((e) => e.evidence_id),
    evidence_invalidated: overview.evidence
      .filter((e) => e.status === "invalidated")
      .map((e) => ({ evidence_id: e.evidence_id, reason: e.invalidated_reason, source_ref: e.source_ref })),
    revisions: overview.revisions.map((id) => {
      const view = revisionView(service, id);
      // 跨团组改线单只展示本团组涉及的槽位
      const own = new Set(overview.slots.map((s) => s.slot_id));
      const inGroup = (list) => list.filter((s) => own.has(s.slot_id)).map((s) => s.slot_id);
      const touchedResources = new Set();
      for (const slot of overview.slots) {
        for (const r of slot.reservations) touchedResources.add(r.resource_id);
      }
      return {
        revision_id: id,
        status: view.status,
        trigger: view.trigger,
        preserved_slot_ids: inGroup(view.preserved_slots),
        suspended_slot_ids: inGroup(view.suspended_slots),
        resumed_slot_ids: inGroup(view.resumed_slots),
        invalidated_evidence_ids: view.invalidated_evidence.map((e) => e.evidence_id),
        consumable_changes: view.consumable_changes
          .filter((c) => touchedResources.has(c.resource_id))
          .map((c) => ({
            resource_id: c.resource_id,
            reason: c.reason,
            available_before: c.available_before,
            current_available: c.current_available,
            frozen_at_revision: c.frozen_at_revision,
          })),
      };
    }),
  };
}
