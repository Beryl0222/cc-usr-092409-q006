import assert from "node:assert/strict";
import test from "node:test";

import { decide, replay, DomainError } from "../src/domain.js";
import { StudyTourService, QuarantineError } from "../src/service.js";

const T0 = "2026-09-25T09:00:00+08:00";
const at = (minutes) => new Date(Date.parse(T0) + minutes * 60_000).toISOString().replace("Z", "+00:00");

function newService() {
  return new StudyTourService({ clock: () => T0 });
}

// 注册导师、两台光谱仪、一台显微镜与三个耗材批次。
function seedRegistry(service) {
  for (const command of [
    {
      type: "registerMentor",
      mentor_id: "m-lead",
      qualifications: [{ risk_group: "chem-B", valid_until: "2027-12-31T23:59:59+08:00" }],
    },
    {
      type: "registerMentor",
      mentor_id: "m-assist",
      qualifications: [{ risk_group: "bio-A", valid_until: "2027-12-31T23:59:59+08:00" }],
    },
    { type: "registerUnit", unit_id: "u-spec-a", name: "光谱仪A", calibration_valid_until: "2027-01-01T00:00:00+08:00" },
    { type: "registerUnit", unit_id: "u-spec-b", name: "光谱仪B", calibration_valid_until: "2027-01-01T00:00:00+08:00" },
    { type: "registerUnit", unit_id: "u-micro", name: "显微镜", calibration_valid_until: "2027-01-01T00:00:00+08:00" },
    { type: "registerBatch", batch_id: "b-reagent-9", name: "显色试剂批次9", quantity: 20 },
    { type: "registerBatch", batch_id: "b-reagent-10", name: "显色试剂批次10", quantity: 30 },
    { type: "registerBatch", batch_id: "b-swab", name: "一次性棉签", quantity: 100 },
  ]) {
    service.submit(command);
  }
}

// ---------------------------------------------------------------------------
// 确认方案：人数、导师资格、仪器校准、耗材批次、风险分组同时锁定（原子）
// ---------------------------------------------------------------------------

test("确认方案同时锁定五项要素；任一不满足则整单不留痕", () => {
  const service = newService();
  seedRegistry(service);

  service.submit({
    type: "confirmGroup",
    command_id: "cmd-confirm-gamma",
    at: at(5),
    group_id: "g-gamma",
    headcount: 6,
    risk_group: "bio-A",
    mentor_ids: ["m-assist"],
    slots: [
      {
        slot_id: "slot-g1",
        objective: "玻片显微观察",
        unit_ids: ["u-micro"],
        consumptions: [{ batch_id: "b-swab", quantity: 2 }],
      },
    ],
  });
  assert.equal(service.state.groups["g-gamma"].headcount, 6);
  assert.equal(service.state.batches["b-swab"].reserved, 2);

  // 同一确认命令重放：幂等，不重复锁定。
  const again = service.submit({
    type: "confirmGroup",
    command_id: "cmd-confirm-gamma",
    at: at(5),
    group_id: "g-gamma",
    headcount: 6,
    risk_group: "bio-A",
    mentor_ids: ["m-assist"],
    slots: [
      {
        slot_id: "slot-g1",
        objective: "玻片显微观察",
        unit_ids: ["u-micro"],
        consumptions: [{ batch_id: "b-swab", quantity: 2 }],
      },
    ],
  });
  assert.equal(again.deduplicated, true);
  assert.equal(service.state.batches["b-swab"].reserved, 2);

  // 导师资格不匹配：整单失败。
  assert.throws(
    () =>
      service.submit({
        type: "confirmGroup",
        at: at(6),
        group_id: "g-bad-mentor",
        headcount: 4,
        risk_group: "chem-B",
        mentor_ids: ["m-assist"], // 只有 bio-A
        slots: [{ slot_id: "slot-x1", objective: "x", unit_ids: ["u-spec-a"], consumptions: [] }],
      }),
    (error) => error.code === "MENTOR_NOT_QUALIFIED"
  );
  assert.equal(service.state.groups["g-bad-mentor"], undefined);
  assert.equal(service.state.slots["slot-x1"], undefined);

  // 库存不足：任何一个活动槽超额，整组都不锁定。
  assert.throws(
    () =>
      service.submit({
        type: "confirmGroup",
        at: at(7),
        group_id: "g-bad-stock",
        headcount: 30,
        risk_group: "bio-A",
        mentor_ids: ["m-assist"],
        slots: [
          { slot_id: "slot-y1", objective: "y", unit_ids: ["u-micro"], consumptions: [{ batch_id: "b-swab", quantity: 999 }] },
        ],
      }),
    (error) => error.code === "INSUFFICIENT_STOCK"
  );
  assert.equal(service.state.groups["g-bad-stock"], undefined);
  assert.equal(service.state.batches["b-swab"].reserved, 2, "失败的确认不改动库存");

  // 校准失效：不能启动/确认。
  service.submit({ type: "registerUnit", unit_id: "u-broken", calibration_valid_until: "2020-01-01T00:00:00+08:00" });
  assert.throws(
    () =>
      service.submit({
        type: "confirmGroup",
        at: at(8),
        group_id: "g-bad-cal",
        headcount: 4,
        risk_group: "bio-A",
        mentor_ids: ["m-assist"],
        slots: [{ slot_id: "slot-z1", objective: "z", unit_ids: ["u-broken"], consumptions: [] }],
      }),
    (error) => error.code === "CALIBRATION_EXPIRED"
  );
});

