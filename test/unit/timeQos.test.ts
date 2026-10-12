import { describe, expect, test } from "bun:test";
import { join } from "node:path";
process.env.AMENT_PREFIX_PATH = join(import.meta.dir, "..", "fixtures", "ament");
const { Time, Duration, ClockType } = await import("../../src/core/time.ts");
const { QoS } = await import("../../src/core/qos.ts");
const { Parameter, ParameterType: PT, ParameterDescriptor, FloatingPointRange, IntegerRange, inferParameterType } = await import(
  "../../src/core/parameter.ts"
);

describe("Time/Duration", () => {
  test("arithmetic and messages", () => {
    const t = new Time(10n, 500n, ClockType.ROS_TIME);
    const d = new Duration(1n, 1_000_000_000n);
    expect(d.nanoseconds).toBe(2_000_000_000n);
    expect(t.add(d).nanoseconds).toBe(12_000_000_500n);
    expect(t.add(d).sub(t).nanoseconds).toBe(2_000_000_000n);
    expect(t.toMsg()).toEqual({ sec: 10, nanosec: 500 });
    expect(Time.fromMsg({ sec: 3, nanosec: 4 }).nanoseconds).toBe(3_000_000_004n);
    expect(new Duration(0n, -1n).toMsg()).toEqual({ sec: -1, nanosec: 999_999_999 });
    expect(() => new Time(-1n)).toThrow();
    expect(() => t.lt(new Time(1n, 0n, ClockType.SYSTEM_TIME))).toThrow();
  });
});

describe("QoS", () => {
  test("profiles and native packing", () => {
    const q = QoS.from(QoS.profileSensorData);
    expect([q.history, q.depth, q.reliability, q.durability]).toEqual([1, 5, 2, 2]);
    const r = QoS.from(QoS.profileRosoutDefault);
    expect(r.lifespan).toBe(10_000_000_000n);
    expect(Array.from(QoS.from(undefined).toNative())).toEqual([1n, 10n, 1n, 2n, 0n, 0n, 0n, 0n, 0n]);
    expect(() => QoS.from("nope")).toThrow();
    expect(() => {
      (q as any).depth = "x";
    }).toThrow();
  });
});

describe("parameters", () => {
  test("value coercion and messages", () => {
    expect(new Parameter("i", PT.PARAMETER_INTEGER, 5).value).toBe(5n);
    expect(() => new Parameter("i", PT.PARAMETER_INTEGER, 1.5)).toThrow();
    expect(() => new Parameter("b", PT.PARAMETER_BOOL, 1)).toThrow();
    const p = new Parameter("arr", PT.PARAMETER_DOUBLE_ARRAY, [1, 2]);
    const m = p.toParameterMessage();
    expect(m.value.type).toBe(PT.PARAMETER_DOUBLE_ARRAY);
    expect(Parameter.fromParameterMessage(m).value).toEqual([1, 2]);
    expect(inferParameterType(3n)).toBe(PT.PARAMETER_INTEGER);
    expect(inferParameterType(["a"])).toBe(PT.PARAMETER_STRING_ARRAY);
  });
  test("ranges and descriptors", () => {
    const f = new FloatingPointRange(0, 1, 0.1);
    expect(f.inRange(0.3)).toBe(true);
    expect(f.inRange(0.35)).toBe(false);
    expect(new IntegerRange(0n, 10n, 5n).inRange(5n)).toBe(true);
    expect(new IntegerRange(0n, 10n, 5n).inRange(6n)).toBe(false);
    const d = new ParameterDescriptor("x", PT.PARAMETER_INTEGER);
    d.rangeConstraint = new IntegerRange(0n, 3n);
    expect(() => d.validateParameter(new Parameter("x", PT.PARAMETER_INTEGER, 4n))).toThrow();
    expect(() => d.validateParameter(new Parameter("x", PT.PARAMETER_DOUBLE, 1.0))).toThrow();
    const back = ParameterDescriptor.fromMessage(d.toMessage() as any);
    expect(back.rangeConstraint?.toValue).toBe(3n);
  });
});
