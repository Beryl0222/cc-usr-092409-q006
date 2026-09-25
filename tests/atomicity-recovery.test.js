import assert from "node:assert/strict";
import test from "node:test";

import { OrchestrationService } from "../src/index.js";

const T0 = "2026-09-25T09:00:00+08:00";
const FUTURE = "2027-06-01T00:00:00+08:00";

function setup() {
  const svc = new OrchestrationService(undefined, () => new Date(T0));
  svc.registerConsumableLot({ lot_id: "L1", name: "试剂", quantity: 20 });
  svc.registerInstrument({ instrument_id: "I1", name: "光谱仪", calibrated_until: FUTURE });
  svc.registerMentor({ mentor_id: "M1", certifications: [{ cert_id: "C1", valid_until: FUTURE }] });
  svc.registerGroup({ group_id: "G1", size: 4, risk_group: "B" });
  svc.planSlot({ slot_id: "A1", group_id: "G1", title: "实验", scheduled_start: T0, risk_level: 1, required_certifications: ["C1"] });
  svc.confirmGroup({ group_id: "G1", slot_id: "A1", headcount: 4, mentor_id: "M1", lines: [
    { reservation_id: "r1", resource_id: "L1", quantity: 10 },
    { reservation_id: "r-i1", resource_id: "I1", quantity: 1 },
  ] });
  return svc;
}

test("指定候补承接但无合格候补时，释放整体回滚，不产生任何事件", () => {
  const svc = setup();
  // 仪器候补数量 2 超过单台容量可释放量 1，仪器不支持部分承接
  svc.requestWaitlist({ request_id: "w-big", group_id: "G1", slot_id: "A1", resource_id: "I1", quantity: 2, expires_at: FUTURE });
  const before = svc.store.size;
  assert.throws(
    () => svc.releaseUnused({ reservation_id: "r-i1", to_waitlist: {} }),
    (e) => e.code === "NO_ELIGIBLE_WAITLIST"
  );
  // 整批回滚：无释放事件，占用不变，候补仍在等待
  assert.equal(svc.store.size, before);
  assert.equal(svc.snapshot().reservations.get("r-i1").status, "held");
  assert.equal(svc.snapshot().waitlist.entries.get("w-big").status, "waiting");
});

test("已过截止点的候补不参与承接", () => {
  const svc = setup();
  svc.requestWaitlist({ request_id: "w-old", group_id: "G1", slot_id: "A1", resource_id: "L1", quantity: 10, expires_at: "2026-09-24T00:00:00+08:00" });
  assert.throws(
    () => svc.releaseUnused({ reservation_id: "r1", to_waitlist: { now: "2026-09-25T12:00:00+08:00" } }),
    (e) => e.code === "NO_ELIGIBLE_WAITLIST"
  );
  assert.equal(svc.snapshot().reservations.get("r1").status, "held");
});

test("隔离批次上的未使用预留不能转给候补，只能冻结", () => {
  const svc = setup();
  svc.requestWaitlist({ request_id: "w1", group_id: "G1", slot_id: "A1", resource_id: "L1", quantity: 10, expires_at: FUTURE });
  svc.registerSample({ sample_id: "S1" });
  svc.linkContact({ source_resource_id: "S1", target_resource_id: "L1" });
  svc.reportContamination({ root_resource_id: "S1", observed_in_slot_id: "A1", revision_id: "REV1" });

  assert.throws(
    () => svc.releaseUnused({ reservation_id: "r1", to_waitlist: {} }),
    (e) => e.code === "RESOURCE_UNAVAILABLE"
  );
  // 不指定候补：释放即冻结，候补保持等待
  const result = svc.releaseUnused({ reservation_id: "r1" });
  assert.equal(result.released, 10);
  assert.equal(result.promoted, null);
  assert.equal(svc.snapshot().waitlist.entries.get("w1").status, "waiting");
});

test("复检未通过时维护单保持打开，可再次复检", () => {
  const svc = setup();
  svc.registerInstrument({ instrument_id: "I9", calibrated_until: FUTURE });
  svc.registerSample({ sample_id: "S9" });
  svc.linkContact({ source_resource_id: "S9", target_resource_id: "I9" });
  svc.reportContamination({ root_resource_id: "S9", revision_id: "REV2" });
  assert.equal(svc.snapshot().maintenance.get("I9").status, "open");

  svc.completeMaintenance({ resource_id: "I9", reinspection_passed: false });
  assert.equal(svc.snapshot().maintenance.get("I9").status, "open");
  assert.equal(svc.snapshot().resources.get("I9").status, "maintenance");

  svc.completeMaintenance({ resource_id: "I9", reinspection_passed: true, calibrated_until: FUTURE });
  assert.equal(svc.snapshot().maintenance.get("I9").status, "closed");
  assert.equal(svc.snapshot().resources.get("I9").status, "available");
});