// ---------------------------------------------------------------------------
// 完整过程：污染发现 → 接触链定位 → 局部暂停 → 证据判定 → 清洁复检替代
// → 离线回执重放（幂等/隔离）→ 服务恢复按原截止点继续 → 领队视图
// ---------------------------------------------------------------------------

test("重放污染发现与局部恢复的完整过程", () => {
  const service = newService();
  seedRegistry(service);
  const submit = (command) => service.submit(command);

  // 1) 三个团组确认。
  //    G-ALPHA：a1 用光谱仪A+批次9；a2 用显微镜+棉签（后完成）。
  //    G-BETA：b1 用光谱仪B+同一批次9 —— 即“另一组继续领用了同一批耗材”。
  submit({
    type: "confirmGroup",
    at: at(10),
    group_id: "g-alpha",
    headcount: 12,
    risk_group: "chem-B",
    mentor_ids: ["m-lead"],
    slots: [
      {
        slot_id: "slot-a1",
        objective: "520nm 吸光度测定",
        unit_ids: ["u-spec-a"],
        consumptions: [{ batch_id: "b-reagent-9", quantity: 4 }],
      },
      {
        slot_id: "slot-a2",
        objective: "显微形态观察",
        unit_ids: ["u-micro"],
        consumptions: [{ batch_id: "b-swab", quantity: 5 }],
      },
    ],
  });
  submit({
    type: "confirmGroup",
    at: at(11),
    group_id: "g-beta",
    headcount: 8,
    risk_group: "chem-B",
    mentor_ids: ["m-lead"],
    slots: [
      {
        slot_id: "slot-b1",
        objective: "520nm 吸光度测定",
        unit_ids: ["u-spec-b"],
        consumptions: [{ batch_id: "b-reagent-9", quantity: 5 }],
      },
    ],
  });

  // 2) 候补：棉签候补会在 a2 释放时原子获得预留；批次9 候补后被污染波及。
  submit({
    type: "registerWaitlist",
    at: at(12),
    waitlist_id: "w-swab",
    group_id: "g-gamma",
    target_slot_id: "slot-g1",
    cutoff: at(120),
    items: [{ batch_id: "b-swab", quantity: 2 }],
  });
  // w-reagent 需求 12：a2 释放棉签时批次9 仅剩 11 个可用，整单无法满足，保持等待；
  // 污染波及批次9 后被暂停，批次报废后按原截止点语义终止。
  submit({
    type: "registerWaitlist",
    at: at(12),
    waitlist_id: "w-reagent",
    group_id: "g-delta",
    target_slot_id: "slot-d1",
    cutoff: at(120),
    items: [{ batch_id: "b-reagent-9", quantity: 12 }],
  });

  // 3) 活动开始后才按实际领用扣减；此前只是预留。
  submit({ type: "startActivity", at: at(20), group_id: "g-alpha" });
  submit({ type: "startActivity", at: at(21), group_id: "g-beta" });
  submit({
    type: "issueConsumables",
    at: at(25),
    slot_id: "slot-a1",
    receipt_id: "R-001",
    items: [{ batch_id: "b-reagent-9", quantity: 2 }],
  });
  submit({
    type: "issueConsumables",
    at: at(26),
    slot_id: "slot-a2",
    receipt_id: "R-002",
    items: [{ batch_id: "b-swab", quantity: 2 }],
  });
  submit({
    type: "issueConsumables",
    at: at(27),
    slot_id: "slot-b1",
    receipt_id: "R-010",
    items: [{ batch_id: "b-reagent-9", quantity: 3 }],
  });
  assert.equal(service.state.batches["b-reagent-9"].consumed, 5);

  // 4) a2 未使用预留原子释放，同一提交里满足棉签候补。
  const release = submit({ type: "releaseUnused", at: at(30), slot_id: "slot-a2" });
  assert.ok(release.events.some((e) => e.event_type === "RESERVATION_RELEASED"));
  assert.ok(release.events.some((e) => e.event_type === "WAITLIST_FULFILLED"));
  assert.equal(service.state.waitlist["w-swab"].status, "fulfilled");
  assert.equal(service.state.batches["b-swab"].reserved, 2, "释放 3、候补锁定 2：净预留 2");

  submit({ type: "completeSlot", at: at(35), slot_id: "slot-a2" });

  // 5) 污染前已合法采集的证据，保留来源。
  submit({
    type: "acceptEvidence",
    at: at(32),
    evidence_id: "ev-a2-photo",
    slot_id: "slot-a2",
    source_ref: "microscope://u-micro/captures/2026-09-25/7781",
    collected_at: at(31),
  });
  submit({
    type: "acceptEvidence",
    at: at(33),
    evidence_id: "ev-a1-spectrum",
    slot_id: "slot-a1",
    source_ref: "spectro://u-spec-a/runs/55121",
    collected_at: at(28),
  });
  submit({
    type: "acceptEvidence",
    at: at(33),
    evidence_id: "ev-b1-spectrum",
    slot_id: "slot-b1",
    source_ref: "spectro://u-spec-b/runs/55130",
    collected_at: at(29),
  });

  // 6) 记录器材/样品接触链：前组遗留样品 → 光谱仪A → 批次9 → 光谱仪B。
  submit({
    type: "recordContact",
    at: at(15),
    slot_id: "slot-a1",
    from: { kind: "sample", id: "s-prev-1" },
    to: { kind: "unit", id: "u-spec-a" },
    via: "前组遗留样品架未撤",
  });
  submit({
    type: "recordContact",
    at: at(24),
    slot_id: "slot-a1",
    from: { kind: "unit", id: "u-spec-a" },
    to: { kind: "batch", id: "b-reagent-9" },
    via: "同一移液槽",
  });
  submit({
    type: "recordContact",
    at: at(24),
    slot_id: "slot-b1",
    from: { kind: "batch", id: "b-reagent-9" },
    to: { kind: "unit", id: "u-spec-b" },
    via: "G-BETA 继续领用同批试剂",
  });

  // 7) 发现污染：恰好定位两台仪器、一批耗材；只暂停未完成节点。
  const hazard = submit({
    type: "raiseHazard",
    at: at(40),
    revision_id: "rev-1",
    kind: "contamination",
    root: { kind: "sample", id: "s-prev-1" },
    reason: "前组样品检出指示剂残留",
    detected_slot_id: "slot-a1",
  });
  const raised = hazard.events.find((e) => e.event_type === "HAZARD_RAISED");
  assert.deepEqual(raised.impacted_units.sort(), ["u-spec-a", "u-spec-b"]);
  assert.deepEqual(raised.impacted_batches, ["b-reagent-9"]);
  assert.deepEqual(raised.impacted_samples, ["s-prev-1"]);
  assert.deepEqual(raised.impacted_slots.sort(), ["slot-a1", "slot-b1"]);
  assert.deepEqual(raised.paused_waitlist, ["w-reagent"]);

  assert.equal(service.state.slots["slot-a1"].status, "suspended");
  assert.equal(service.state.slots["slot-b1"].status, "suspended");
  assert.equal(service.state.slots["slot-a2"].status, "completed", "已完成节点不暂停");
  assert.equal(service.state.units["u-spec-a"].status, "quarantined");
  assert.equal(service.state.units["u-spec-b"].status, "quarantined");
  assert.equal(service.state.batches["b-reagent-9"].status, "quarantined");
  assert.equal(service.state.waitlist["w-reagent"].status, "paused");

  // 暂停后采集的数据不能冒充该槽证据。
  assert.throws(
    () =>
      submit({
        type: "acceptEvidence",
        at: at(41),
        evidence_id: "ev-after",
        slot_id: "slot-a1",
        source_ref: "spectro://u-spec-a/runs/99999",
        collected_at: at(41),
      }),
    (error) => error.code === "EVIDENCE_AFTER_SUSPENSION"
  );

  // 基于污染批次的证据须显式判定失效并说明原因；A 槽暂停前读数保留来源。
  submit({
    type: "invalidateEvidence",
    at: at(42),
    evidence_id: "ev-b1-spectrum",
    revision_id: "rev-1",
    reason: "读数基于受污染批次 b-reagent-9，校准基线不可信",
  });

  // 8) 清洁 A；随后模拟服务崩溃——仅凭日志恢复，复检在恢复后继续。
  submit({ type: "recordCleaning", at: at(50), unit_id: "u-spec-a", revision_id: "rev-1" });
  const eventCountBeforeCrash = service.events.length;
  const recoveredService = StudyTourService.fromEvents(service.events, { clock: () => T0 });
  assert.equal(recoveredService.events.length, eventCountBeforeCrash);
  assert.equal(recoveredService.state.units["u-spec-a"].status, "cleaning");
  assert.equal(recoveredService.state.units["u-spec-b"].status, "quarantined");

  // 9) 恢复后继续复检：A 清洁后复检；B 经校准复检直接恢复（两条路线）。
  recoveredService.submit({
    type: "recertifyUnit",
    at: at(55),
    unit_id: "u-spec-a",
    revision_id: "rev-1",
    valid_until: "2027-06-30T00:00:00+08:00",
  });
  recoveredService.submit({
    type: "recertifyUnit",
    at: at(56),
    unit_id: "u-spec-b",
    revision_id: "rev-1",
    valid_until: "2027-06-30T00:00:00+08:00",
  });

  // 批次9 污染报废；依赖它的候补按原截止点语义终止（资源永久不可用）。
  recoveredService.submit({
    type: "clearBatch",
    at: at(60),
    batch_id: "b-reagent-9",
    revision_id: "rev-1",
    disposition: "discarded",
  });
  assert.equal(recoveredService.state.waitlist["w-reagent"].status, "expired");

  // 10) a1 清洁复检后恢复，耗材改走批次10（替代路线的“资源替换”形式）。
  recoveredService.submit({
    type: "resumeSlot",
    at: at(65),
    slot_id: "slot-a1",
    revision_id: "rev-1",
    resource_changes: [{ from_batch_id: "b-reagent-9", to_batch_id: "b-reagent-10" }],
  });
  assert.equal(recoveredService.state.slots["slot-a1"].status, "started");
  assert.equal(recoveredService.state.reservations["slot-a1"]["b-reagent-10"], 2);

  // 11) 离线领用回执：恢复后重放，新回执扣减。
  recoveredService.queueOfflineReceipt({
    receipt_id: "R-100",
    slot_id: "slot-a1",
    at: at(66),
    items: [{ batch_id: "b-reagent-10", quantity: 2 }],
  });
  const replay1 = recoveredService.replayOffline();
  assert.deepEqual(replay1.applied, ["R-100"]);
  assert.equal(recoveredService.state.batches["b-reagent-10"].consumed, 2);

  // 对同一批离线回执“完全重放”：不重复扣减；旧回执同内容也幂等。
  recoveredService.queueOfflineReceipt({
    receipt_id: "R-100",
    slot_id: "slot-a1",
    at: at(66),
    items: [{ batch_id: "b-reagent-10", quantity: 2 }],
  });
  recoveredService.queueOfflineReceipt({
    receipt_id: "R-001",
    slot_id: "slot-a1",
    at: at(25),
    items: [{ batch_id: "b-reagent-9", quantity: 2 }],
  });
  const replay2 = recoveredService.replayOffline();
  assert.deepEqual(replay2.deduplicated.sort(), ["R-001", "R-100"]);
  assert.equal(recoveredService.state.batches["b-reagent-10"].consumed, 2, "完全重放不重复扣减");

  // 同标识异内容：不扣减、不覆盖，进入隔离并留下事件。
  recoveredService.queueOfflineReceipt({
    receipt_id: "R-001",
    slot_id: "slot-a1",
    at: at(67),
    items: [{ batch_id: "b-reagent-10", quantity: 9 }],
  });
  const replay3 = recoveredService.replayOffline();
  assert.deepEqual(replay3.quarantined, ["R-001"]);
  assert.equal(recoveredService.state.batches["b-reagent-10"].consumed, 2, "隔离回执不产生扣减");
  assert.ok(recoveredService.state.quarantine["R-001"]);

  // 12) b1 改走替代活动：必须说明目标等价关系；原槽保留为 replaced，证据来源保留。
  recoveredService.submit({
    type: "proposeReplacement",
    at: at(70),
    revision_id: "rev-1",
    original_slot_id: "slot-b1",
    new_slot_id: "slot-b1b",
    objective: "520nm 吸光度测定（替代试剂重测标准曲线）",
    unit_ids: ["u-spec-b"],
    consumptions: [{ batch_id: "b-reagent-10", quantity: 3 }],
    equivalence_note:
      "与 slot-b1 同一学习目标（朗伯-比尔定律浓度计算），仅将显色试剂换为批次10并重做空白与标准曲线，评分量规等价",
  });
  assert.equal(recoveredService.state.slots["slot-b1"].status, "replaced");
  assert.equal(recoveredService.state.slots["slot-b1b"].replacement_of, "slot-b1");

  // 13) 服务再次恢复：从日志完全重建，隔离区、回执指纹、余量全部一致；
  //     按各候补“原截止点”继续：未过期可满足者补上，过期且不可满足者终止。
  recoveredService.submit({
    type: "registerWaitlist",
    at: at(72),
    waitlist_id: "w-sub",
    group_id: "g-epsilon",
    target_slot_id: "slot-e1",
    cutoff: at(200),
    items: [{ batch_id: "b-reagent-10", quantity: 1 }],
  });
  recoveredService.submit({
    type: "registerWaitlist",
    at: at(72),
    waitlist_id: "w-impossible",
    group_id: "g-zeta",
    target_slot_id: "slot-z9",
    cutoff: at(73), // 恢复时已过期
    items: [{ batch_id: "b-reagent-10", quantity: 100 }],
  });
  const report = recoveredService.recover(at(90));
  assert.ok(report.recovered_event_count >= eventCountBeforeCrash);
  assert.equal(recoveredService.state.waitlist["w-sub"].status, "fulfilled", "恢复后按原截止点继续候补");
  assert.equal(recoveredService.state.waitlist["w-impossible"].status, "expired");
  assert.ok(recoveredService.state.quarantine["R-001"], "隔离区随日志重建恢复");

  // 14) 改线全部节点恢复后关闭。
  recoveredService.submit({ type: "resumeRevision", at: at(91), revision_id: "rev-1" });
  recoveredService.submit({ type: "closeRevision", at: at(95), revision_id: "rev-1" });
  assert.equal(recoveredService.state.revisions["rev-1"].status, "closed");

  // -------------------------------------------------------------------------
  // 领队视图：保留了哪些节点、哪些证据失效、耗材余量为何变化
  // -------------------------------------------------------------------------
  const view = recoveredService.leaderView();

  const statuses = Object.fromEntries(view.slots.map((s) => [s.slot_id, s.status]));
  assert.equal(statuses["slot-a2"], "completed");
  assert.equal(statuses["slot-a1"], "started");
  assert.equal(statuses["slot-b1"], "replaced");
  assert.equal(statuses["slot-b1b"], "confirmed");

  const revision = view.revisions.find((r) => r.revision_id === "rev-1");
  assert.deepEqual(revision.impacted_units.sort(), ["u-spec-a", "u-spec-b"]);
  assert.ok(revision.kept_nodes.some((n) => n.slot_id === "slot-a2"), "已完成的 a2 作为保留节点出现");
  assert.ok(!revision.kept_nodes.some((n) => ["slot-a1", "slot-b1"].includes(n.slot_id)));
  assert.deepEqual(revision.resumed_slots, ["slot-a1"]);
  assert.equal(revision.replacements[0].original_slot_id, "slot-b1");
  assert.equal(revision.replacements[0].replacement_slot_id, "slot-b1b");
  assert.match(revision.replacements[0].equivalence_note, /同一学习目标/);
  assert.deepEqual(revision.invalidated_evidence.map((e) => e.evidence_id), ["ev-b1-spectrum"]);

  const evidenceById = Object.fromEntries(view.evidence.map((e) => [e.evidence_id, e]));
  assert.equal(evidenceById["ev-a1-spectrum"].status, "valid");
  assert.equal(evidenceById["ev-a1-spectrum"].retained_with_source, true);
  assert.equal(evidenceById["ev-a1-spectrum"].source_ref, "spectro://u-spec-a/runs/55121");
  assert.equal(evidenceById["ev-a2-photo"].retained_with_source, true);
  assert.equal(evidenceById["ev-b1-spectrum"].status, "invalid");
  assert.match(evidenceById["ev-b1-spectrum"].invalid_reason, /b-reagent-9/);

  const b9 = view.batches.find((b) => b.batch_id === "b-reagent-9");
  const b10 = view.batches.find((b) => b.batch_id === "b-reagent-10");
  const swab = view.batches.find((b) => b.batch_id === "b-swab");
  assert.equal(b9.status, "discarded");
  assert.equal(b9.consumed, 5);
  assert.equal(b9.discarded, 15);
  assert.equal(b9.reserved, 0);
  assert.equal(b10.consumed, 2);
  assert.equal(b10.reserved, 4, "b1b 预留 3 + w-sub 候补 1");
  assert.equal(b10.available, 24);
  assert.equal(swab.reserved, 2);
  assert.equal(swab.consumed, 2);

  // 余量变化可以逐条解释：锁定、领用、释放、候补、替代、报废都在流水里。
  const b9Causes = b9.balance_changes.map((c) => c.cause);
  assert.ok(b9Causes.includes("CONSUMABLES_ISSUED"));
  assert.ok(b9Causes.includes("RESERVATION_RELEASED"));
  const discardEntry = b9.balance_changes.find((c) => c.discarded_delta > 0);
  assert.equal(discardEntry.discarded_delta, 15);

  assert.ok(view.quarantine.some((q) => q.id === "R-001"));
});

