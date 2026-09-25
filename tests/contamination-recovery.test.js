import assert from "node:assert/strict";
import test from "node:test";

import { OrchestrationService, EventStore, leaderReport, revisionView, resourceBalanceView, impactView } from "../src/index.js";

/**
 * 跨馆实验污染发现与局部恢复完整场景：
 * 前一组留下的样品 S1 污染，经接触链波及两台仪器（I1 显微镜、I2 离心机）
 * 与一批耗材 L1；人工改线会整团取消并让另一组继续领用 L1，
 * 本服务只暂停未完成节点、冻结 L1、拦截继续领用，并逐节点恢复。
 */

const T = "2026-09-25T";
const FUTURE = "2027-06-01T00:00:00+08:00";

function buildWorld() {
  const svc = new OrchestrationService(undefined, () => new Date(`${T}09:00:00+08:00`));

  // 仪器：I1 显微镜、I2 离心机（受污染链）、I3 光谱仪、I4 备用离心机（干净）
  svc.registerInstrument({ instrument_id: "I1", name: "显微镜甲", calibrated_until: FUTURE });
  svc.registerInstrument({ instrument_id: "I2", name: "离心机乙", calibrated_until: FUTURE });
  svc.registerInstrument({ instrument_id: "I3", name: "光谱仪丙", calibrated_until: FUTURE });
  svc.registerInstrument({ instrument_id: "I4", name: "备用离心机丁", calibrated_until: FUTURE });
  // 耗材：L1 污染批次 40 份，L2 干净批次 40 份
  svc.registerConsumableLot({ lot_id: "L1", name: "前组共用染色试剂", quantity: 40 });
  svc.registerConsumableLot({ lot_id: "L2", name: "未拆封染色试剂", quantity: 40 });
  // 前组留下的样品
  svc.registerSample({ sample_id: "S1", name: "前组遗留水样" });

  // 器材-样品接触链：S1 经 I1 观察、经 I2 离心、制备时使用 L1
  svc.linkContact({ source_resource_id: "S1", target_resource_id: "I1", summary: "I1 观察过 S1" });
  svc.linkContact({ source_resource_id: "S1", target_resource_id: "I2", summary: "I2 离心过 S1" });
  svc.linkContact({ source_resource_id: "S1", target_resource_id: "L1", summary: "S1 制备领用 L1" });

  svc.registerMentor({
    mentor_id: "M1",
    name: "周老师",
    certifications: [{ cert_id: "CERT-LAB-2", valid_until: FUTURE }],
  });

  // G1 跨馆团组：A0 干净节点（光谱，保留）、A1 进行中节点（显微，已采证）、A2 待开始节点（离心）
  svc.registerGroup({ group_id: "G1", name: "启航中学跨馆队", size: 12, risk_group: "B" });
  svc.planSlot({ slot_id: "A0", group_id: "G1", title: "光谱分析（干净实验室）", venue: "生命科学馆", scheduled_start: `${T}10:30:00+08:00`, risk_level: 2, required_certifications: ["CERT-LAB-2"] });
  svc.planSlot({ slot_id: "A1", group_id: "G1", title: "显微观察", venue: "基础医学馆", scheduled_start: `${T}09:00:00+08:00`, risk_level: 2, required_certifications: ["CERT-LAB-2"] });
  svc.planSlot({ slot_id: "A2", group_id: "G1", title: "离心分离", venue: "基础医学馆", scheduled_start: `${T}11:00:00+08:00`, risk_level: 2, required_certifications: ["CERT-LAB-2"] });
  // G2 另一组：B1 也排了 L1
  svc.registerGroup({ group_id: "G2", name: "知行中学队", size: 8, risk_group: "B" });
  svc.planSlot({ slot_id: "B1", group_id: "G2", title: "平行离心分离", venue: "基础医学馆", scheduled_start: `${T}10:00:00+08:00`, risk_level: 2, required_certifications: ["CERT-LAB-2"] });
  // G3：完全无关的干净团组
  svc.registerGroup({ group_id: "G3", name: "远郊中学队", size: 6, risk_group: "A" });
  svc.planSlot({ slot_id: "C1", group_id: "G3", title: "独立光谱实验", venue: "生态馆", scheduled_start: `${T}14:00:00+08:00`, risk_level: 2, required_certifications: ["CERT-LAB-2"] });
  // G4：候补队，等待 L2
  svc.registerGroup({ group_id: "G4", name: "候补小队", size: 4, risk_group: "B" });
  svc.planSlot({ slot_id: "D1", group_id: "G4", title: "候补加场", venue: "生态馆", scheduled_start: `${T}15:00:00+08:00`, risk_level: 2, required_certifications: ["CERT-LAB-2"] });

  const base = {};
  // 五条件确认（人数/导师/校准/耗材/风险同时锁定）
  svc.confirmGroup({ group_id: "G1", slot_id: "A0", headcount: 12, mentor_id: "M1", lines: [
    { reservation_id: "rsv-a0-i3", resource_id: "I3", quantity: 1 },
    { reservation_id: "rsv-a0-l2", resource_id: "L2", quantity: 5 },
  ] });
  svc.confirmGroup({ group_id: "G1", slot_id: "A1", headcount: 12, mentor_id: "M1", lines: [
    { reservation_id: "rsv-a1-i1", resource_id: "I1", quantity: 1 },
    { reservation_id: "rsv-a1-l1", resource_id: "L1", quantity: 10 },
  ] });
  svc.confirmGroup({ group_id: "G1", slot_id: "A2", headcount: 12, mentor_id: "M1", lines: [
    { reservation_id: "rsv-a2-i2", resource_id: "I2", quantity: 1 },
    { reservation_id: "rsv-a2-l1", resource_id: "L1", quantity: 8 },
  ] });
  svc.confirmGroup({ group_id: "G2", slot_id: "B1", headcount: 8, mentor_id: "M1", lines: [
    { reservation_id: "rsv-b1-l1", resource_id: "L1", quantity: 10 },
  ] });
  svc.confirmGroup({ group_id: "G3", slot_id: "C1", headcount: 6, mentor_id: "M1", lines: [
    { reservation_id: "rsv-c1-l2", resource_id: "L2", quantity: 6 },
  ] });

  svc.requestWaitlist({ request_id: "w-g4-l2", group_id: "G4", slot_id: "D1", resource_id: "L2", quantity: 4, expires_at: "2026-09-25T16:00:00+08:00" });

  // A1 开始并实际领用 6 份 L1（活动开始后才按实际领用扣减）
  svc.startActivity({ slot_id: "A1" });
  svc.recordCheckout({ receipt_id: "RCPT-A1-01", slot_id: "A1", lines: [{ reservation_id: "rsv-a1-l1", quantity: 6 }] });
  // 已采集两条证据：E1 来自 I1 的显微图像（合法），E3 是用 L1 试剂制备的读数（受污染来源）
  svc.acceptEvidence({ evidence_id: "E1", slot_id: "A1", group_id: "G1", kind: "micrograph", source_resource_id: "I1", source_ref: "I1/2026-09-25/A1-001" });
  svc.acceptEvidence({ evidence_id: "E3", slot_id: "A1", group_id: "G1", kind: "spectro_reading", source_resource_id: "L1", source_ref: "L1-batch-prep/A1-002" });

  return svc;
}

