// CDR codec vs rclpy golden vectors (test/interop/gen_golden.py).
import { describe, expect, test } from "bun:test";
import { join } from "node:path";

process.env.AMENT_PREFIX_PATH = join(import.meta.dir, "..", "fixtures", "ament");
const { getMessageType } = await import("../../src/interfaces/registry.ts");

interface Case {
  type: string;
  hex: string;
  value: unknown;
}
// golden.json: rmw_fastrtps_cpp, golden.cyclonedds.json: rmw_cyclonedds_cpp
const goldens: [string, Case[]][] = [
  ["fastrtps", await Bun.file(join(import.meta.dir, "..", "fixtures", "golden.json")).json()],
  ["cyclonedds", await Bun.file(join(import.meta.dir, "..", "fixtures", "golden.cyclonedds.json")).json()],
];

const fromHex = (h: string) => Uint8Array.from(Buffer.from(h, "hex"));

/** Python-side JSON value -> JS value we expect from the decoder. */
function expected(v: any): any {
  if (Array.isArray(v)) return v.map(expected);
  if (v && typeof v === "object") {
    if ("$int" in v) return BigInt(v.$int);
    if ("$float" in v) return v.$float === "nan" ? NaN : v.$float === "inf" ? Infinity : -Infinity;
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, expected(x)]));
  }
  return v;
}

function close(a: any, b: any, path: string): string | null {
  if (ArrayBuffer.isView(a) && !(a instanceof DataView)) a = Array.from(a as unknown as ArrayLike<unknown>);
  if (Array.isArray(b)) {
    if (!Array.isArray(a)) return `${path}: expected array, got ${typeof a}`;
    if (a.length !== b.length) return `${path}: length ${a.length} != ${b.length}`;
    for (let i = 0; i < b.length; i++) {
      const e = close(a[i], b[i], `${path}[${i}]`);
      if (e) return e;
    }
    return null;
  }
  if (b && typeof b === "object") {
    for (const k of Object.keys(b)) {
      const e = close(a?.[k], b[k], `${path}.${k}`);
      if (e) return e;
    }
    return null;
  }
  if (typeof b === "number" && (typeof a === "number" || typeof a === "bigint")) {
    const x = Number(a);
    if (Number.isNaN(b)) return Number.isNaN(x) ? null : `${path}: ${x} != NaN`;
    if (x === b) return null;
    // float32 fields round-trip through single precision
    if (Math.abs(x - b) <= Math.max(1e-6, Math.abs(b) * 1e-6)) return null;
    if (Math.fround(b) === x) return null;
    return `${path}: ${x} != ${b}`;
  }
  if (typeof b === "bigint") return BigInt(a) === b ? null : `${path}: ${a} != ${b}`;
  return a === b ? null : `${path}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`;
}

for (const [rmw, cases] of goldens) describe(`CDR codec matches rclpy serialization (${rmw})`, () => {
  const counters = new Map<string, number>();
  for (const c of cases) {
    const i = (counters.get(c.type) ?? 0) + 1;
    counters.set(c.type, i);
    test(`${c.type} #${i}`, () => {
      const mt = getMessageType(c.type);
      const decoded = mt.decode(fromHex(c.hex));
      expect(close(decoded, expected(c.value), "msg")).toBeNull();
      // Fast-CDR leaves alignment padding uninitialised and rmw_serialize may
      // append slack bytes, so compare re-encodings by content, not bytes.
      const golden = fromHex(c.hex);
      for (const enc of [mt.encode(decoded), mt.encode(expected(c.value))]) {
        expect(enc.length).toBeLessThanOrEqual(golden.length);
        expect(close(mt.decode(enc), expected(c.value), "re")).toBeNull();
      }
    });
  }
});

