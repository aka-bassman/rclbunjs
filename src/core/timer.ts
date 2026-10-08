import type { Pointer } from "bun:ffi";
import { lib } from "../native/loader.ts";
import { check, checkRc } from "../native/ffi.ts";
import type { Clock } from "./clock.ts";
import { Entity } from "./entity.ts";
import { RangeValidationError } from "./errors.ts";
import type { Waitable } from "./executor.ts";

export interface TimerInfo {
  expectedCallTime: bigint;
  actualCallTime: bigint;
}

// out-parameter for rb_timer_call: [expected_call_time, actual_call_time]
const callInfo = new BigInt64Array(2);

export class Timer extends Entity implements Waitable {
  readonly clock: Clock;
  readonly #callback: (info?: TimerInfo) => void;
  #onReset: ((resets: number) => void) | undefined;
  #pendingResets = 0;

  /** @internal */
  constructor(contextHandle: Pointer, clock: Clock, period: bigint, callback: (info?: TimerInfo) => void, autostart: boolean) {
    if (typeof period !== "bigint" || period < 0n) throw new RangeValidationError("timer period must be a non-negative bigint (ns)");
    super(check(lib.rb_timer_init(contextHandle, clock.handle, period, autostart ? 1 : 0), "create timer"), {});
    this.clock = clock;
    this.#callback = callback;
  }

  get period(): bigint {
    return lib.rb_timer_period(this.handle);
  }

  get timerPeriod(): bigint {
    return this.period;
  }

  changeTimerPeriod(period: bigint): void {
    checkRc(lib.rb_timer_change_period(this.handle, period), "change timer period");
  }

  isReady(): boolean {
    return this.timeUntilNextCall() <= 0n && !this.isCanceled();
  }

  isCanceled(): boolean {
    return lib.rb_timer_is_canceled(this.handle) === 1;
  }

  cancel(): void {
    lib.rb_timer_cancel(this.handle);
  }

  reset(): void {
    lib.rb_timer_reset(this.handle);
    if (this.#onReset) this.#onReset(1);
    else this.#pendingResets++;
  }

  /**
   * Calls `callback(n)` whenever the timer is reset. Resets that happened while
   * no callback was set are reported at once (rcl_timer_set_on_reset_callback
   * semantics).
   */
  setOnResetCallback(callback: (resets: number) => void): void {
    this.#onReset = callback;
    if (this.#pendingResets > 0) {
      const n = this.#pendingResets;
      this.#pendingResets = 0;
      callback(n);
    }
  }

  clearOnResetCallback(): void {
    this.#onReset = undefined;
  }

  /**
   * Records a call if the timer is ready and returns its expected and actual
   * call times; undefined when the timer was not ready or is canceled.
   */
  callTimerWithInfo(): TimerInfo | undefined {
    const rc = checkRc(lib.rb_timer_call(this.handle, callInfo), "timer call");
    return rc === 1 ? { expectedCallTime: callInfo[0]!, actualCallTime: callInfo[1]! } : undefined;
  }

  timeSinceLastCall(): bigint {
    return lib.rb_timer_time_since_last_call(this.handle);
  }

  /** Nanoseconds until the next call; null when canceled. */
  timeUntilNextCall(): bigint {
    return lib.rb_timer_time_until_next_call(this.handle);
  }

  getNextCallTime(): bigint | null {
    if (this.isCanceled()) return null;
    return this.clock.now().nanoseconds + this.timeUntilNextCall();
  }

  /** @internal */
  execute(): void {
    if (this.isDestroyed()) return;
    const info = this.callTimerWithInfo();
    if (info) this.#callback(info);
  }

  /** @internal */
  _fini(): void {
    if (this.isDestroyed()) return;
    this.markDestroyed();
    lib.rb_timer_fini(this.handle);
  }
}

export class GuardCondition extends Entity implements Waitable {
  readonly #callback: () => unknown;

  /** @internal */
  constructor(contextHandle: Pointer, callback: () => unknown) {
    super(check(lib.rb_guard_init(contextHandle), "create guard condition"), {});
    this.#callback = callback;
  }

  trigger(): void {
    this.assertAlive();
    lib.rb_guard_trigger(this.handle);
  }

  /** @internal */
  execute(): void {
    this.#callback();
  }

  /** @internal */
  _fini(): void {
    if (this.isDestroyed()) return;
    this.markDestroyed();
    lib.rb_guard_fini(this.handle);
  }
}

/** Fixed-frequency sleeper (wall/steady time based). */
export class Rate {
  readonly frequency: number;
  #periodMs: number;
  #next: number;
  #canceled = false;

  constructor(hz: number) {
    if (!(hz > 0 && hz <= 1000)) throw new RangeValidationError("rate must be in (0, 1000] Hz");
    this.frequency = hz;
    this.#periodMs = 1000 / hz;
    this.#next = performance.now() + this.#periodMs;
  }

  async sleep(): Promise<void> {
    if (this.#canceled) throw new Error("Rate has been canceled");
    const now = performance.now();
    // if we fell behind by more than a period, re-anchor instead of bursting
    if (now - this.#next > this.#periodMs) this.#next = now;
    const wait = this.#next - now;
    this.#next += this.#periodMs;
    if (wait > 0) await Bun.sleep(wait);
  }

  cancel(): void {
    this.#canceled = true;
  }

  isCanceled(): boolean {
    return this.#canceled;
  }
}
