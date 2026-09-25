import assert from "node:assert/strict";
import test from "node:test";

import { OrchestrationService, EventStore } from "../src/index.js";

const T0 = "2026-09-25T09:00:00+08:00";
const FUTURE = "2027-01-01T00:00:00+08:00";

function setup() {
  const svc = new OrchestrationService(undefined, () => new Date(T0));
  svc.registerInstrument({ instrument_id: "I1", name: "离心机", calibrated_until: FUTURE });
  svc.registerConsumableLot({ lot_id: "L1", name: "离心管", quantity: 30 });
  svc.registerMentor({ mentor_id: "M1", name: "李老师", certifications: [{ cert_id: "C1", valid_until: FUTURE }] });
  svc.registerGroup({ group_id: "G1", name: "一队", size: 8, risk_group: "B" });
  svc.planSlot({ slot_id: "A1", group_id: "G1", title: "离心分离", scheduled_start: T0, risk_level: 1, required_certifications: ["C1"] });
  svc.confirmGroup({
    group_id: "G1",
    slot_id: "A1",
    headcount: 8,
    mentor_id: "M1",
    lines: [{ reservation_id: "rsv-l1", resource_id: "L1", quantity: 10 }],
  });
  svc.startActivity({ slot_id: "A1" });
  return svc;
}

test("离线回执完整重放不重复扣减", () => {
  const svc = setup();
  const payload = { receipt_id: "RCPT-1", slot_id: "A1", lines: [{ reservation_id: "rsv-l1", quantity: 6 }] };
  const first = svc.recordCheckout(payload);
  assert.equal(first.status, "recorded");
  assert.equal(first.deduplicated, false);

  // 网络重试 / 服务重启后重放完全相同的回执
  const replay = svc.recordCheckout({ ...payload });
  assert.equal(replay.status, "recorded");
  assert.equal(replay.deduplicated, true);

  // 实际扣减只发生一次
  const checkedOut = svc.snapshot().ledger.get("L1").filter((e) => e.reason === "ACTUAL_CHECKOUT");
  assert.equal(checkedOut.length, 1);
  assert.equal(checkedOut[0].checked_out, 6);
  // 仍有 4 份持有余量可继续领用
  const rsv = svc.snapshot().reservations.get("rsv-l1");
  assert.equal(rsv.status, "partially_checked_out");
  assert.equal(rsv.quantity - rsv.checked_out_quantity, 4);
});

test("同标识异内容回执进入隔离且不扣减", () => {
  const svc = setup();
  svc.recordCheckout({ receipt_id: "RCPT-2", slot_id: "A1", lines: [{ reservation_id: "rsv-l1", quantity: 3 }] });
  const balanceAfter = svc.snapshot().ledger.get("L1").reduce((s, e) => s + e.checked_out, 0);

  // 伪造/损坏重放：同一回执编号，数量不同
  const clash = svc.recordCheckout({ receipt_id: "RCPT-2", slot_id: "A1", lines: [{ reservation_id: "rsv-l1", quantity: 9 }] });
  assert.equal(clash.status, "quarantined");
  assert.equal(clash.reason, "SAME_ID_DIFFERENT_CONTENT");

  // 再次提交冲突回执仍保持隔离，不会补扣
  const again = svc.recordCheckout({ receipt_id: "RCPT-2", slot_id: "A1", lines: [{ reservation_id: "rsv-l1", quantity: 9 }] });
  assert.equal(again.status, "quarantined");
  const balanceFinal = svc.snapshot().ledger.get("L1").reduce((s, e) => s + e.checked_out, 0);
  assert.equal(balanceFinal, balanceAfter);
  assert.equal(svc.snapshot().receipts.get("RCPT-2").status, "quarantined");
});

test("从事件日志重建服务后重放回执仍然幂等", () => {
  const svc1 = setup();
  svc1.recordCheckout({ receipt_id: "RCPT-3", slot_id: "A1", lines: [{ reservation_id: "rsv-l1", quantity: 2 }] });

  // 模拟服务重启：导出日志 -> 重建存储 -> 重建服务
  const log = svc1.store.toLog();
  const svc2 = new OrchestrationService(EventStore.fromLog(log), () => new Date(T0));
  const replay = svc2.recordCheckout({ receipt_id: "RCPT-3", slot_id: "A1", lines: [{ reservation_id: "rsv-l1", quantity: 2 }] });
  assert.equal(replay.deduplicated, true);
  const checkedOut = svc2.snapshot().ledger.get("L1").filter((e) => e.reason === "ACTUAL_CHECKOUT");
  assert.equal(checkedOut.length, 1);
});

test("服务恢复后按原截止点让过期候补失效，未过期候补继续等待", () => {
  const svc = setup();
  svc.registerGroup({ group_id: "G2", name: "二队", size: 4, risk_group: "B" });
  svc.planSlot({ slot_id: "A2", group_id: "G2", title: "加场", scheduled_start: T0, risk_level: 1 });
  // w-old 截止点早于恢复时刻；w-new 截止点在未来
  svc.requestWaitlist({ request_id: "w-old", group_id: "G2", slot_id: "A2", resource_id: "L1", quantity: 5, expires_at: "2026-09-25T10:00:00+08:00" });
  svc.requestWaitlist({ request_id: "w-new", group_id: "G2", slot_id: "A2", resource_id: "L1", quantity: 5, expires_at: "2026-09-26T10:00:00+08:00" });

  const result = svc.recover({ now: "2026-09-25T12:00:00+08:00" });
  assert.deepEqual(result.expired, ["w-old"]);
  assert.equal(svc.snapshot().waitlist.entries.get("w-old").status, "expired");
  assert.equal(svc.snapshot().waitlist.entries.get("w-new").status, "waiting");

  // 恢复后释放预留：过期候补不参与，未过期候补可承接
  const promoted = svc.releaseUnused({ reservation_id: "rsv-l1", to_waitlist: {}, event_id: "rel-after-recovery" });
  assert.equal(promoted.promoted.request_id, "w-new");
});
