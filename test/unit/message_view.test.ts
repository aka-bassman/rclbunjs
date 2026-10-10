// Message views over C structs (loaned messages), with hand-written layouts that
// follow the C rules rb_msg_layout reports (offsets, sizeof with padding).
import { describe, expect, test } from "bun:test";
import { ptr } from "bun:ffi";
import { RangeValidationError, TypeValidationError } from "../../src/core/errors.ts";
import { compileView, openView, ReusedViews, type Layout } from "../../src/core/message_view.ts";

// type ids: rosidl_typesupport_introspection_c/field_types.h
const F32 = 1, F64 = 2, CHAR = 4, BOOL = 6, U8 = 8, I16 = 11, U32 = 12, I64 = 15, U64 = 14, STR = 16, MSG = 18;

// struct Point { double x, y, z; }  -> 24 bytes
const point: Layout = {
  size: 24,
  fields: [
    { name: "x", type: F64, offset: 0, array: 0 },
    { name: "y", type: F64, offset: 8, array: 0 },
    { name: "z", type: F64, offset: 16, array: 0 },
  ],
};
// struct Frame {
//   bool ok;            // 0
//   char letter;        // 1
//   int16_t delta;      // 2
//   uint32_t width;     // 4
//   int64_t stamp;      // 8
//   uint64_t seq;       // 16
//   float ratio;        // 24
//   Point origin;       // 32
//   Point corners[2];   // 56
//   bool flags[3];      // 104
//   int64_t ids[2];     // 112
//   uint8_t data[8];    // 128
//   float gains[3];     // 136
// } -> 152 (aligned to 8)
const frame: Layout = {
  size: 152,
  fields: [
    { name: "ok", type: BOOL, offset: 0, array: 0 },
    { name: "letter", type: CHAR, offset: 1, array: 0 },
    { name: "delta", type: I16, offset: 2, array: 0 },
    { name: "width", type: U32, offset: 4, array: 0 },
    { name: "stamp", type: I64, offset: 8, array: 0 },
    { name: "seq", type: U64, offset: 16, array: 0 },
    { name: "ratio", type: F32, offset: 24, array: 0 },
    { name: "origin", type: MSG, offset: 32, array: 0, message: point },
    { name: "corners", type: MSG, offset: 56, array: 2, message: point },
    { name: "flags", type: BOOL, offset: 104, array: 3 },
    { name: "ids", type: I64, offset: 112, array: 2 },
    { name: "data", type: U8, offset: 128, array: 8 },
    { name: "gains", type: F32, offset: 136, array: 3 },
  ],
};

const Frame = compileView(frame, "test/msg/Frame");
const fresh = () => {
  const mem = new BigUint64Array(19); // 152 bytes, 8-byte aligned like malloc
  return { mem, dv: new DataView(mem.buffer), view: new Frame(new DataView(mem.buffer), 0) as any };
};