// ---------------------------------------------------------------------------
// 事件日志是唯一事实来源：完全重放得到逐字段一致的状态
// ---------------------------------------------------------------------------

test("从事件日志完全重放得到一致状态（库存/接触链/改线/证据）", () => {
  const service = newService();
  seedRegistry(service);
  service.submit({
    type: "confirmGroup",
    at: at(10),
    group_id: "g-alpha",
    headcount: 10,
    risk_group: "chem-B",
    mentor_ids: ["m-lead"],
    slots: [
      {
        slot_id: "slot-a1",
        objective: "吸光度测定",
        unit_ids: ["u-spec-a"],
        consumptions: [{ batch_id: "b-reagent-9", quantity: 4 }],
      },
    ],
  });
  service.submit({ type: "startActivity", at: at(20), slot_ids: ["slot-a1"] });
  service.submit({
    type: "issueConsumables",
    at: at(25),
    slot_id: "slot-a1",
    receipt_id: "R-001",
    items: [{ batch_id: "b-reagent-9", quantity: 2 }],
  });
  service.submit({
    type: "recordContact",
    at: at(24),
    slot_id: "slot-a1",
    from: { kind: "sample", id: "s-prev-1" },
    to: { kind: "unit", id: "u-spec-a" },
  });
  service.submit({
    type: "raiseHazard",
    at: at(40),
    revision_id: "rev-1",
    kind: "contamination",
    root: { kind: "sample", id: "s-prev-1" },
  });

  const replayed = replay(service.events);
  assert.equal(replayed.batches["b-reagent-9"].consumed, service.state.batches["b-reagent-9"].consumed);
  assert.equal(replayed.batches["b-reagent-9"].reserved, service.state.batches["b-reagent-9"].reserved);
  assert.equal(replayed.slots["slot-a1"].status, "suspended");
  assert.equal(replayed.units["u-spec-a"].status, "quarantined");
  assert.deepEqual(
    replayed.revisions["rev-1"].impacted_units,
    service.state.revisions["rev-1"].impacted_units
  );
  // 回执指纹随日志恢复：重放旧回执不扣减。
  assert.equal(replayed.receipts["R-001"].hash, service.state.receipts["R-001"].hash);
});

