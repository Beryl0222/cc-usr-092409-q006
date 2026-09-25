/**
 * 领域错误：所有因业务规则被拒绝的命令都携带稳定 code，
 * 便于调用方区分“确认条件不满足”“同标识异内容隔离”等情况。
 */
export class DomainError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "DomainError";
    this.code = code;
    this.details = details;
  }
}

/** 事件流中已存在同 event_id 但内容不同的记录。 */
export class EventConflictError extends DomainError {
  constructor(existing, incoming) {
    super("EVENT_CONFLICT", `事件标识冲突：${incoming.event_id}`, { existing, incoming });
    this.name = "EventConflictError";
  }
}

/** 违反编排业务规则（确认条件不满足、状态机不允许等）。 */
export class ValidationRejected extends DomainError {
  constructor(code, message, details = {}) {
    super(code, message, details);
    this.name = "ValidationRejected";
  }
}
