// Time and Duration (bigint nanoseconds), mirroring rclnodejs lib/time.js and lib/duration.js.
import { RangeValidationError, TypeValidationError } from "./errors.ts";

export enum ClockType {
  ROS_TIME = 1,
  SYSTEM_TIME = 2,
  STEADY_TIME = 3,
}

const NS = 1_000_000_000n;
const MAX = 2n ** 63n - 1n;

const asBig = (v: unknown, what: string): bigint => {
  if (typeof v === "bigint") return v;
  if (typeof v === "number" && Number.isInteger(v)) return BigInt(v);
  throw new TypeValidationError(`${what} must be a bigint`);
};

export class Duration {
  readonly nanoseconds: bigint;

  constructor(seconds: bigint | number = 0n, nanoseconds: bigint | number = 0n) {
    const total = asBig(seconds, "seconds") * NS + asBig(nanoseconds, "nanoseconds");
    if (total > MAX || total < -MAX - 1n) throw new RangeValidationError("Duration out of range");
    this.nanoseconds = total;
  }

  static fromNanoseconds(ns: bigint): Duration {
    return new Duration(0n, ns);
  }

  static fromMsg(msg: { sec: number; nanosec: number }): Duration {
    return new Duration(BigInt(msg.sec), BigInt(msg.nanosec));
  }

  toMsg(): { sec: number; nanosec: number } {
    const sec = this.nanoseconds / NS;
    let rem = this.nanoseconds % NS;
    let s = sec;
    if (rem < 0n) {
      rem += NS;
      s -= 1n;
    }
    return { sec: Number(s), nanosec: Number(rem) };
  }

  eq(o: Duration) { return this.nanoseconds === o.nanoseconds; }
  ne(o: Duration) { return this.nanoseconds !== o.nanoseconds; }
  lt(o: Duration) { return this.nanoseconds < o.nanoseconds; }
  lte(o: Duration) { return this.nanoseconds <= o.nanoseconds; }
  gt(o: Duration) { return this.nanoseconds > o.nanoseconds; }
  gte(o: Duration) { return this.nanoseconds >= o.nanoseconds; }
}

export class Time {
  readonly nanoseconds: bigint;
  readonly clockType: ClockType;

  constructor(seconds: bigint | number = 0n, nanoseconds: bigint | number = 0n, clockType: ClockType = ClockType.SYSTEM_TIME) {
    const total = asBig(seconds, "seconds") * NS + asBig(nanoseconds, "nanoseconds");
    if (total < 0n) throw new RangeValidationError("Time must be non-negative");
    if (total > MAX) throw new RangeValidationError("Time out of range");
    this.nanoseconds = total;
    this.clockType = clockType;
  }

  static fromNanoseconds(ns: bigint, clockType: ClockType = ClockType.SYSTEM_TIME): Time {
    return new Time(0n, ns, clockType);
  }

  get secondsAndNanoseconds(): { seconds: bigint; nanoseconds: bigint } {
    return { seconds: this.nanoseconds / NS, nanoseconds: this.nanoseconds % NS };
  }

  add(d: Duration): Time {
    if (!(d instanceof Duration)) throw new TypeValidationError("Time.add expects a Duration");
    return new Time(0n, this.nanoseconds + d.nanoseconds, this.clockType);
  }

  sub(o: Time): Duration;
  sub(o: Duration): Time;
  sub(o: Time | Duration): Duration | Time {
    if (o instanceof Time) {
      if (o.clockType !== this.clockType) throw new TypeValidationError("cannot subtract times of different clock types");
      return new Duration(0n, this.nanoseconds - o.nanoseconds);
    }
    return new Time(0n, this.nanoseconds - o.nanoseconds, this.clockType);
  }

  #check(o: Time) {
    if (!(o instanceof Time)) throw new TypeValidationError("expected a Time");
    if (o.clockType !== this.clockType) throw new TypeValidationError("cannot compare times of different clock types");
  }
  eq(o: Time) { this.#check(o); return this.nanoseconds === o.nanoseconds; }
  ne(o: Time) { this.#check(o); return this.nanoseconds !== o.nanoseconds; }
  lt(o: Time) { this.#check(o); return this.nanoseconds < o.nanoseconds; }
  lte(o: Time) { this.#check(o); return this.nanoseconds <= o.nanoseconds; }
  gt(o: Time) { this.#check(o); return this.nanoseconds > o.nanoseconds; }
  gte(o: Time) { this.#check(o); return this.nanoseconds >= o.nanoseconds; }

  toMsg(): { sec: number; nanosec: number } {
    return { sec: Number(this.nanoseconds / NS), nanosec: Number(this.nanoseconds % NS) };
  }

  static fromMsg(msg: { sec: number; nanosec: number }, clockType: ClockType = ClockType.ROS_TIME): Time {
    return new Time(BigInt(msg.sec), BigInt(msg.nanosec), clockType);
  }
}