test("同 event_id 异内容的事件重放进入隔离而不是覆盖", () => {
  const service = newService();
  seedRegistry(service);
  const event = service.submit({ type: "registerBatch", batch_id: "b-x", quantity: 1 }).events[0];
  const tampered = { ...event, quantity: 999, content_hash: undefined };
  delete tampered.content_hash;
  assert.throws(() => service.appendEvent(tampered), QuarantineError);
  assert.equal(service.state.batches["b-x"].quantity, 1, "异内容事件不改变状态");
  assert.ok(service.state.quarantine[event.event_id]);

  // 隔离登记本身是只增事件：崩溃后仅凭日志恢复，隔离区仍然保留。
  const rebuilt = StudyTourService.fromEvents(service.events, { clock: () => T0 });
  assert.ok(rebuilt.state.quarantine[event.event_id]);
  assert.equal(rebuilt.state.batches["b-x"].quantity, 1);

  // 对完整日志再次重放：异内容事件仍被隔离，幂等不产生新登记、不抛第二次。
  const again = StudyTourService.fromEvents(service.events, { clock: () => T0 });
  assert.equal(again.events.length, service.events.length);
});

test("校准失效沿接触链定位受影响活动，复检通过后恢复", () => {
  const service = newService();
  seedRegistry(service);
  service.submit({
    type: "confirmGroup",
    at: at(10),
    group_id: "g-cal",
    headcount: 4,
    risk_group: "chem-B",
    mentor_ids: ["m-lead"],
    slots: [
      {
        slot_id: "slot-c1",
        objective: "吸光度测定",
        unit_ids: ["u-spec-a"],
        consumptions: [{ batch_id: "b-swab", quantity: 1 }],
      },
    ],
  });
  service.submit({ type: "startActivity", at: at(20), slot_ids: ["slot-c1"] });
  service.submit({
    type: "recordContact",
    at: at(22),
    slot_id: "slot-c1",
    from: { kind: "unit", id: "u-spec-a" },
    to: { kind: "sample", id: "s-cal-1" },
  });

  // 以样品为根的校准失效告警，沿接触边定位到 u-spec-a 与进行中的槽位。
  const hazard = service.submit({
    type: "raiseHazard",
    at: at(30),
    revision_id: "rev-cal-1",
    kind: "calibration",
    root: { kind: "sample", id: "s-cal-1" },
    reason: "期间核查发现光谱仪A校准漂移",
  });
  const raised = hazard.events.find((e) => e.event_type === "HAZARD_RAISED");
  assert.equal(raised.hazard, "calibration");
  assert.deepEqual(raised.impacted_units, ["u-spec-a"]);
  assert.deepEqual(raised.impacted_slots, ["slot-c1"]);
  assert.equal(service.state.slots["slot-c1"].status, "suspended");

  // 未复检直接恢复被拒绝；复检通过（含清洁）后槽位恢复。
  assert.throws(
    () => service.submit({ type: "resumeSlot", at: at(35), slot_id: "slot-c1", revision_id: "rev-cal-1" }),
    (error) => error.code === "UNIT_UNAVAILABLE"
  );
  service.submit({ type: "recordCleaning", at: at(40), unit_id: "u-spec-a", revision_id: "rev-cal-1" });
  service.submit({
    type: "recertifyUnit",
    at: at(45),
    unit_id: "u-spec-a",
    revision_id: "rev-cal-1",
    valid_until: "2027-06-30T00:00:00+08:00",
  });
  service.submit({ type: "resumeSlot", at: at(50), slot_id: "slot-c1", revision_id: "rev-cal-1" });
  assert.equal(service.state.slots["slot-c1"].status, "started");
});

