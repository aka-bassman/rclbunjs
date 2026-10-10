// Shared bits of node-owned entities.
import type { Pointer } from "bun:ffi";
import { OperationError } from "./errors.ts";
import type { QoS } from "./qos.ts";
import type { QoSOverridingOptions } from "./qos_overriding_options.ts";
import type { MessageValidationOptions } from "./message_validation.ts";

/** Converts typed arrays to plain arrays (rclnodejs 'plain' mode / enableTypedArray:false). */
export function toPlain(v: unknown): unknown {
  if (ArrayBuffer.isView(v) && !(v instanceof DataView)) return Array.from(v as unknown as ArrayLike<unknown>);
  if (Array.isArray(v)) return v.map(toPlain);
  if (v && typeof v === "object") {
    const o: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) o[k] = toPlain(x);
    return o;
  }
  return v;
}

/** JSON-safe form: bigint -> string (or number when safe), NaN/Infinity -> strings, typed arrays -> arrays. */
export function toJSONSafe(v: unknown): unknown {
  if (typeof v === "bigint") return Number.isSafeInteger(Number(v)) ? Number(v) : v.toString();
  if (typeof v === "number" && !Number.isFinite(v)) return String(v);
  if (ArrayBuffer.isView(v) && !(v instanceof DataView)) return Array.from(v as unknown as ArrayLike<unknown>, toJSONSafe);
  if (Array.isArray(v)) return v.map(toJSONSafe);
  if (v && typeof v === "object") {
    const o: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) o[k] = toJSONSafe(x);
    return o;
  }
  return v;
}

export function toJSONString(v: unknown, space?: number): string {
  return JSON.stringify(toJSONSafe(v), null, space);
}

export type SerializationMode = "default" | "plain" | "json";

export interface EntityOptions {
  qos?: QoS | string;
  enableTypedArray?: boolean;
  isRaw?: boolean;
  serializationMode?: SerializationMode;
  /**
   * Subscriptions: copy each message once and decode numeric arrays as views
   * into that copy (faster for large arrays; `array.buffer` is then the whole
   * message). Default false.
   */
  zeroCopy?: boolean;
  /**
   * Subscriptions: deliver each message as a view over C memory instead of a
   * decoded object, taken as a middleware loan when possible (Fast DDS with
   * fixed-size types and ROS_DISABLE_LOANED_MESSAGES=0), otherwise with
   * rcl_take into a reused C message. The view is valid only during the
   * synchronous part of the callback; use `msg.toObject()` to keep data.
   * Fixed-size message types only. Default false.
   */
  loanedMessages?: boolean;
  /**
   * Publishers (borrowLoanedMessage) and loanedMessages subscriptions: keep one
   * view per message memory instead of detaching it after each message. Faster
   * for large messages (no garbage-collector pressure per message), but a view or
   * array used after its callback, publish or return is no longer caught: it
   * reads or writes whatever that memory holds by then, and can crash the
   * process once the publisher or subscription is destroyed. Default false.
   */
  reuseViews?: boolean;
  /** Publishers: validate every published message (see validateMessage). Default false. */
  validateMessages?: boolean;
  /** Clients: validate every request. Default false. */
  validateRequests?: boolean;
  /** Options for those validations (default { strict: true, checkTypes: true }). */
  validationOptions?: MessageValidationOptions;
  /** Publishers/subscriptions: declare `qos_overrides.*` parameters that can override the QoS. */
  qosOverridingOptions?: QoSOverridingOptions;
  [k: string]: unknown;
}

export function convertForDelivery(msg: unknown, opts: { enableTypedArray?: boolean; serializationMode?: SerializationMode }): unknown {
  const mode = opts.serializationMode ?? "default";
  if (mode === "json") return toJSONSafe(msg);
  if (mode === "plain" || opts.enableTypedArray === false) return toPlain(msg);
  return msg;
}

export abstract class Entity {
  /** @internal */
  handle: Pointer;
  #destroyed = false;
  readonly options: EntityOptions;

  constructor(handle: Pointer, options: EntityOptions) {
    this.handle = handle;
    this.options = options;
  }

  isDestroyed(): boolean {
    return this.#destroyed;
  }

  get typedArrayEnabled(): boolean {
    return this.options.enableTypedArray !== false;
  }

  /** @internal */
  protected markDestroyed(): void {
    this.#destroyed = true;
  }

  protected assertAlive(): void {
    if (this.#destroyed) throw new OperationError(`${this.constructor.name} has been destroyed`);
  }

  /** @internal releases native resources; called by the owning node */
  abstract _fini(): void;
}
