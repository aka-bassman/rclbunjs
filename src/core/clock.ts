// Clock / ROSClock backed by rcl_clock_t, including rcl time-jump callbacks.
import { FFIType, JSCallback, type Pointer } from "bun:ffi";
import { lib } from "../native/loader.ts";
import { check, lastError } from "../native/ffi.ts";
import { Context } from "./context.ts";
import { NativeError, OperationError, TypeValidationError } from "./errors.ts";
import { ClockType, Duration, Time } from "./time.ts";

/** Kind of change reported to a clock jump callback (rcl_clock_change_t). */
export enum ClockChange {
  ROS_TIME_NO_CHANGE = 1,
  ROS_TIME_ACTIVATED = 2,
  ROS_TIME_DEACTIVATED = 3,
  SYSTEM_TIME_NO_CHANGE = 4,
}

export interface JumpInfo {
  clock_change: ClockChange;
  /** jump size in nanoseconds */
  delta: bigint;
}

/** Callback object accepted by {@link Clock.addClockCallback} (same shape as rclnodejs). */
export interface ClockCallbackObject {
  _pre_callback?: () => void;
  _post_callback?: (info: JumpInfo) => void;
}

// Every rcl jump callback goes through one native trampoline, which calls this
// handler with the registration id.
const jumpCallbacks = new Map<number, ClockCallbackObject>();
let nextJumpId = 1;
let jumpHandler: JSCallback | undefined;

function ensureJumpHandler(): void {
  if (jumpHandler) return;
  jumpHandler = new JSCallback(
    (id: number, before: number, change: number, delta: bigint | number) => {
      const obj = jumpCallbacks.get(id);
      if (!obj) return;
      try {
        if (before) obj._pre_callback?.();
        else obj._post_callback?.({ clock_change: change, delta: BigInt(delta) });
      } catch (e) {
        console.error(`rclbunjs: clock jump callback threw: ${String(e)}`);
      }
    },
    { args: [FFIType.i32, FFIType.i32, FFIType.i32, FFIType.i64], returns: FFIType.void },
  );
  lib.rb_set_jump_handler(jumpHandler.ptr as Pointer);
}

interface ClockState {
  handle: Pointer;
  jumpIds: Set<number>;
}

const finalizer = new FinalizationRegistry<ClockState>((s) => {
  for (const id of s.jumpIds) jumpCallbacks.delete(id);
  lib.rb_clock_fini(s.handle);
});

export class Clock {
  static ClockType = ClockType;

  /** @internal */
  readonly handle: Pointer;
  readonly clockType: ClockType;
  #jumpIds = new Map<ClockCallbackObject, number>();
  #state: ClockState;

