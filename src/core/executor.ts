// Per-node executor: a shim thread blocks in rcl_wait and wakes the JS thread
// through a threadsafe JSCallback; JS then runs the ready callbacks and re-arms.
import { FFIType, JSCallback, ptr, toArrayBuffer, type Pointer } from "bun:ffi";
import { lib } from "../native/loader.ts";
import { check, lastError } from "../native/ffi.ts";
import { NativeError, OperationError } from "./errors.ts";

/** Something that sits in a wait set. */
export interface Waitable {
  /** @internal native rcl entity pointer (first member of the shim struct) */
  readonly handle: Pointer;
  /** @internal called on the JS thread when rcl_wait reported it ready */
  execute(): void;
  isDestroyed(): boolean;
}

export interface WaitableSets {
  subscriptions: Waitable[];
  guards: Waitable[];
  timers: Waitable[];
  clients: Waitable[];
  services: Waitable[];
  events: Waitable[];
}

const KINDS = ["subscriptions", "guards", "timers", "clients", "services", "events"] as const;
// Dispatch order (matches rclnodejs): timers, events, subscriptions, guards, clients, services
const ORDER = [2, 5, 0, 1, 3, 4];

function pack(sets: WaitableSets): { packed: BigUint64Array; flat: Waitable[][] } {
  const flat = KINDS.map((k) => sets[k].filter((w) => !w.isDestroyed()));
  const total = flat.reduce((n, l) => n + l.length, 0);
  const packed = new BigUint64Array(KINDS.length + total);
  let i = 0;
  for (const list of flat) {
    packed[i++] = BigInt(list.length);
    for (const w of list) packed[i++] = BigInt(w.handle as unknown as number);
  }
  return { packed, flat };
}

function dispatch(flat: Waitable[][], ready: Uint8Array, errors: unknown[]): void {
  const offsets: number[] = [];
  let o = 0;
  for (const l of flat) {
    offsets.push(o);
    o += l.length;
  }
  for (const k of ORDER) {
    const list = flat[k]!;
    for (let i = 0; i < list.length; i++) {
      if (!ready[offsets[k]! + i]) continue;
      const w = list[i]!;
      if (w.isDestroyed()) continue;
      try {
        w.execute();
      } catch (e) {
        errors.push(e);
      }
    }
  }
}

export class Executor {
  #ctx: () => Pointer | null;
  #collect: () => WaitableSets;
  #exec: Pointer | null = null;
  #cb: JSCallback | null = null;
  #armed = false;
  #spinning = false;
  #destroyed = false;
  #flat: Waitable[][] = [];
  #packed: BigUint64Array | null = null;
  #keepAlive: ReturnType<typeof setInterval> | null = null;

  constructor(context: () => Pointer | null, collect: () => WaitableSets) {
    this.#ctx = context;
    this.#collect = collect;
  }

  get spinning(): boolean {
    return this.#spinning;
  }

  start(): void {
    if (this.#spinning) throw new OperationError("The node is already spinning");
    const ctx = this.#ctx();
    if (!ctx) throw new OperationError("context is not initialized");
    if (!this.#exec) {
      this.#cb = new JSCallback((code: number) => this.#onReady(code), {
        args: [FFIType.i32],
        returns: FFIType.void,
        threadsafe: true,
      });
      // pass the raw function pointer: handing bun:ffi the JSCallback object yields NULL here
      this.#exec = check(lib.rb_exec_create(ctx, this.#cb.ptr as Pointer), "executor create");
    }
    this.#spinning = true;
    this.#keepAlive ??= setInterval(() => {}, 1 << 30);
    this.#arm();
  }

  stop(): void {
    this.#spinning = false;
    if (this.#keepAlive) clearInterval(this.#keepAlive);
    this.#keepAlive = null;
    if (this.#exec && this.#armed) lib.rb_exec_interrupt(this.#exec);
  }

  /** Entity set changed: make the waiting thread pick it up. */
  notify(): void {
    if (this.#exec && this.#armed) lib.rb_exec_interrupt(this.#exec);
  }

  /** Must be called before finalizing an entity that may be in the wait set. */
  quiesce(): void {
    if (this.#exec && this.#armed) lib.rb_exec_interrupt_sync(this.#exec);
  }

  /** Waits (blocking the JS thread) up to `timeoutNs` and runs ready callbacks once. */
  spinOnce(timeoutNs: bigint): void {
    if (this.#spinning) throw new OperationError("The node is already spinning");
    const ctx = this.#ctx();
    if (!ctx) throw new OperationError("context is not initialized");
    const { packed, flat } = pack(this.#collect());
    const total = packed.length - KINDS.length;
    const ready = new Uint8Array(Math.max(total, 1));
    const rc = lib.rb_wait_sync(ctx, ptr(packed), timeoutNs, ptr(ready));
    if (rc < 0) throw new NativeError(`rcl_wait: ${lastError()}`);
    if (rc !== 0) return;
    const errors: unknown[] = [];
    dispatch(flat, ready, errors);
    if (errors.length) throw errors[0];
  }

  destroy(): void {
    if (this.#destroyed) return;
    this.stop();
    this.#destroyed = true;
    if (this.#exec) {
      lib.rb_exec_destroy(this.#exec);
      this.#exec = null;
    }
    // Calls already queued by the thread may still arrive; keep the callback
    // alive briefly so they hit the #destroyed guard instead of freed memory.
    const cb = this.#cb;
    this.#cb = null;
    if (cb) setTimeout(() => cb.close(), 1000).unref();
  }

  #arm(): void {
    if (!this.#spinning || this.#armed || this.#destroyed || !this.#exec) return;
    const { packed, flat } = pack(this.#collect());
    this.#packed = packed;
    this.#flat = flat;
    if (lib.rb_exec_arm(this.#exec, ptr(packed), -1n) !== 0) {
      throw new NativeError(`executor arm: ${lastError()}`);
    }
    this.#armed = true;
  }

  #onReady(code: number): void {
    this.#armed = false;
    if (this.#destroyed || !this.#exec) return;
    const errors: unknown[] = [];
    if (code === 0) {
      const total = this.#flat.reduce((n, l) => n + l.length, 0);
      if (total > 0) {
        const ready = new Uint8Array(toArrayBuffer(lib.rb_exec_ready_ptr(this.#exec)!, 0, total));
        dispatch(this.#flat, ready, errors);
      }
    } else if (code < 0) {
      errors.push(new NativeError(`rcl_wait failed: ${lastError()}`));
    }
    try {
      this.#arm();
    } catch (e) {
      errors.push(e);
    }
    void this.#packed;
    for (const e of errors) {
      queueMicrotask(() => {
        throw e;
      });
    }
  }
}