describe("message views", () => {
  test("scalars read and write the C layout", () => {
    const { dv, view } = fresh();
    view.ok = true;
    view.letter = 65;
    view.delta = -2;
    view.width = 640;
    view.stamp = -5n;
    view.seq = 7;
    view.ratio = 0.5;
    expect(dv.getUint8(0)).toBe(1);
    expect(dv.getUint8(1)).toBe(65);
    expect(dv.getInt16(2, true)).toBe(-2);
    expect(dv.getUint32(4, true)).toBe(640);
    expect(dv.getBigInt64(8, true)).toBe(-5n);
    expect(dv.getBigUint64(16, true)).toBe(7n);
    expect(dv.getFloat32(24, true)).toBe(0.5);
    expect([view.ok, view.letter, view.delta, view.width, view.stamp, view.seq, view.ratio]).toEqual([true, 65, -2, 640, -5n, 7n, 0.5]);
  });

  test("nested messages and arrays of messages are views at their offsets", () => {
    const { dv, view } = fresh();
    view.origin.y = 2;
    view.corners[1].z = 3;
    expect(dv.getFloat64(32 + 8, true)).toBe(2);
    expect(dv.getFloat64(56 + 24 + 16, true)).toBe(3);
    expect(view.corners).toHaveLength(2);
    expect(view.corners[0]).toBe(view.corners[0]); // cached
    view.corners = [{ x: 1 }, { y: 4 }];
    expect(view.corners[0].x).toBe(1);
    expect(view.corners[1].y).toBe(4);
    expect(view.corners[1].z).toBe(3); // omitted fields keep their values
  });

  test("fixed arrays are TypedArrays over the same memory", () => {
    const { dv, view } = fresh();
    expect(view.data).toBeInstanceOf(Uint8Array);
    expect(view.gains).toBeInstanceOf(Float32Array);
    expect(view.ids).toBeInstanceOf(BigInt64Array);
    expect(view.flags).toBeInstanceOf(Uint8Array);
    view.data[3] = 9;
    expect(dv.getUint8(128 + 3)).toBe(9);
    view.gains = [1, 2, 3];
    expect(dv.getFloat32(136 + 8, true)).toBe(3);
    view.ids = [1, -2n];
    expect(dv.getBigInt64(112 + 8, true)).toBe(-2n);
    view.flags = [true, false, true];
    expect([...view.flags]).toEqual([1, 0, 1]);
    view.data = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(dv.getUint8(128 + 7)).toBe(8);
  });

  test("toObject() copies into the shapes of a decoded message", () => {
    const { view } = fresh();
    view.set({ ok: true, stamp: 3n, origin: { x: 1 }, ids: [4n, 5n], flags: [false, true, false], gains: [0.5, 0, 0] });
    const o = view.toObject();
    expect(o.ok).toBe(true);
    expect(o.stamp).toBe(3n);
    expect(o.origin).toEqual({ x: 1, y: 0, z: 0 });
    expect(o.corners).toEqual([
      { x: 0, y: 0, z: 0 },
      { x: 0, y: 0, z: 0 },
    ]);
    expect(o.ids).toEqual([4n, 5n]); // int64 arrays decode to plain arrays
    expect(o.flags).toEqual([false, true, false]); // bool arrays too
    expect(o.gains).toBeInstanceOf(Float32Array);
    view.gains[0] = 9;
    expect(o.gains[0]).toBe(0.5); // a copy
    expect(JSON.parse(JSON.stringify({ ...view.toObject(), stamp: 0, seq: 0, ids: [] })).origin.x).toBe(1);
  });

  test("wrong values are rejected", () => {
    const { view } = fresh();
    expect(() => (view.gains = [1, 2])).toThrow(RangeValidationError);
    expect(() => (view.corners = [{}])).toThrow(RangeValidationError);
    expect(() => (view.width = "wide")).toThrow(TypeValidationError);
    expect(() => (view.stamp = 1.5)).toThrow(TypeValidationError);
    expect(() => view.set(5)).toThrow(TypeValidationError);
  });

  test("strings and sequences are not fixed-size", () => {
    expect(() => compileView({ size: 24, fields: [{ name: "s", type: STR, offset: 0, array: 0 }] }, "x/msg/S")).toThrow(/string or a sequence/);
    expect(() => compileView({ size: 24, fields: [{ name: "v", type: F64, offset: 0, array: -1 }] }, "x/msg/V")).toThrow(/'v'/);
    const nested: Layout = { size: 24, fields: [{ name: "inner", type: MSG, offset: 0, array: 0, message: { size: 24, fields: [{ name: "s", type: STR, offset: 0, array: 0 }] } }] };
    expect(() => compileView(nested, "x/msg/N")).toThrow(/'inner\.s'/);
  });

  test("released views stop working instead of touching freed memory", () => {
    const mem = new BigUint64Array(19);
    const v = openView<any>({ size: frame.size, View: Frame }, ptr(mem));
    const data = v.view.data;
    v.view.width = 3;
    expect(new DataView(mem.buffer).getUint32(4, true)).toBe(3);
    v.release();
    expect(() => v.view.width).toThrow(TypeError);
    expect(data.length).toBe(0);
    expect(mem[0]).toBe(BigInt(3) << 32n); // the memory itself is untouched
  });

  test("reused views: one per address, never detached", () => {
    const views = new ReusedViews({ size: frame.size, View: Frame });
    const mems = Array.from({ length: 70 }, () => new BigUint64Array(19));
    const a = views.open<any>(ptr(mems[0]!));
    const data = a.view.data;
    a.view.width = 7;
    a.release();
    expect(a.view.width).toBe(7); // still attached
    const again = views.open<any>(ptr(mems[0]!));
    expect(again.view).toBe(a.view);
    expect(again.view.data).toBe(data);
    expect(views.open<any>(ptr(mems[1]!)).view).not.toBe(a.view);
    // more distinct addresses than it keeps: it starts over
    for (const m of mems) views.open(ptr(m));
    expect(views.open<any>(ptr(mems[0]!)).view).not.toBe(a.view);
    views.clear();
  });
});
