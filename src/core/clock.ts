// Clock / ROSClock backed by rcl_clock_t.
import type { Pointer } from "bun:ffi";
import { lib } from "../native/loader.ts";
import { check, lastError } from "../native/ffi.ts";
import { NativeError } from "./errors.ts";
import { ClockType, Duration, Time } from "./time.ts";

const finalizer = new FinalizationRegistry<Pointer>((h) => lib.rb_clock_fini(h));

export class Clock {
  /** @internal */
  readonly handle: Pointer;
  readonly clockType: ClockType;

  constructor(clockType: ClockType = ClockType.SYSTEM_TIME) {
    this.clockType = clockType;
    this.handle = check(lib.rb_clock_init(clockType), "rcl_clock_init");
    finalizer.register(this, this.handle);
  }

  now(): Time {
    const ns = lib.rb_clock_now(this.handle);
    if (ns === -(2n ** 63n)) throw new NativeError(`clock now: ${lastError()}`);
    return Time.fromNanoseconds(ns, this.clockType);
  }

  /** Resolves true once `until` is reached on this clock (polled for ROS time). */
  async sleepUntil(until: Time): Promise<boolean> {
    if (until.clockType !== this.clockType) throw new TypeError("sleepUntil: clock type mismatch");
    for (;;) {
      const remaining = until.nanoseconds - this.now().nanoseconds;
      if (remaining <= 0n) return true;
      const ms = Number(remaining / 1_000_000n);
      await Bun.sleep(this.clockType === ClockType.ROS_TIME ? Math.min(ms, 10) : Math.max(ms, 0));
    }
  }

  sleepFor(d: Duration): Promise<boolean> {
    return this.sleepUntil(this.now().add(d));
  }
}

export class ROSClock extends Clock {
  constructor() {
    super(ClockType.ROS_TIME);
  }

  get isRosTimeActive(): boolean {
    return lib.rb_clock_ros_time_override_enabled(this.handle) === 1;
  }

  set isRosTimeActive(enabled: boolean) {
    if (enabled === this.isRosTimeActive) return;
    const now = enabled ? 0n : 0n;
    if (lib.rb_clock_set_ros_time_override(this.handle, enabled ? 1 : 0, now) !== 0) {
      throw new NativeError(`ros time override: ${lastError()}`);
    }
  }

  set rosTimeOverride(t: Time) {
    if (lib.rb_clock_set_ros_time_override(this.handle, 1, t.nanoseconds) !== 0) {
      throw new NativeError(`ros time override: ${lastError()}`);
    }
  }
}