test("未启动活动不能领用；领用不能超过实际预留", () => {
  const service = newService();
  seedRegistry(service);
  service.submit({
    type: "confirmGroup",
    at: at(10),
    group_id: "g-alpha",
    headcount: 4,
    risk_group: "chem-B",
    mentor_ids: ["m-lead"],
    slots: [
      {
        slot_id: "slot-a1",
        objective: "吸光度测定",
        unit_ids: ["u-spec-a"],
        consumptions: [{ batch_id: "b-reagent-9", quantity: 2 }],
      },
    ],
  });
  assert.throws(
    () =>
      service.submit({
        type: "issueConsumables",
        at: at(11),
        slot_id: "slot-a1",
        items: [{ batch_id: "b-reagent-9", quantity: 1 }],
      }),
    (error) => error.code === "SLOT_NOT_STARTED"
  );
  service.submit({ type: "startActivity", at: at(20), slot_ids: ["slot-a1"] });
  assert.throws(
    () =>
      service.submit({
        type: "issueConsumables",
        at: at(21),
        slot_id: "slot-a1",
        items: [{ batch_id: "b-reagent-9", quantity: 3 }],
      }),
    (error) => error.code === "OVER_ISSUE"
  );
});

test("内核 decide 对未知命令报错", () => {
  assert.throws(() => decide({ type: "nope" }, { seq: {} }, T0), (e) => e.code === "UNKNOWN_COMMAND");
});
