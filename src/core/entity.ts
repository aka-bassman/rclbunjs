// Shared bits of node-owned entities.
import type { Pointer } from "bun:ffi";
import { OperationError } from "./errors.ts";
import type { QoS } from "./qos.ts";

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
