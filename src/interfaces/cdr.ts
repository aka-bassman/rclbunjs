// CDR (XCDR1, little endian) codec for ROS 2 messages, compatible with the
// rmw_fastrtps serialization used by rcl_*_serialized_message.
//
// JS representation (mirrors rclnodejs):
//   int64/uint64 -> bigint; other numbers -> number; bool -> boolean;
//   string/wstring -> string; numeric primitive arrays -> TypedArray (except
//   int64/uint64/bool/string, which are plain arrays); nested -> plain objects.
import type { MessageDefinition, MessageDefinitionField } from "@foxglove/message-definition";
import { RangeValidationError, TypeValidationError } from "../core/errors.ts";

const HEADER = 4; // encapsulation: 00 01 00 00 (CDR_LE)

type TypedArrayCtor =
  | Uint8ArrayConstructor
  | Int8ArrayConstructor
  | Int16ArrayConstructor
  | Uint16ArrayConstructor
  | Int32ArrayConstructor
  | Uint32ArrayConstructor
  | Float32ArrayConstructor
  | Float64ArrayConstructor;

interface Prim {
  size: number;
  read(dv: DataView, o: number): unknown;
  write(dv: DataView, o: number, v: unknown): void;
  zero: unknown;
  typed?: TypedArrayCtor;
  coerce(v: unknown, field: string): unknown;
}

const num = (v: unknown, field: string): number => {
  const n = typeof v === "bigint" ? Number(v) : (v as number);
  if (typeof n !== "number") throw new TypeValidationError(`field '${field}' expects a number, got ${typeof v}`);
  return n;
};
const big = (v: unknown, field: string): bigint => {
  if (typeof v === "bigint") return v;
  if (typeof v === "number" && Number.isInteger(v)) return BigInt(v);
  if (typeof v === "string" && /^-?\d+$/.test(v)) return BigInt(v);
  throw new TypeValidationError(`field '${field}' expects an integer (bigint), got ${String(v)}`);
};

const PRIMS: Record<string, Prim> = {
  bool: {
    size: 1, zero: false,
    read: (dv, o) => dv.getUint8(o) !== 0,
    write: (dv, o, v) => dv.setUint8(o, v ? 1 : 0),
    coerce: (v) => Boolean(v),
  },
  int8: { size: 1, zero: 0, typed: Int8Array, read: (dv, o) => dv.getInt8(o), write: (dv, o, v) => dv.setInt8(o, v as number), coerce: num },
  uint8: { size: 1, zero: 0, typed: Uint8Array, read: (dv, o) => dv.getUint8(o), write: (dv, o, v) => dv.setUint8(o, v as number), coerce: num },
  int16: { size: 2, zero: 0, typed: Int16Array, read: (dv, o) => dv.getInt16(o, true), write: (dv, o, v) => dv.setInt16(o, v as number, true), coerce: num },
  uint16: { size: 2, zero: 0, typed: Uint16Array, read: (dv, o) => dv.getUint16(o, true), write: (dv, o, v) => dv.setUint16(o, v as number, true), coerce: num },
  int32: { size: 4, zero: 0, typed: Int32Array, read: (dv, o) => dv.getInt32(o, true), write: (dv, o, v) => dv.setInt32(o, v as number, true), coerce: num },
  uint32: { size: 4, zero: 0, typed: Uint32Array, read: (dv, o) => dv.getUint32(o, true), write: (dv, o, v) => dv.setUint32(o, v as number, true), coerce: num },
  float32: { size: 4, zero: 0, typed: Float32Array, read: (dv, o) => dv.getFloat32(o, true), write: (dv, o, v) => dv.setFloat32(o, v as number, true), coerce: num },
  float64: { size: 8, zero: 0, typed: Float64Array, read: (dv, o) => dv.getFloat64(o, true), write: (dv, o, v) => dv.setFloat64(o, v as number, true), coerce: num },
  int64: { size: 8, zero: 0n, read: (dv, o) => dv.getBigInt64(o, true), write: (dv, o, v) => dv.setBigInt64(o, v as bigint, true), coerce: big },
  uint64: { size: 8, zero: 0n, read: (dv, o) => dv.getBigUint64(o, true), write: (dv, o, v) => dv.setBigUint64(o, v as bigint, true), coerce: big },
};
PRIMS.byte = PRIMS.uint8!;
PRIMS.octet = PRIMS.uint8!;
PRIMS.char = PRIMS.uint8!;

const utf8d = new TextDecoder();
const utf8e = new TextEncoder();

