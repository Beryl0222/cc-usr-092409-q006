import { createHash } from "node:crypto";

import { EventConflictError } from "./errors.js";

/**
 * 规范化内容指纹：event_id 相同的两次写入必须携带相同内容。
 * version 由存储按聚合单调分配，不参与内容比较（离线回执重放时服务端版本号可能不同）。
 */
export function canonicalFingerprint(event) {
  const { version: _version, ...body } = event;
  const walk = (value) => {
    if (Array.isArray(value)) return value.map(walk);
    if (value && typeof value === "object") {
      return Object.keys(value)
        .sort()
        .reduce((acc, key) => {
          acc[key] = walk(value[key]);
          return acc;
        }, {});
    }
    return value;
  };
  return createHash("sha256").update(JSON.stringify(walk(body))).digest("hex");
}

/**
 * Append-only 事件存储。
 * - 事件只追加，不改写；业务更正必须产生后继事件。
 * - appendBatch 原子提交：批次内任一事件不合法则整批不写入。
 * - 同一 event_id 重复写入且内容一致 → 幂等跳过（用于离线回执完全重放）。
 * - 同一 event_id 内容不同 → 抛出 EventConflictError，由上层登记隔离。
 * - version 按 aggregate_id 各自单调递增分配。
 */
export class EventStore {
  constructor() {
    this._events = [];
    this._index = new Map(); // event_id -> 已落库事件
    this._versions = new Map(); // aggregate_id -> 当前版本
  }

  get size() {
    return this._events.length;
  }

  events() {
    return this._events.slice();
  }

  eventsForAggregate(aggregateId) {
    return this._events.filter((e) => e.aggregate_id === aggregateId);
  }

  hasEvent(eventId) {
    return this._index.has(eventId);
  }

  getEvent(eventId) {
    return this._index.get(eventId);
  }

  nextVersion(aggregateId) {
    return (this._versions.get(aggregateId) ?? 0) + 1;
  }

  /**
   * @param {Array<object>} incoming 尚未分配 version 的事件草稿（须含 event_id）
   * @returns {{appended: Array, deduplicated: Array}}
   */
  appendBatch(incoming) {
    const appended = [];
    const deduplicated = [];
    const staged = [];
    const stagedIds = new Set();

    for (const draft of incoming) {
      if (!draft || typeof draft !== "object") throw new TypeError("事件必须是对象");
      for (const field of ["event_id", "event_type", "aggregate_type", "aggregate_id", "occurred_at", "summary"]) {
        if (!draft[field]) throw new TypeError(`事件缺少字段：${field}`);
      }
      if (stagedIds.has(draft.event_id)) {
        throw new EventConflictError(null, draft);
      }
      stagedIds.add(draft.event_id);

      const existing = this._index.get(draft.event_id);
      if (existing) {
        if (canonicalFingerprint(existing) !== canonicalFingerprint(draft)) {
          throw new EventConflictError(existing, draft);
        }
        deduplicated.push(existing);
        continue;
      }
      staged.push(draft);
    }

    for (const draft of staged) {
      const version = (this._versions.get(draft.aggregate_id) ?? 0) + 1;
      const event = { ...draft, version };
      this._versions.set(draft.aggregate_id, version);
      this._index.set(event.event_id, event);
      this._events.push(event);
      appended.push(event);
    }

    return { appended, deduplicated };
  }

  appendOne(event) {
    return this.appendBatch([event]);
  }

  /** 导出完整事件日志（用于服务重启后重放恢复）。 */
  toLog() {
    return this._events.map((e) => ({ ...e }));
  }

  /** 从历史事件日志重建存储：按原顺序重新落库，保留原 version。 */
  static fromLog(events) {
    const store = new EventStore();
    for (const event of events) {
      if (store._index.has(event.event_id)) continue;
      store._index.set(event.event_id, event);
      store._events.push(event);
      const current = store._versions.get(event.aggregate_id) ?? 0;
      if (event.version > current) store._versions.set(event.aggregate_id, event.version);
    }
    return store;
  }
}