describe("registry", () => {
  test("defaults and constants", () => {
    const d = getMessageType("test_msgs/msg/Defaults").create();
    expect(d.bool_value).toBe(true);
    expect(d.int64_value).toBe(-40000000n);
    const c = getMessageType("test_msgs/msg/Constants").constants;
    expect(c.INT32_CONST).toBe(-30000);
  });
  test("service and action types", async () => {
    const { getServiceType, getActionType } = await import("../../src/interfaces/registry.ts");
    const s = getServiceType("example_interfaces/srv/AddTwoInts");
    expect(s.request.create()).toEqual({ a: 0n, b: 0n });
    expect(s.response.create()).toEqual({ sum: 0n });
    const a = getActionType("example_interfaces/action/Fibonacci");
    expect(Object.keys(a.sendGoalRequest.create())).toEqual(["goal_id", "goal"]);
    expect(a.getResultResponse.create().status).toBe(0);
  });
  test("type name forms", async () => {
    const { parseTypeName } = await import("../../src/interfaces/registry.ts");
    expect(parseTypeName("std_msgs/msg/String")).toEqual({ pkg: "std_msgs", kind: "msg", name: "String" });
    expect(parseTypeName("std_msgs/String")).toEqual({ pkg: "std_msgs", kind: "msg", name: "String" });
    expect(parseTypeName({ package: "std_srvs", type: "srv", name: "SetBool" })).toEqual({
      pkg: "std_srvs",
      kind: "srv",
      name: "SetBool",
    });
  });
});

describe("codec options and buffers", () => {
  test("zeroCopy returns views into the input where alignment allows", () => {
    const mt = getMessageType("sensor_msgs/msg/LaserScan");
    const ranges = Float32Array.from({ length: 50 }, (_, i) => i * 0.5);
    const bytes = mt.encode({ header: { frame_id: "laser" }, ranges, intensities: new Float32Array(3) });
    const copy = mt.decode(bytes);
    const view = mt.decode(bytes, { zeroCopy: true });
    expect(Array.from(view.ranges)).toEqual(Array.from(ranges));
    expect(Array.from(view.ranges)).toEqual(Array.from(copy.ranges));
    expect(view.ranges.buffer).toBe(bytes.buffer);
    expect(copy.ranges.buffer).not.toBe(bytes.buffer);

    // misaligned input: falls back to copies with the same values
    const shifted = new Uint8Array(bytes.length + 1).subarray(1);
    shifted.set(bytes);
    const v2 = mt.decode(shifted, { zeroCopy: true });
    expect(Array.from(v2.ranges)).toEqual(Array.from(ranges));
    expect(v2.ranges.buffer).not.toBe(shifted.buffer);
  });

  test("uint8 arrays are always views with zeroCopy", () => {
    const mt = getMessageType("sensor_msgs/msg/Image");
    const data = Uint8Array.from({ length: 1000 }, (_, i) => i & 255);
    const bytes = mt.encode({ encoding: "mono8", width: 1000, height: 1, step: 1000, data });
    const m = mt.decode(bytes, { zeroCopy: true });
    expect(m.data.buffer).toBe(bytes.buffer);
    expect(m.data).toEqual(data);
  });

  test("encoding messages of growing and shrinking size", () => {
    const mt = getMessageType("sensor_msgs/msg/JointState");
    for (const n of [0, 1, 300, 2, 5000, 0, 64]) {
      const msg = { name: Array.from({ length: n }, (_, i) => `joint_${i}`), position: Float64Array.from({ length: n }, (_, i) => i) };
      const out = mt.decode(mt.encode(msg));
      expect(out.name).toEqual(msg.name);
      expect(Array.from(out.position)).toEqual(Array.from(msg.position));
    }
  });

  test("truncated input throws", () => {
    const mt = getMessageType("std_msgs/msg/String");
    const bytes = mt.encode({ data: "a fairly long string value" });
    expect(() => mt.decode(bytes.subarray(0, 12))).toThrow();
    const scan = getMessageType("sensor_msgs/msg/LaserScan");
    const sb = scan.encode({ ranges: new Float32Array(100) });
    expect(() => scan.decode(sb.subarray(0, sb.length - 40))).toThrow();
  });
});