class Reader {
  dv: DataView;
  off = HEADER;
  constructor(public u8: Uint8Array) {
    this.dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  }
  align(n: number) {
    const r = (this.off - HEADER) % n;
    if (r) this.off += n - r;
  }
  u32(): number {
    this.align(4);
    const v = this.dv.getUint32(this.off, true);
    this.off += 4;
    return v;
  }
  string(): string {
    const len = this.u32();
    if (len === 0) return "";
    const s = utf8d.decode(this.u8.subarray(this.off, this.off + len - 1));
    this.off += len;
    return s;
  }
  wstring(): string {
    const n = this.u32();
    let s = "";
    for (let i = 0; i < n; i++) s += String.fromCharCode(this.dv.getUint32(this.off + i * 4, true));
    this.off += n * 4;
    return s;
  }
}

class Writer {
  buf: Uint8Array;
  dv: DataView;
  off = HEADER;
  constructor(cap = 256) {
    this.buf = new Uint8Array(cap);
    this.buf[1] = 1; // CDR_LE
    this.dv = new DataView(this.buf.buffer);
  }
  ensure(n: number) {
    if (this.off + n <= this.buf.length) return;
    let cap = this.buf.length * 2;
    while (cap < this.off + n) cap *= 2;
    const nb = new Uint8Array(cap);
    nb.set(this.buf.subarray(0, this.off));
    this.buf = nb;
    this.dv = new DataView(nb.buffer);
  }
  align(n: number) {
    const r = (this.off - HEADER) % n;
    if (r) {
      this.ensure(n - r);
      this.buf.fill(0, this.off, this.off + n - r);
      this.off += n - r;
    }
  }
  u32(v: number) {
    this.align(4);
    this.ensure(4);
    this.dv.setUint32(this.off, v, true);
    this.off += 4;
  }
  string(s: string) {
    this.align(4);
    this.ensure(4 + s.length * 3 + 1);
    const { written } = utf8e.encodeInto(s, this.buf.subarray(this.off + 4));
    this.dv.setUint32(this.off, written + 1, true);
    this.buf[this.off + 4 + written] = 0;
    this.off += 4 + written + 1;
  }
  wstring(s: string) {
    this.u32(s.length);
    this.ensure(s.length * 4);
    for (let i = 0; i < s.length; i++) this.dv.setUint32(this.off + i * 4, s.charCodeAt(i), true);
    this.off += s.length * 4;
  }
  finish(): Uint8Array {
    return this.buf.slice(0, this.off);
  }
}

type ReadFn = (r: Reader) => unknown;
type WriteFn = (w: Writer, v: unknown) => void;

interface StructCodec {
  read: ReadFn;
  write: WriteFn;
  create: () => Record<string, unknown>;
}

export interface Codec {
  encode(msg: unknown): Uint8Array;
  decode(bytes: Uint8Array): any;
  create(): any;
}

const isString = (t: string) => t === "string" || t === "wstring";