  constructor(clockType: ClockType = ClockType.SYSTEM_TIME) {
    this.clockType = clockType;
    this.handle = check(lib.rb_clock_init(clockType), "rcl_clock_init");
    this.#state = { handle: this.handle, jumpIds: new Set() };
    finalizer.register(this, this.#state);
  }

  now(): Time {
    const ns = lib.rb_clock_now(this.handle);
    if (ns === -(2n ** 63n)) throw new NativeError(`clock now: ${lastError()}`);
    return Time.fromNanoseconds(ns, this.clockType);
  }

  /**
   * Registers callbacks that run around time jumps of this clock. rcl only
   * reports jumps for ROS_TIME clocks: when ROS time is activated/deactivated
   * (`onClockChange`) or its override moves by at least `minForward` or by at
   * most `minBackward` (a negative value; 0 disables it).
   */
  addClockCallback(callbackObject: ClockCallbackObject, onClockChange: boolean, minForward: bigint, minBackward: bigint): void {
    if (typeof callbackObject !== "object" || callbackObject === null) {
      throw new TypeValidationError("addClockCallback: callbackObject must be an object");
    }
    if (typeof onClockChange !== "boolean") throw new TypeValidationError("addClockCallback: onClockChange must be a boolean");
    if (typeof minForward !== "bigint" || typeof minBackward !== "bigint") {
      throw new TypeValidationError("addClockCallback: minForward/minBackward must be bigint nanoseconds");
    }
    if (this.#jumpIds.has(callbackObject)) throw new OperationError("callback object is already registered on this clock");
    ensureJumpHandler();
    const id = nextJumpId++;
    jumpCallbacks.set(id, callbackObject);
    if (lib.rb_clock_add_jump_callback(this.handle, id, onClockChange ? 1 : 0, minForward, minBackward) !== 0) {
      jumpCallbacks.delete(id);
      throw new NativeError(`add clock callback: ${lastError()}`);
    }
    this.#jumpIds.set(callbackObject, id);
    this.#state.jumpIds.add(id);
  }

  removeClockCallback(callbackObject: ClockCallbackObject): void {
    const id = this.#jumpIds.get(callbackObject);
    if (id === undefined) throw new OperationError("callback object is not registered on this clock");
    this.#jumpIds.delete(callbackObject);
    this.#state.jumpIds.delete(id);
    jumpCallbacks.delete(id);
    if (lib.rb_clock_remove_jump_callback(this.handle, id) !== 0) {
      throw new NativeError(`remove clock callback: ${lastError()}`);
    }
  }

  /**
   * Sleeps until `until` is reached on this clock. Resolves false if ROS time
   * is activated or deactivated meanwhile, or if `context` shuts down.
   */
  async sleepUntil(until: Time, context?: Context): Promise<boolean> {
    if (!(until instanceof Time)) throw new TypeValidationError("sleepUntil: until must be a Time");
    if (until.clockType !== this.clockType) throw new TypeError("until's clock type does not match this clock's type");
    const ctx = context ?? defaultContextIfValid();
    if (ctx && !ctx.isValid()) throw new OperationError("Context is not initialized or has been shut down");

    const event = new ClockEvent();
    let sourceChanged = false;
    const cb: ClockCallbackObject = {
      _post_callback: (j) => {
        sourceChanged ||= j.clock_change === ClockChange.ROS_TIME_ACTIVATED || j.clock_change === ClockChange.ROS_TIME_DEACTIVATED;
        if (sourceChanged || this.now().nanoseconds >= until.nanoseconds) event.set();
      },
    };
    this.addClockCallback(cb, true, 1n, 0n);
    try {
      await event.waitUntil(this, until.nanoseconds, ctx);
    } finally {
      this.removeClockCallback(cb);
    }
    if ((ctx && !ctx.isValid()) || sourceChanged) return false;
    return this.now().nanoseconds >= until.nanoseconds;
  }

  sleepFor(duration: Duration, context?: Context): Promise<boolean> {
    return this.sleepUntil(this.now().add(duration), context);
  }
}

function defaultContextIfValid(): Context | undefined {
  const ctx = Context.defaultContext();
  return ctx.isValid() ? ctx : undefined;
}

export class ROSClock extends Clock {
  constructor() {
    super(ClockType.ROS_TIME);
  }

  get isRosTimeActive(): boolean {
    return lib.rb_clock_ros_time_override_enabled(this.handle) === 1;
  }

  set isRosTimeActive(enabled: boolean) {
    if (lib.rb_clock_enable_ros_time_override(this.handle, enabled ? 1 : 0) !== 0) {
      throw new NativeError(`ros time override: ${lastError()}`);
    }
  }

  /** Sets the ROS time value used while ROS time is active. */
  set rosTimeOverride(t: Time) {
    if (!(t instanceof Time)) throw new TypeValidationError("rosTimeOverride must be a Time");
    if (lib.rb_clock_set_ros_time_override(this.handle, t.nanoseconds) !== 0) {
      throw new NativeError(`ros time override: ${lastError()}`);
    }
  }
}

/** A settable event that can also wait for a clock to reach a time. */
export class ClockEvent {
  #set = false;
  #waiters: (() => void)[] = [];

  isSet(): boolean {
    return this.#set;
  }

  set(): void {
    this.#set = true;
    for (const w of this.#waiters.splice(0)) w();
  }

  clear(): void {
    this.#set = false;
  }

  /**
   * Resolves once the event is set, `clock` reaches `until` (ns) or `context`
   * shuts down. While ROS time is active the clock only moves by jumps, which
   * {@link Clock.sleepUntil} turns into `set()`.
   */
  async waitUntil(clock: Clock, until: bigint, context?: Context): Promise<void> {
    while (!this.#set) {
      if (context && !context.isValid()) return;
      const remaining = until - clock.now().nanoseconds;
      if (remaining <= 0n) return;
      const rosActive = clock instanceof ROSClock && clock.isRosTimeActive;
      // cap the wait so a context shutdown is noticed promptly
      const ms = rosActive ? 100 : Math.min(Number(remaining / 1_000_000n) + 1, 100);
      await new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(timer);
          const i = this.#waiters.indexOf(done);
          if (i >= 0) this.#waiters.splice(i, 1);
          resolve();
        };
        const timer = setTimeout(done, ms);
        this.#waiters.push(done);
      });
    }
  }

  waitUntilSteady(clock: Clock, until: bigint): Promise<void> {
    return this.waitUntil(clock, until);
  }

  waitUntilSystem(clock: Clock, until: bigint): Promise<void> {
    return this.waitUntil(clock, until);
  }

  waitUntilRos(clock: Clock, until: bigint): Promise<void> {
    return this.waitUntil(clock, until);
  }
}
