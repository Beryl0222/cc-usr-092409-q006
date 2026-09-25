import assert from "node:assert/strict";
import test from "node:test";

import { OrchestrationService } from "../src/index.js";
import { ValidationRejected } from "../src/index.js";

const DAY = "2026-09-25T09:00:00+08:00";
const FUTURE = "2027-01-01T00:00:00+08:00";
const PAST = "2026-01-01T00:00:00+08:00";

function seed(overrides = {}) {
  const svc = new OrchestrationService(undefined, () => new Date(DAY));
  svc.registerInstrument({ instrument_id: "I1", name: "显微镜甲", calibrated_until: FUTURE });
  svc.registerConsumableLot({ lot_id: "L1", name: "染色试剂", quantity: 50 });
  svc.registerMentor({
    mentor_id: "M1",
    name: "王老师",
    certifications: [{ cert_id: "CERT-LAB-2", valid_until: FUTURE }],
  });
  svc.registerGroup({ group_id: "G1", name: "朝阳中学二队", size: 12, risk_group: "B" });
  svc.planSlot({
    slot_id: "A1",
    group_id: "G1",
    title: "显微观察",
    scheduled_start: DAY,
    risk_level: 2,
    required_certifications: ["CERT-LAB-2"],
  });
  const lines = [{ reservation_id: "rsv-i1", resource_id: "I1", quantity: 1 }, { reservation_id: "rsv-l1", resource_id: "L1", quantity: 20 }];
  return { svc, lines, ...overrides };
}

test("确认成功时五条件同时锁定并原子预留", () => {
  const { svc, lines } = seed();
  const result = svc.confirmGroup({ group_id: "G1", slot_id: "A1", headcount: 12, mentor_id: "M1", lines });
  assert.equal(result.locked.headcount.ok, true);
  assert.equal(result.locked.mentor.certifications[0].ok, true);
  assert.equal(result.locked.risk_group.ok, true);
  assert.ok(result.locked.resources.every((r) => r.ok));
  assert.equal(svc.snapshot().slots.get("A1").status, "confirmed");
  // 预留即刻持有：可领用余量 = 50-20
  assert.equal(svc.snapshot().ledger.get("L1").at(-1).reason, "RESERVATION_HOLD");
});

test("人数不一致时整体拒绝且不产生任何事件", () => {
  const { svc, lines } = seed();
  const before = svc.store.size;
  assert.throws(
    () => svc.confirmGroup({ group_id: "G1", slot_id: "A1", headcount: 11, mentor_id: "M1", lines }),
    (e) => e instanceof ValidationRejected && e.details.failures.includes("HEADCOUNT_MISMATCH")
  );
  assert.equal(svc.store.size, before);
  assert.equal(svc.snapshot().slots.get("A1").status, "planned");
});

test("导师证书过期或缺失时拒绝", () => {
  let { svc, lines } = seed();
  svc.registerMentor({ mentor_id: "M2", name: "临期导师", certifications: [{ cert_id: "CERT-LAB-2", valid_until: PAST }] });
  assert.throws(
    () => svc.confirmGroup({ group_id: "G1", slot_id: "A1", headcount: 12, mentor_id: "M2", lines }),
    (e) => e.details.failures.includes("MENTOR_CERT_CERT-LAB-2_INVALID")
  );
  assert.throws(
    () => svc.confirmGroup({ group_id: "G1", slot_id: "A1", headcount: 12, mentor_id: "NOBODY", lines }),
    (e) => e.details.failures.includes("MENTOR_UNKNOWN")
  );
});

