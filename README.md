# 研学实操资源编排（污染隔离与可恢复编排服务）

在多馆研学实验中，把**团组、活动槽、器材单元、耗材批次与学习证据**串成一条
可恢复的实操编排。服务以 append-only 事件溯源实现：事件只追加、不改写，
服务重启后重放日志即可还原全部状态。

## 解决的问题

前一组留下的样品污染只波及两台仪器和一批耗材时，人工改线会把整个团组取消、
还会让另一组继续领用同一批耗材。本服务保证：

- **确认即五条件同时锁定**：人数、导师资格、仪器校准、耗材批次、风险分组在
  同一原子批次锁定；任一不满足整体拒绝，不产生任何预留。
- **开始后才实扣**：确认只做预留（held），活动开始后凭离线领用回执按实际领用
  扣减（checked_out）。
- **未用预留原子释放给候补**：释放与候补晋升在同一批次提交，没有“释放了却没人
  接住”的中间态；无合格候补时整批回滚。
- **污染/校准失效沿接触链定位**：根据器材-样品接触图求传递闭包，找出全部受影响
  资源与活动，**只暂停未完成节点**；已完成节点与链外团组不受影响。
- **三类恢复路线**：清洁（cleaning）、复检（reinspection）、替代（substitution）；
  替代活动必须声明目标等价关系（objective + equivalence_basis）。
- **证据可追溯**：合法证据保留来源；只有明确受污染来源影响的证据失效，且来源
  指针保留。
- **离线回执幂等**：同一回执完整重放不重复扣减；同标识异内容进入隔离，不扣减。
- **服务可恢复**：重启后从事件日志重建；恢复时按候补原截止点继续（过期/等待），
  并列出待复检资源。
- **领队可见**：每次改线保留了哪些节点、哪些证据失效、耗材余量为何变化，都可
  按改线单与团组查询。

## 代码结构

- `contracts/domain.schema.json`：领域事件信封、事件类型与聚合类型枚举。
- `src/eventStore.js`：append-only 存储；批次原子提交、event_id 幂等、内容指纹、
  日志导出/重建（`toLog` / `fromLog`）。
- `src/projection.js`：事件折叠投影（资源、预留、候补队列、接触图、证据、维护单、
  耗材台账、改线单）与接触链传递闭包 `traceContactChain`。
- `src/orchestration.js`：编排命令（确认、开始、领用、释放/候补、污染报告、
  清洁复检、替代改线、恢复）。
- `src/views.js`：只读视图（改线视图、耗材余量台账、团组视图、影响面、领队报告）。
- `src/errors.js`：稳定错误码（`ValidationRejected`、`EventConflictError`）。

## 关键事件

| 事件 | 含义 |
| --- | --- |
| `GROUP_CONFIRMED` + `RESOURCE_ALLOCATED` | 五条件锁定与原子预留（同批） |
| `ACTIVITY_STARTED` / `CHECKOUT_RECORDED` | 活动开始 / 实际领用扣减 |
| `RECEIPT_QUARANTINED` | 同标识异内容回执隔离 |
| `RESERVATION_RELEASED` + `WAITLIST_PROMOTED` | 未用预留原子转移给候补（同批） |
| `CONTAMINATION_REPORTED` / `CONTAMINATION_RECORDED` | 污染根因与接触链定位结果 |
| `SLOT_SUSPENDED` | 仅暂停未完成节点 |
| `MAINTENANCE_ORDERED` / `MAINTENANCE_COMPLETED` | 清洁/校准复检（不过保持 open） |
| `SLOT_REROUTED` | 清洁、复检或替代路线（含目标等价说明） |
| `EVIDENCE_ACCEPTED` / `EVIDENCE_INVALIDATED` | 证据采纳/失效（失效保留来源） |
| `ITINERARY_REVISED` | 一次改线的保留节点、失效证据与耗材变化 |
| `WAITLIST_EXPIRED` / `RECOVERY_COMPLETED` | 恢复后按原截止点处理候补与复检 |

## 本地检查

```bash
npm run build   # 全部源文件语法检查
npm test        # 20 个测试
```

测试覆盖：

- 五条件确认的成功与每类失败整体回滚（`tests/confirmation.test.js`）；
- 离线回执幂等/同标识异内容隔离/重启重放/候补截止点（`tests/receipt-recovery.test.js`）；
- 候补原子回滚、隔离批次禁止转候补、复检不过保持打开（`tests/atomicity-recovery.test.js`）；
- 校准失效沿接触链传播（`tests/calibration-contract.test.js`）；
- **跨馆污染发现与局部恢复完整过程重放**（`tests/contamination-recovery.test.js`）：
  前组样品 → 两仪器一耗材的接触链定位、只暂停三个未完成节点、冻结污染批次、
  拦截另一组继续领用、清洁/替代两条路线、候补原子承接、复检、服务重启重建与
  领队报告核对。

## 最小用法

```js
import { OrchestrationService, leaderReport } from "./src/index.js";

const svc = new OrchestrationService();
svc.registerConsumableLot({ lot_id: "L1", quantity: 40 });
// ...登记仪器/导师/团组/活动槽、建立接触链
svc.confirmGroup({ group_id: "G1", slot_id: "A1", headcount: 12, mentor_id: "M1", lines: [/* ... */] });
svc.startActivity({ slot_id: "A1" });
svc.recordCheckout({ receipt_id: "RC-1", slot_id: "A1", lines: [/* ... */] });

const rev = svc.reportContamination({ root_resource_id: "S1", observed_in_slot_id: "A1", revision_id: "REV-1" });
svc.completeMaintenance({ resource_id: "I1", reinspection_passed: true, calibrated_until: "2027-01-01" });
svc.rerouteSlot({ slot_id: "A1", route: "cleaning", revision_id: "REV-1", resume: true,
  objective_equivalence: { objective: "…", equivalence_basis: "…" } });

leaderReport(svc, "G1"); // 每次改线的保留节点、失效证据与耗材变化
```

## 领域边界

事件一旦被接收，其标识、发生时间与版本不应被原地改写；业务更正产生后继事件
（如同 `revision_id` 的后继 `ITINERARY_REVISED` 追加替代链接）。涉及个人、机构
或商业敏感信息时，调用方只读取完成职责所必需的字段。
