import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { OrchestrationService, leaderReport, resourceBalanceView } from "../src/index.js";

const FUTURE = "2027-06-01T00:00:00+08:00";
const T0 = "2026-09-25T09:00:00+08:00";

test("校准失效同样沿器材-样品接触链定位并只暂停未完成节点", () => {
  const svc = new OrchestrationService(undefined, () => new Date(T0));
  svc.registerInstrument({ instrument_id: "I2", name: "离心机", calibrated_until: FUTURE });
  svc.registerInstrument({ instrument_id: "I5", name: "光谱仪", calibrated_until: FUTURE });
  svc.registerConsumableLot({ lot_id: "L1", name: "离心管批次", quantity: 20 });
  svc.registerSample({ sample_id: "S2", name: "待测血样" });
  svc.linkContact({ source_resource_id: "S2", target_resource_id: "I2" });
  svc.linkContact({ source_resource_id: "S2", target_resource_id: "L1" });
  svc.registerMentor({ mentor_id: "M1", certifications: [{ cert_id: "C1", valid_until: FUTURE }] });
  svc.registerGroup({ group_id: "G1", size: 6, risk_group: "B" });
  svc.planSlot({ slot_id: "A1", group_id: "G1", title: "离心", scheduled_start: T0, risk_level: 1, required_certifications: ["C1"] });
  svc.planSlot({ slot_id: "A2", group_id: "G1", title: "光谱", scheduled_start: T0, risk_level: 1, required_certifications: ["C1"] });
  svc.confirmGroup({ group_id: "G1", slot_id: "A1", headcount: 6, mentor_id: "M1", lines: [
    { reservation_id: "r-i2", resource_id: "I2", quantity: 1 },
    { reservation_id: "r-l1", resource_id: "L1", quantity: 8 },
  ] });
  svc.confirmGroup({ group_id: "G1", slot_id: "A2", headcount: 6, mentor_id: "M1", lines: [
    { reservation_id: "r-i5", resource_id: "I5", quantity: 1 },
  ] });
  svc.startActivity({ slot_id: "A1" });
  svc.recordCheckout({ receipt_id: "RC1", slot_id: "A1", lines: [{ reservation_id: "r-l1", quantity: 3 }] });

  const report = svc.reportContamination({ root_resource_id: "I2", kind: "calibration", observed_in_slot_id: "A1", revision_id: "REV-CAL" });

  // 接触链：I2 -> S2 -> L1（L1 距根因两跳）
  assert.deepEqual(report.contact_distances, { I2: 0, S2: 1, L1: 2 });
  // 仪器进入复检维护；接触链上耗材隔离冻结（余量 20-8=12）
  assert.equal(svc.snapshot().resources.get("I2").status, "maintenance");
  assert.equal(svc.snapshot().maintenance.get("I2").reason, "CALIBRATION_INVALID");
  assert.equal(resourceBalanceView(svc, "L1").frozen, 12); // 20 - 持有余量5 - 已领3
  // 只暂停进行中的 A1；A2 用的是链外的 I5，保留
  assert.deepEqual(report.suspended_slots, ["A1"]);
  assert.ok(report.preserved_slots.includes("A2"));
  assert.equal(svc.snapshot().slots.get("A2").status, "confirmed");

  // 维护单在复检通过前不能用于新确认
  assert.throws(
    () => svc.confirmGroup({ group_id: "G1", slot_id: "A2", headcount: 6, mentor_id: "M1", lines: [{ reservation_id: "x", resource_id: "I2", quantity: 1 }] }),
    (e) => e.code === "SLOT_NOT_PLANNED"
  );
  // 复检通过并更新校准有效期后恢复
  svc.completeMaintenance({ resource_id: "I2", reinspection_passed: true, calibrated_until: FUTURE });
  assert.equal(svc.snapshot().resources.get("I2").status, "available");
  svc.rerouteSlot({
    slot_id: "A1",
    route: "reinspection",
    revision_id: "REV-CAL",
    resume: true,
    replacements: [],
    objective_equivalence: { objective: "完成离心测量", equivalence_basis: "I2 重新校准合格后复用同一流程" },
  });
  const leader = leaderReport(svc, "G1");
  assert.equal(leader.revisions[0].trigger, "CALIBRATION_INVALID");
});

test("服务产生的全部事件类型都在领域契约枚举内", async () => {
  const schema = JSON.parse(await readFile(new URL("../contracts/domain.schema.json", import.meta.url), "utf8"));
  const allowed = new Set(schema.properties.event_type.enum);
  const allowedAggregates = new Set(schema.properties.aggregate_type.enum);

  const svc = new OrchestrationService(undefined, () => new Date(T0));
  svc.registerInstrument({ instrument_id: "I1", calibrated_until: FUTURE });
  svc.registerConsumableLot({ lot_id: "L1", quantity: 10 });
  svc.registerSample({ sample_id: "S1" });
  svc.linkContact({ source_resource_id: "S1", target_resource_id: "I1" });
  svc.registerMentor({ mentor_id: "M1", certifications: [{ cert_id: "C1", valid_until: FUTURE }] });
  svc.registerGroup({ group_id: "G1", size: 4, risk_group: "B" });
  svc.planSlot({ slot_id: "A1", group_id: "G1", title: "t", scheduled_start: T0, risk_level: 1, required_certifications: ["C1"] });
  svc.confirmGroup({ group_id: "G1", slot_id: "A1", headcount: 4, mentor_id: "M1", lines: [{ reservation_id: "r1", resource_id: "L1", quantity: 4 }] });
  svc.requestWaitlist({ request_id: "w1", group_id: "G1", slot_id: "A1", resource_id: "L1", quantity: 1, expires_at: "2026-01-01T00:00:00+08:00" });
  svc.startActivity({ slot_id: "A1" });
  svc.recordCheckout({ receipt_id: "RC", slot_id: "A1", lines: [{ reservation_id: "r1", quantity: 2 }] });
  svc.acceptEvidence({ evidence_id: "E1", slot_id: "A1", group_id: "G1", kind: "note" });
  svc.reportContamination({ root_resource_id: "S1", observed_in_slot_id: "A1", invalidate_evidence: ["E1"], revision_id: "RV" });
  svc.completeMaintenance({ resource_id: "I1", reinspection_passed: true, calibrated_until: FUTURE });
  svc.rerouteSlot({
    slot_id: "A1",
    route: "cleaning",
    revision_id: "RV",
    resume: true,
    objective_equivalence: { objective: "完成实验", equivalence_basis: "仪器清洁复检后复用同一流程" },
  });
  svc.completeActivity({ slot_id: "A1" });
  svc.recover({ now: "2026-09-25T12:00:00+08:00" });

  for (const event of svc.store.events()) {
    assert.ok(allowed.has(event.event_type), `未在契约中声明的事件类型：${event.event_type}`);
    assert.ok(allowedAggregates.has(event.aggregate_type), `未在契约中声明的聚合类型：${event.aggregate_type}`);
    for (const field of ["event_id", "event_type", "aggregate_type", "aggregate_id", "occurred_at", "version", "summary"]) {
      assert.ok(field in event, `事件缺少信封字段 ${field}`);
    }
    assert.ok(Number.isInteger(event.version) && event.version >= 1);
  }
});