test("仪器校准失效或容量不足时拒绝", () => {
  let { svc, lines } = seed();
  svc.registerInstrument({ instrument_id: "I-EXPIRED", name: "旧仪器", calibrated_until: PAST });
  assert.throws(
    () =>
      svc.confirmGroup({
        group_id: "G1",
        slot_id: "A1",
        headcount: 12,
        mentor_id: "M1",
        lines: [{ reservation_id: "r1", resource_id: "I-EXPIRED", quantity: 1 }],
      }),
    (e) => e.details.failures.includes("CALIBRATION_EXPIRED_I-EXPIRED")
  );

  // I1 默认容量 1（未给 capacity），先占用一台再确认即满
  svc = seed().svc;
  svc.registerGroup({ group_id: "G2", name: "另一队", size: 5, risk_group: "C" });
  svc.planSlot({ slot_id: "A2", group_id: "G2", title: "其他实验", scheduled_start: DAY, risk_level: 1 });
  svc.confirmGroup({ group_id: "G2", slot_id: "A2", headcount: 5, mentor_id: "M1", lines: [{ reservation_id: "r2", resource_id: "I1", quantity: 1 }] });
  assert.throws(
    () => svc.confirmGroup({ group_id: "G1", slot_id: "A1", headcount: 12, mentor_id: "M1", lines: [{ reservation_id: "r3", resource_id: "I1", quantity: 1 }] }),
    (e) => e.details.failures.includes("CAPACITY_FULL_I1")
  );
});

test("耗材余量不足时拒绝", () => {
  const { svc } = seed();
  assert.throws(
    () =>
      svc.confirmGroup({
        group_id: "G1",
        slot_id: "A1",
        headcount: 12,
        mentor_id: "M1",
        lines: [{ reservation_id: "r4", resource_id: "L1", quantity: 80 }],
      }),
    (e) => e.details.failures.includes("CONSUMABLE_SHORTAGE_L1")
  );
});

test("风险分组许可不足时拒绝", () => {
  const { svc, lines } = seed();
  // C 组许可等级 1，活动要求等级 2
  svc.registerGroup({ group_id: "GC", name: "低风险许可组", size: 12, risk_group: "C" });
  svc.planSlot({ slot_id: "AC", group_id: "GC", title: "显微观察", scheduled_start: DAY, risk_level: 2, required_certifications: ["CERT-LAB-2"] });
  assert.throws(
    () => svc.confirmGroup({ group_id: "GC", slot_id: "AC", headcount: 12, mentor_id: "M1", lines: [] }),
    (e) => e.details.failures.includes("RISK_GROUP_CLEARANCE_INSUFFICIENT")
  );
});

test("未使用预留原子释放给候补：释放与晋升同批提交", () => {
  const { svc, lines } = seed();
  svc.confirmGroup({ group_id: "G1", slot_id: "A1", headcount: 12, mentor_id: "M1", lines });
  svc.registerGroup({ group_id: "G2", name: "候补队", size: 6, risk_group: "B" });
  svc.planSlot({ slot_id: "A2", group_id: "G2", title: "补位实验", scheduled_start: DAY, risk_level: 2 });
  svc.requestWaitlist({ request_id: "w1", group_id: "G2", slot_id: "A2", resource_id: "L1", quantity: 20, expires_at: FUTURE });

  const sizeBefore = svc.store.size;
  const result = svc.releaseUnused({ reservation_id: "rsv-l1", to_waitlist: {} });
  assert.equal(result.released, 20);
  assert.equal(result.promoted.request_id, "w1");
  // 同一批次恰好两条事件：RESERVATION_RELEASED + WAITLIST_PROMOTED
  assert.equal(svc.store.size - sizeBefore, 2);
  assert.equal(svc.snapshot().waitlist.entries.get("w1").status, "promoted");
  // 余量语义不丢：20 份只是换了持有人，总 held 仍为 20
  const balance = svc.snapshot().ledger.get("L1");
  const heldSum = balance.reduce((sum, e) => sum + e.held, 0);
  assert.equal(heldSum, 20);
});

test("活动开始前不能记录领用", () => {
  const { svc, lines } = seed();
  svc.confirmGroup({ group_id: "G1", slot_id: "A1", headcount: 12, mentor_id: "M1", lines });
  assert.throws(
    () => svc.recordCheckout({ receipt_id: "rcpt-x", slot_id: "A1", lines: [{ reservation_id: "rsv-l1", quantity: 5 }] }),
    (e) => e.code === "ACTIVITY_NOT_STARTED"
  );
});
