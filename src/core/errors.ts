// Error hierarchy mirroring rclnodejs (lib/errors.js).

export interface RclErrorOptions {
  code?: string;
  nodeName?: string;
  entityType?: string;
  entityName?: string;
  details?: unknown;
  cause?: unknown;
}

export class RclNodeError extends Error {
  code: string;
  nodeName?: string;
  entityType?: string;
  entityName?: string;
  details?: unknown;
  timestamp: Date;

  constructor(message: string, options: RclErrorOptions = {}) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = new.target.name;
    this.code = options.code ?? "UNKNOWN_ERROR";
    this.nodeName = options.nodeName;
    this.entityType = options.entityType;
    this.entityName = options.entityName;
    this.details = options.details;
    this.timestamp = new Date();
  }
}

function sub(code: string, base: typeof RclNodeError = RclNodeError) {
  return class extends base {
    constructor(message: string, options: RclErrorOptions = {}) {
      super(message, { code, ...options });
    }
  };
}

export class ValidationError extends sub("VALIDATION_ERROR") {}
export class TypeValidationError extends sub("INVALID_TYPE", ValidationError) {}
export class RangeValidationError extends sub("OUT_OF_RANGE", ValidationError) {}
/** Raised by assertValidMessage; carries the individual issues (rclnodejs shape). */
export class MessageValidationError extends ValidationError {
  readonly messageType: string;
  readonly issues: { field: string; problem: string }[];

  constructor(messageType: string, issues: { field: string; problem: string }[], options: RclErrorOptions = {}) {
    super(`Invalid message for '${messageType}': ${issues.map((i) => `${i.field}: ${i.problem}`).join(", ")}`, {
      code: "MESSAGE_VALIDATION_ERROR",
      entityType: "message",
      entityName: messageType,
      details: { messageType, issues },
      ...options,
    });
    this.messageType = messageType;
    this.issues = issues;
  }

  getIssuesByType(problem: string): { field: string; problem: string }[] {
    return this.issues.filter((i) => i.problem === problem);
  }

  hasFieldIssue(field: string): boolean {
    return this.issues.some((i) => i.field === field);
  }
}
export class NameValidationError extends sub("INVALID_NAME", ValidationError) {}
export class OperationError extends sub("OPERATION_ERROR") {}
export class TimeoutError extends sub("TIMEOUT", OperationError) {}
export class AbortError extends sub("ABORTED", OperationError) {}
export class ServiceNotFoundError extends sub("SERVICE_NOT_FOUND", OperationError) {}
export class NodeNotFoundError extends sub("NODE_NOT_FOUND", OperationError) {}
export class ParameterError extends sub("PARAMETER_ERROR") {}
export class ParameterNotFoundError extends sub("PARAMETER_NOT_FOUND", ParameterError) {}
export class ParameterTypeError extends sub("PARAMETER_TYPE_MISMATCH", ParameterError) {}
export class ReadOnlyParameterError extends sub("PARAMETER_READ_ONLY", ParameterError) {}
export class TopicError extends sub("TOPIC_ERROR") {}
export class PublisherError extends sub("PUBLISHER_ERROR", TopicError) {}
export class SubscriptionError extends sub("SUBSCRIPTION_ERROR", TopicError) {}
export class ActionError extends sub("ACTION_ERROR") {}
export class GoalRejectedError extends sub("GOAL_REJECTED", ActionError) {}
export class ActionServerNotFoundError extends sub("ACTION_SERVER_NOT_FOUND", ActionError) {}
export class NativeError extends sub("NATIVE_ERROR") {}
export class InterfaceNotFoundError extends sub("INTERFACE_NOT_FOUND", ValidationError) {}