test("完整场景：污染发现 → 局部暂停/隔离 → 清洁复检/替代路线 → 候补与恢复 → 领队视图", () => {
  const svc = buildWorld();

  // ---- 1. 发现前组样品污染：沿接触链定位，只暂停未完成节点 ----
  const report = svc.reportContamination({
    root_resource_id: "S1",
    kind: "contamination",
    observed_in_slot_id: "A1",
    invalidate_evidence: ["E3"],
    revision_id: "REV-0925",
    cause: "前一组遗留水样检出超标菌群",
  });

  // 接触链闭包：S1 距离 0；I1/I2/L1 距离 1；I3/I4/L2 不在链上
  assert.deepEqual(report.contact_distances, { S1: 0, I1: 1, I2: 1, L1: 1 });
  assert.deepEqual(report.affected_resource_ids.sort(), ["I1", "I2", "L1", "S1"]);

  // 未完成节点 A1（进行中）、A2（待开始）、B1（另一组）全部暂停；A0、C1 保留
  assert.deepEqual(report.suspended_slots.sort(), ["A1", "A2", "B1"]);
  assert.ok(report.preserved_slots.includes("A0"));
  for (const slotId of ["A1", "A2", "B1"]) {
    assert.equal(svc.snapshot().slots.get(slotId).status, "suspended");
  }
  assert.equal(svc.snapshot().slots.get("A0").status, "confirmed");
  assert.equal(svc.snapshot().slots.get("C1").status, "confirmed");

  // 仪器进入清洁/复检；耗材 L1 隔离并冻结剩余余量 12（40 - 预留22 - 已领6）
  assert.equal(svc.snapshot().resources.get("I1").status, "maintenance");
  assert.equal(svc.snapshot().resources.get("I2").status, "maintenance");
  assert.equal(svc.snapshot().resources.get("L1").status, "quarantined");
  const l1AfterReport = resourceBalanceView(svc, "L1");
  assert.equal(l1AfterReport.initial_quantity, 40);
  assert.equal(l1AfterReport.checked_out, 6);
  assert.equal(l1AfterReport.frozen, 12);
  assert.equal(l1AfterReport.available, 0);
  assert.equal(l1AfterReport.movements.at(-1).reason, "QUARANTINE_FREEZE");

  // E1 合法证据保留来源；E3 失效但来源指针保留
  const evidence = svc.snapshot().evidence;
  assert.equal(evidence.get("E1").status, "valid");
  assert.equal(evidence.get("E1").source_resource_id, "I1");
  assert.equal(evidence.get("E3").status, "invalidated");
  assert.equal(evidence.get("E3").source_resource_id, "L1");
  assert.equal(evidence.get("E3").invalidated_reason, "CONTAMINATED_SOURCE");

  // ---- 2. 另一组不能继续领用同一批耗材 ----
  assert.throws(() => svc.startActivity({ slot_id: "B1" }), (e) => e.code === "SLOT_NOT_CONFIRMED");
  assert.throws(
    () => svc.recordCheckout({ receipt_id: "RCPT-B1-X", slot_id: "B1", lines: [{ reservation_id: "rsv-b1-l1", quantity: 2 }] }),
    (e) => e.code === "ACTIVITY_NOT_STARTED"
  );
  assert.equal(svc.snapshot().resources.get("L1").status, "quarantined");

  // ---- 3. 离线回执完全重放不重复扣减 ----
  const replay = svc.recordCheckout({ receipt_id: "RCPT-A1-01", slot_id: "A1", lines: [{ reservation_id: "rsv-a1-l1", quantity: 6 }] });
  assert.equal(replay.deduplicated, true);
  const checkoutEntries = svc.snapshot().ledger.get("L1").filter((e) => e.reason === "ACTUAL_CHECKOUT");
  assert.equal(checkoutEntries.length, 1);
  assert.equal(checkoutEntries[0].checked_out, 6);

  // ---- 4. A1 走清洁+复检路线，复检通过后恢复；未用 L1 预留释放即冻结 ----
  svc.completeMaintenance({ resource_id: "I1", reinspection_passed: true, calibrated_until: FUTURE });
  svc.rerouteSlot({
    slot_id: "A1",
    route: "cleaning",
    replacements: [],
    revision_id: "REV-0925",
    resume: true,
    objective_equivalence: {
      objective: "完成水样显微观察并留存图像证据",
      equivalence_basis: "同一台显微镜 I1 清洁复检通过后复用，观察任务与步骤不变",
    },
  });
  // A1 剩余 4 份 L1 未使用：释放回的是隔离批次，必须冻结而非重新可领用
  svc.releaseUnused({ reservation_id: "rsv-a1-l1" });
  const l1AfterA1 = resourceBalanceView(svc, "L1");
  assert.equal(l1AfterA1.frozen, 16);
  assert.equal(l1AfterA1.movements.at(-1).reason, "QUARANTINE_FREEZE_ON_RELEASE");
  svc.completeActivity({ slot_id: "A1" });

  // ---- 5. A2 走替代路线：I2→I4、L1→L2，必须说明目标等价关系 ----
  const a2Route = svc.rerouteSlot({
    slot_id: "A2",
    route: "substitution",
    revision_id: "REV-0925",
    resume: true,
    replacements: [
      { from_reservation_id: "rsv-a2-i2", to_resource_id: "I4", quantity: 1 },
      { from_reservation_id: "rsv-a2-l1", to_resource_id: "L2", quantity: 8 },
    ],
    objective_equivalence: {
      objective: "完成离心分离并获得上清液分层数据",
      equivalence_basis: "I4 与 I2 同型号且校准有效，L2 为同规格未拆封批次；离心参数（3000rpm/10min）一致，产出数据可互相替代",
    },
  });
  const a2L2Reservation = a2Route.replacement_links.find((l) => l.to_resource_id === "L2").to_reservation_id;
  svc.recordCheckout({ receipt_id: "RCPT-A2-01", slot_id: "A2", lines: [{ reservation_id: a2L2Reservation, quantity: 8 }] });
  svc.acceptEvidence({ evidence_id: "E2", slot_id: "A2", group_id: "G1", kind: "centrifuge_result", source_resource_id: "I4", source_ref: "I4/2026-09-25/A2-001" });
  svc.completeActivity({ slot_id: "A2" });
  // L1 又冻结 A2 释放的 8 份
  assert.equal(resourceBalanceView(svc, "L1").frozen, 24);

  // ---- 6. 保留节点 A0 与无关团组 C1 全程不受影响，照常运行 ----
  svc.startActivity({ slot_id: "A0" });
  svc.recordCheckout({ receipt_id: "RCPT-A0-01", slot_id: "A0", lines: [{ reservation_id: "rsv-a0-l2", quantity: 5 }] });
  svc.completeActivity({ slot_id: "A0" });

  svc.startActivity({ slot_id: "C1" });
  svc.recordCheckout({ receipt_id: "RCPT-C1-01", slot_id: "C1", lines: [{ reservation_id: "rsv-c1-l2", quantity: 2 }] });
  svc.completeActivity({ slot_id: "C1" });
  // C1 未使用的 4 份 L2 原子释放给候补 G4：释放与晋升同批
  const promotion = svc.releaseUnused({ reservation_id: "rsv-c1-l2", to_waitlist: {} });
  assert.equal(promotion.promoted.request_id, "w-g4-l2");
  assert.equal(promotion.promoted.quantity, 4);
  assert.equal(svc.snapshot().waitlist.entries.get("w-g4-l2").status, "promoted");

  // ---- 7. B1（另一组）同样走替代路线恢复，局部恢复不搞整团取消 ----
  svc.rerouteSlot({
    slot_id: "B1",
    route: "substitution",
    revision_id: "REV-0925",
    resume: true,
    replacements: [{ from_reservation_id: "rsv-b1-l1", to_resource_id: "L2", quantity: 10 }],
    objective_equivalence: {
      objective: "完成平行离心分离对照实验",
      equivalence_basis: "更换同规格 L2 批次，仪器与流程不变，对照组目标与原方案等价",
    },
  });
  const b1L2Reservation = svc
    .snapshot()
    .slots.get("B1")
    .routes.at(-1)
    .replaced.find((l) => l.to_resource_id === "L2").to_reservation_id;
  svc.recordCheckout({ receipt_id: "RCPT-B1-01", slot_id: "B1", lines: [{ reservation_id: b1L2Reservation, quantity: 10 }] });
  svc.completeActivity({ slot_id: "B1" });

  // ---- 8. 服务恢复：按原截止点继续候补与复检 ----
  const recovery = svc.recover({ now: "2026-09-25T15:30:00+08:00" });
  assert.deepEqual(recovery.expired, []); // 候补已晋升，无过期
  assert.deepEqual(recovery.pending_reinspection.map((r) => r.resource_id), ["I2"]); // I1 已复检，I2 仍待检
  // 复检未通过保持维护单 open
  svc.completeMaintenance({ resource_id: "I2", reinspection_passed: false });
  assert.equal(svc.snapshot().maintenance.get("I2").status, "open");
  // 再次清洁后复检通过
  svc.completeMaintenance({ resource_id: "I2", reinspection_passed: true, calibrated_until: FUTURE });
  assert.equal(svc.snapshot().maintenance.get("I2").status, "closed");
  assert.equal(svc.snapshot().resources.get("I2").status, "available");

  // ---- 9. 最终核对：L1 全部 40 份去向可解释（领用 6 + 冻结 34，可领用 0）----
  const l1 = resourceBalanceView(svc, "L1");
  assert.equal(l1.checked_out, 6);
  assert.equal(l1.frozen, 34);
  assert.equal(l1.held, 0);
  assert.equal(l1.available, 0);
  const l2 = resourceBalanceView(svc, "L2");
  // 40 = 实际领用(A0 5 + A2 8 + C1 2 + B1 10 = 25) + 候补晋升持有 4 + 尚可领用 11
  assert.equal(l2.checked_out, 25);
  assert.equal(l2.held, 4);
  assert.equal(l2.available, 11);

  // ---- 10. 领队视图：每次改线保留的节点、失效证据、余量变化原因 ----
  const view = revisionView(svc, "REV-0925");
  assert.deepEqual(view.preserved_slots.map((s) => s.slot_id), ["A0"]);
  assert.deepEqual(view.suspended_slots.map((s) => s.slot_id).sort(), ["A1", "A2", "B1"]);
  assert.deepEqual([...new Set(view.resumed_slots.map((s) => s.slot_id))].sort(), ["A1", "A2", "B1"]);
  assert.equal(view.invalidated_evidence.length, 1);
  assert.equal(view.invalidated_evidence[0].evidence_id, "E3");
  assert.equal(view.invalidated_evidence[0].source_resource_id, "L1"); // 失效仍保留来源
  assert.ok(view.retained_evidence.some((e) => e.evidence_id === "E1")); // 合法证据保留
  // 替代链接：A2 两条 + B1 一条
  assert.equal(view.replacement_links.length, 3);
  // 每条替代路线都带目标等价说明
  for (const slotId of ["A1", "A2", "B1"]) {
    const routes = view.resumed_slots.find((s) => s.slot_id === slotId).routes;
    assert.ok(routes.length >= 1);
    assert.ok(routes[0].equivalence.objective);
    assert.ok(routes[0].equivalence.equivalence_basis);
  }
  // 耗材余量变化归因
  const l1Change = view.consumable_changes.find((c) => c.resource_id === "L1");
  assert.equal(l1Change.reason, "QUARANTINE_FREEZE");
  assert.equal(l1Change.current_available, 0);

  const leader = leaderReport(svc, "G1");
  assert.deepEqual(leader.evidence_valid, ["E1", "E2"]);
  assert.equal(leader.evidence_invalidated[0].evidence_id, "E3");
  assert.equal(leader.revisions.length, 1);

  // 跨团组改线：G2 领队也能看到自己被暂停/恢复的 B1 节点与改线单
  const leaderG2 = leaderReport(svc, "G2");
  assert.deepEqual(leaderG2.itinerary.map((s) => [s.slot_id, s.status]), [["B1", "completed"]]);
  assert.equal(leaderG2.revisions.length, 1);
  assert.deepEqual(leaderG2.revisions[0].suspended_slot_ids, ["B1"]);
  assert.deepEqual(leaderG2.revisions[0].resumed_slot_ids, ["B1"]);

  // 影响面视图：C1 与 G3 从不出现在受影响活动中
  const impact = impactView(svc, "S1");
  const impactedSlotIds = impact.affected_slots.map((s) => s.slot_id);
  assert.deepEqual(impactedSlotIds.sort(), ["A1", "A2", "B1"]);

  // ---- 11. 全部暂停节点恢复/完成后，改线单闭环 ----
  const closed = svc.closeRevision({ revision_id: "REV-0925" });
  assert.equal(closed.status, "closed");
  assert.equal(revisionView(svc, "REV-0925").status, "closed");

  // ---- 11. 服务重启：从事件日志完整重放后状态一致 ----
  const rebuilt = new OrchestrationService(EventStore.fromLog(svc.store.toLog()), () => new Date(`${T}16:30:00+08:00`));
  const l1Rebuilt = resourceBalanceView(rebuilt, "L1");
  assert.equal(l1Rebuilt.available, 0);
  assert.equal(l1Rebuilt.frozen, 34);
  assert.equal(rebuilt.snapshot().slots.get("A1").status, "completed");
  assert.equal(rebuilt.snapshot().slots.get("B1").status, "completed");
  const rebuiltView = revisionView(rebuilt, "REV-0925");
  assert.equal(rebuiltView.replacement_links.length, 3);
  assert.equal(rebuiltView.invalidated_evidence.length, 1);
  // 重启后回执重放依旧幂等
  const replayAfterReboot = rebuilt.recordCheckout({ receipt_id: "RCPT-A1-01", slot_id: "A1", lines: [{ reservation_id: "rsv-a1-l1", quantity: 6 }] });
  assert.equal(replayAfterReboot.deduplicated, true);
});