/** Builds a codec for `defs[0]` (dependencies must be included in `defs`). */
export function buildCodec(defs: MessageDefinition[]): Codec {
  const byName = new Map<string, MessageDefinition>();
  for (const d of defs) if (d.name) byName.set(d.name, d);
  const structs = new Map<string, StructCodec>();

  const struct = (d: MessageDefinition): StructCodec => {
    const key = d.name ?? "";
    const cached = structs.get(key);
    if (cached) return cached;
    // placeholder first to allow recursive references
    const sc: StructCodec = { read: () => ({}), write: () => {}, create: () => ({}) };
    structs.set(key, sc);
    const fields = d.definitions.filter((f) => !f.isConstant);
    if (fields.length === 0) {
      // rosidl adds `uint8 structure_needs_at_least_one_member`
      sc.read = (r) => {
        r.off += 1;
        return {};
      };
      sc.write = (w) => {
        w.ensure(1);
        w.buf[w.off++] = 0;
      };
      sc.create = () => ({});
      return sc;
    }
    const parts = fields.map((f) => field(f));
    const names = fields.map((f) => f.name);
    sc.read = (r) => {
      const o: Record<string, unknown> = {};
      for (let i = 0; i < parts.length; i++) o[names[i]!] = parts[i]!.read(r);
      return o;
    };
    sc.write = (w, v) => {
      const o = (v ?? {}) as Record<string, unknown>;
      for (let i = 0; i < parts.length; i++) {
        const x = o[names[i]!];
        parts[i]!.write(w, x === undefined ? parts[i]!.def() : x);
      }
    };
    sc.create = () => {
      const o: Record<string, unknown> = {};
      for (let i = 0; i < parts.length; i++) o[names[i]!] = parts[i]!.def();
      return o;
    };
    return sc;
  };

  const resolve = (type: string): StructCodec => {
    const d = byName.get(type);
    if (!d) throw new TypeValidationError(`unknown nested type ${type}`);
    return struct(d);
  };

  interface FieldCodec {
    read: ReadFn;
    write: WriteFn;
    def: () => unknown;
  }

  const field = (f: MessageDefinitionField): FieldCodec => {
    const name = f.name;
    const fixed = f.isArray && f.arrayLength !== undefined ? f.arrayLength : undefined;
    const bound = f.isArray ? f.arrayUpperBound : undefined;
    const strBound = f.upperBound;

    // element read/write/zero
    let elRead: ReadFn;
    let elWrite: WriteFn;
    let elZero: () => unknown;
    let prim: Prim | undefined;
    if (f.isComplex) {
      const sc = () => resolve(f.type);
      elRead = (r) => sc().read(r);
      elWrite = (w, v) => sc().write(w, v);
      elZero = () => sc().create();
    } else if (isString(f.type)) {
      const wide = f.type === "wstring";
      elRead = wide ? (r) => r.wstring() : (r) => r.string();
      elWrite = (w, v) => {
        if (typeof v !== "string") throw new TypeValidationError(`field '${name}' expects a string, got ${typeof v}`);
        if (strBound !== undefined && v.length > strBound) {
          throw new RangeValidationError(`field '${name}' exceeds string bound ${strBound}`);
        }
        wide ? w.wstring(v) : w.string(v);
      };
      elZero = () => "";
    } else {
      const p = PRIMS[f.type];
      if (!p) throw new TypeValidationError(`unsupported primitive type ${f.type}`);
      prim = p;
      elRead = (r) => {
        r.align(p.size);
        const v = p.read(r.dv, r.off);
        r.off += p.size;
        return v;
      };
      elWrite = (w, v) => {
        w.align(p.size);
        w.ensure(p.size);
        p.write(w.dv, w.off, p.coerce(v, name));
        w.off += p.size;
      };
      elZero = () => p.zero;
    }

    const dv = f.defaultValue;
    const elDefault = (i?: number): unknown => {
      if (dv === undefined) return elZero();
      const x = i === undefined ? dv : (dv as unknown[])[i];
      if (prim) return prim.coerce(x, name);
      return x;
    };

    if (!f.isArray) {
      return { read: elRead, write: elWrite, def: () => elDefault() };
    }

    const typed = prim?.typed;
    const count = (r: Reader) => (fixed !== undefined ? fixed : r.u32());

    const read: ReadFn = typed
      ? (r) => {
          const n = count(r);
          if (n === 0) return new typed(0);
          r.align(prim!.size);
          const start = r.u8.byteOffset + r.off;
          const bytes = n * prim!.size;
          r.off += bytes;
          return new typed(r.u8.buffer.slice(start, start + bytes) as ArrayBuffer);
        }
      : (r) => {
          const n = count(r);
          const out = new Array(n);
          for (let i = 0; i < n; i++) out[i] = elRead(r);
          return out;
        };

    const write: WriteFn = (w, v) => {
      const arr = v as ArrayLike<unknown>;
      if (arr === null || typeof arr !== "object" || typeof arr.length !== "number") {
        throw new TypeValidationError(`field '${name}' expects an array`);
      }
      const n = arr.length;
      if (fixed !== undefined) {
        if (n !== fixed) throw new RangeValidationError(`field '${name}' expects exactly ${fixed} elements, got ${n}`);
      } else {
        if (bound !== undefined && n > bound) {
          throw new RangeValidationError(`field '${name}' exceeds sequence bound ${bound} (got ${n})`);
        }
        w.u32(n);
      }
      if (n === 0) return;
      if (typed && ArrayBuffer.isView(arr) && arr instanceof typed) {
        w.align(prim!.size);
        const src = arr as unknown as Uint8Array;
        w.ensure(src.byteLength);
        w.buf.set(new Uint8Array(src.buffer, src.byteOffset, src.byteLength), w.off);
        w.off += src.byteLength;
        return;
      }
      for (let i = 0; i < n; i++) elWrite(w, arr[i]);
    };

    const def = (): unknown => {
      if (fixed !== undefined) {
        const items = Array.from({ length: fixed }, (_, i) => elDefault(dv === undefined ? undefined : i));
        return typed ? typed.from(items as number[]) : items;
      }
      if (dv !== undefined) {
        const items = (dv as unknown[]).map((_, i) => elDefault(i));
        return typed ? typed.from(items as number[]) : items;
      }
      return typed ? new typed(0) : [];
    };

    return { read, write, def };
  };

  const root = struct(defs[0]!);
  return {
    encode(msg) {
      const w = new Writer();
      root.write(w, msg ?? {});
      return w.finish();
    },
    decode(bytes) {
      if (bytes.length < HEADER) throw new RangeValidationError("CDR buffer too short");
      if (bytes[1] !== 1) throw new TypeValidationError(`unsupported CDR encapsulation 0x${bytes[0]}${bytes[1]}`);
      return root.read(new Reader(bytes));
    },
    create: () => root.create(),
  };
}
