// CDR (XCDR1, little endian) codec for ROS 2 messages, compatible with the
// rmw serialization used by rcl_*_serialized_message.
//
// JS representation (mirrors rclnodejs):
//   int64/uint64 -> bigint; other numbers -> number; bool -> boolean;
//   string/wstring -> string; numeric primitive arrays -> TypedArray (except
//   int64/uint64/bool/string, which are plain arrays); nested -> plain objects.
//   When encoding, a field that is undefined or null gets its default value.
//
// Every struct is compiled (new Function) into straight-line read / write /
// create functions; nested structs and arrays call each other's functions.
import type { MessageDefinition, MessageDefinitionField } from "@foxglove/message-definition";
import { RangeValidationError, TypeValidationError } from "../core/errors.ts";

const HEADER = 4; // encapsulation: 00 01 00 00 (CDR_LE)

interface Prim {
  size: number;
  /** DataView getter/setter suffix (getInt32 / setInt32) */
  dv: string;
  /** TypedArray constructor name used for arrays of this type */
  typed?: string;
  kind: "bool" | "number" | "bigint";
}

const PRIMS: Record<string, Prim> = {
  bool: { size: 1, dv: "Uint8", kind: "bool" },
  int8: { size: 1, dv: "Int8", typed: "Int8Array", kind: "number" },
  uint8: { size: 1, dv: "Uint8", typed: "Uint8Array", kind: "number" },
  int16: { size: 2, dv: "Int16", typed: "Int16Array", kind: "number" },
  uint16: { size: 2, dv: "Uint16", typed: "Uint16Array", kind: "number" },
  int32: { size: 4, dv: "Int32", typed: "Int32Array", kind: "number" },
  uint32: { size: 4, dv: "Uint32", typed: "Uint32Array", kind: "number" },
  float32: { size: 4, dv: "Float32", typed: "Float32Array", kind: "number" },
  float64: { size: 8, dv: "Float64", typed: "Float64Array", kind: "number" },
  int64: { size: 8, dv: "BigInt64", kind: "bigint" },
  uint64: { size: 8, dv: "BigUint64", kind: "bigint" },
};
PRIMS.byte = PRIMS.uint8!;
PRIMS.octet = PRIMS.uint8!;
PRIMS.char = PRIMS.uint8!;

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
const coerce = (p: Prim, v: unknown, field: string): unknown =>
  p.kind === "bool" ? Boolean(v) : p.kind === "bigint" ? big(v, field) : num(v, field);

const utf8d = new TextDecoder();
const utf8e = new TextEncoder();

class Reader {
  dv: DataView;
  off = HEADER;
  constructor(
    public u8: Uint8Array,
    public zeroCopy: boolean,
  ) {
    this.dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  }
  /** string body of CDR length `n` (including the NUL) at `o` */
  str(o: number, n: number): string {
    const end = o + n - 1;
    if (end > this.u8.length) throw new RangeValidationError("CDR buffer too short");
    if (n <= 32) {
      // short ASCII strings are cheaper to build by hand than with TextDecoder
      const u8 = this.u8;
      let s = "";
      for (let i = o; i < end; i++) {
        const c = u8[i]!;
        if (c > 127) return utf8d.decode(u8.subarray(o, end));
        s += String.fromCharCode(c);
      }
      return s;
    }
    return utf8d.decode(this.u8.subarray(o, end));
  }
  string(): string {
    let o = this.off;
    o += (4 - ((o - HEADER) & 3)) & 3;
    const n = this.dv.getUint32(o, true);
    o += 4;
    const s = n === 0 ? "" : this.str(o, n);
    this.off = o + n;
    return s;
  }
  wstring(): string {
    let o = this.off;
    o += (4 - ((o - HEADER) & 3)) & 3;
    const n = this.dv.getUint32(o, true);
    o += 4;
    let s = "";
    for (let i = 0; i < n; i++) s += String.fromCharCode(this.dv.getUint32(o + i * 4, true));
    this.off = o + n * 4;
    return s;
  }
  /** `n` elements of `size` bytes at `o` (already aligned) as a TypedArray */
  typed<T>(C: new (buf: ArrayBufferLike, off?: number, len?: number) => T, o: number, n: number, size: number): T {
    const bytes = n * size;
    if (o + bytes > this.u8.length) throw new RangeValidationError("CDR buffer too short");
    const start = this.u8.byteOffset + o;
    if (this.zeroCopy && start % size === 0) return new C(this.u8.buffer, start, n);
    return new C(this.u8.buffer.slice(start, start + bytes));
  }
}

class Writer {
  buf: Uint8Array;
  dv: DataView;
  off = HEADER;
  cap: number;
  constructor(cap: number) {
    this.cap = cap;
    this.buf = new Uint8Array(cap); // zero-filled, so alignment padding needs no writes
    this.buf[1] = 1; // CDR_LE
    this.dv = new DataView(this.buf.buffer);
  }
  grow(n: number) {
    let cap = this.cap * 2;
    while (cap < this.off + n) cap *= 2;
    const nb = new Uint8Array(cap);
    nb.set(this.buf.subarray(0, this.off));
    this.buf = nb;
    this.dv = new DataView(nb.buffer);
    this.cap = cap;
  }
  u32(v: number) {
    if (this.off + 8 > this.cap) this.grow(8);
    let o = this.off;
    o += (4 - ((o - HEADER) & 3)) & 3;
    this.dv.setUint32(o, v, true);
    this.off = o + 4;
  }
  string(s: string) {
    const max = 8 + s.length * 3 + 1;
    if (this.off + max > this.cap) this.grow(max);
    let o = this.off;
    o += (4 - ((o - HEADER) & 3)) & 3;
    const { written } = utf8e.encodeInto(s, this.buf.subarray(o + 4));
    this.dv.setUint32(o, written + 1, true);
    this.off = o + 4 + written + 1; // NUL already zero
  }
  wstring(s: string) {
    this.u32(s.length);
    if (this.off + s.length * 4 > this.cap) this.grow(s.length * 4);
    for (let i = 0; i < s.length; i++) this.dv.setUint32(this.off + i * 4, s.charCodeAt(i), true);
    this.off += s.length * 4;
  }
  finish(): Uint8Array {
    // a fresh buffer that is mostly used is returned as is; otherwise trimmed
    return this.off * 4 >= this.cap * 3 ? this.buf.subarray(0, this.off) : this.buf.slice(0, this.off);
  }
  /**
   * Back to an empty message in the same buffer. A write that completed left
   * nothing past `off`, so zeroing up to it restores an all-zero buffer; one that
   * threw may have, so such a Writer must not be reset (encodeTransient drops it).
   */
  reset() {
    this.buf.fill(0, 0, this.off);
    this.buf[1] = 1;
    this.off = HEADER;
  }
}

export interface DecodeOptions {
  /**
   * Return numeric arrays as views into `bytes` instead of copies (when their
   * alignment allows it). The views alias `bytes`, so do not reuse it.
   */
  zeroCopy?: boolean;
}

export interface Codec {
  encode(msg: unknown): Uint8Array;
  /**
   * Like encode, but into a buffer that the next encodeTransient() of this type
   * reuses: for bytes that are handed to the middleware right away. A new buffer
   * per message would count its size against the garbage collector each time.
   */
  encodeTransient(msg: unknown): Uint8Array;
  decode(bytes: Uint8Array, options?: DecodeOptions): any;
  create(): any;
}

const isString = (t: string) => t === "string" || t === "wstring";
const lit = (s: string) => JSON.stringify(s);
/** `o` advanced to the next multiple of `size` relative to the data start */
const alignExpr = (v: string, size: number) => (size > 1 ? `${v} += (${size} - ((${v} - ${HEADER}) & ${size - 1})) & ${size - 1};` : "");

/** Builds a codec for `defs[0]` (dependencies must be included in `defs`). */
export function buildCodec(defs: MessageDefinition[]): Codec {
  const byName = new Map<string, MessageDefinition>();
  for (const d of defs) if (d.name) byName.set(d.name, d);

  const consts: unknown[] = []; // values referenced by generated code as K[i]
  const K = (v: unknown) => {
    consts.push(v);
    return `K[${consts.length - 1}]`;
  };
  const fns: string[] = [];
  const structIds = new Map<string, number>();
  let arrayId = 0;

  const structId = (type: string): number => {
    const known = structIds.get(type);
    if (known !== undefined) return known;
    const id = structIds.size;
    structIds.set(type, id);
    const d = byName.get(type);
    if (!d) {
      // fail when used, not when building (matches rclnodejs' lazy loading)
      const err = `throw new TypeValidationError(${lit(`unknown nested type ${type}`)});`;
      fns.push(`function r${id}(r) { ${err} }`, `function w${id}(w, v) { ${err} }`, `function c${id}() { ${err} }`);
    } else {
      emitStruct(id, d);
    }
    return id;
  };

  const emitStruct = (id: number, d: MessageDefinition) => {
    const fields = d.definitions.filter((f) => !f.isConstant);
    if (fields.length === 0) {
      // rosidl adds `uint8 structure_needs_at_least_one_member`
      fns.push(
        `function r${id}(r) { r.off += 1; return {}; }`,
        `function w${id}(w, v) { if (w.off + 1 > w.cap) w.grow(1); w.off += 1; }`,
        `function c${id}() { return {}; }`,
      );
      return;
    }
    const rd: string[] = [];
    const wr: string[] = [];
    const cr: string[] = [];
    fields.forEach((f, i) => {
      const key = lit(f.name);
      const fv = `f${i}`;
      if (f.isArray) {
        const a = emitArray(f);
        rd.push(`r.off = o; const ${fv} = ra${a}(r); o = r.off;`);
        wr.push(`wa${a}(w, v[${key}]);`);
        cr.push(`${key}: ca${a}()`);
      } else if (f.isComplex) {
        const s = structId(f.type);
        rd.push(`r.off = o; const ${fv} = r${s}(r); o = r.off;`);
        wr.push(`w${s}(w, v[${key}]);`);
        cr.push(`${key}: c${s}()`);
      } else if (isString(f.type)) {
        const def = f.defaultValue === undefined ? '""' : lit(String(f.defaultValue));
        if (f.type === "wstring") rd.push(`r.off = o; const ${fv} = r.wstring(); o = r.off;`);
        else rd.push(`${alignExpr("o", 4)} n = dv.getUint32(o, true); o += 4; const ${fv} = n === 0 ? "" : r.str(o, n); o += n;`);
        wr.push(`x = v[${key}]; if (x == null) x = ${def}; ${stringWrite(f, "x")}`);
        cr.push(`${key}: ${def}`);
      } else {
        const p = prim(f);
        const def = f.defaultValue === undefined ? zeroLiteral(p) : K(coerce(p, f.defaultValue, f.name));
        rd.push(`${alignExpr("o", p.size)} const ${fv} = ${readExpr(p, "o")}; o += ${p.size};`);
        wr.push(
          `x = v[${key}]; if (x == null) x = ${def};`,
          `if (w.off + ${p.size * 2} > w.cap) w.grow(${p.size * 2}); o = w.off; ${alignExpr("o", p.size)}`,
          `w.dv.set${p.dv}(o, ${coerceExpr(p, "x", f.name)}, true); w.off = o + ${p.size};`,
        );
        cr.push(`${key}: ${def}`);
      }
    });
    fns.push(
      `function r${id}(r) { const dv = r.dv; let o = r.off, n;\n${rd.join("\n")}\nr.off = o; return { ${fields.map((f, i) => `${lit(f.name)}: f${i}`).join(", ")} }; }`,
      `function w${id}(w, v) { if (v == null) v = EMPTY; let x, o;\n${wr.join("\n")}\n}`,
      `function c${id}() { return { ${cr.join(", ")} }; }`,
    );
  };

  const prim = (f: MessageDefinitionField): Prim => {
    const p = PRIMS[f.type];
    if (!p) throw new TypeValidationError(`unsupported primitive type ${f.type}`);
    return p;
  };
  const zeroLiteral = (p: Prim) => (p.kind === "bool" ? "false" : p.kind === "bigint" ? "0n" : "0");
  const readExpr = (p: Prim, o: string) =>
    p.kind === "bool" ? `dv.getUint8(${o}) !== 0` : p.size === 1 ? `dv.get${p.dv}(${o})` : `dv.get${p.dv}(${o}, true)`;
  const coerceExpr = (p: Prim, x: string, name: string) =>
    p.kind === "bool"
      ? `(${x} ? 1 : 0)`
      : p.kind === "bigint"
        ? `(typeof ${x} === "bigint" ? ${x} : big(${x}, ${lit(name)}))`
        : `(typeof ${x} === "number" ? ${x} : num(${x}, ${lit(name)}))`;
  const stringWrite = (f: MessageDefinitionField, x: string) => {
    const bound = f.upperBound;
    return [
      `if (typeof ${x} !== "string") throw new TypeValidationError(${lit(`field '${f.name}' expects a string, got `)} + typeof ${x});`,
      bound !== undefined ? `if (${x}.length > ${bound}) throw new RangeValidationError(${lit(`field '${f.name}' exceeds string bound ${bound}`)});` : "",
      f.type === "wstring" ? `w.wstring(${x});` : `w.string(${x});`,
    ].join(" ");
  };

  const emitArray = (f: MessageDefinitionField): number => {
    const a = arrayId++;
    const name = f.name;
    const fixed = f.arrayLength;
    const bound = f.arrayUpperBound;
    const p = !f.isComplex && !isString(f.type) ? prim(f) : undefined;
    const typed = p?.typed;
    const dflt = f.defaultValue as unknown[] | undefined;

    // element templates
    let readEl: string; // expression reading one element; may use r/dv/o
    let writeLoop: string;
    let createEl: string;
    if (f.isComplex) {
      const s = structId(f.type);
      readEl = `r${s}(r)`;
      writeLoop = `for (let i = 0; i < n; i++) w${s}(w, x[i]);`;
      createEl = `c${s}()`;
    } else if (!p) {
      readEl = f.type === "wstring" ? "r.wstring()" : "r.string()";
      writeLoop = `for (let i = 0; i < n; i++) { const e = x[i]; ${stringWrite(f, "e")} }`;
      createEl = '""';
    } else {
      readEl = "";
      writeLoop = [
        `if (w.off + n * ${p.size} + ${p.size} > w.cap) w.grow(n * ${p.size} + ${p.size});`,
        `let o = w.off; ${alignExpr("o", p.size)} const dv = w.dv;`,
        `for (let i = 0; i < n; i++) { const e = x[i]; dv.set${p.dv}(o, ${coerceExpr(p, "e", name)}, true); o += ${p.size}; }`,
        `w.off = o;`,
      ].join("\n");
      createEl = zeroLiteral(p);
    }

    // default value used when encoding a missing field (never handed out)
    const defaults = dflt !== undefined ? dflt.map((v) => (p ? coerce(p, v, name) : v)) : undefined;
    const encDefault =
      defaults !== undefined
        ? K(typed ? (globalThis as any)[typed].from(defaults) : defaults)
        : fixed !== undefined
          ? K(typed ? new (globalThis as any)[typed](fixed) : Array.from({ length: fixed }, () => (p ? coerce(p, 0, name) : f.isComplex ? undefined : "")))
          : K(typed ? new (globalThis as any)[typed](0) : []);

    const count = fixed !== undefined ? `const n = ${fixed};` : `${alignExpr("o", 4)} const n = r.dv.getUint32(o, true); o += 4;`;
    let read: string;
    if (typed) {
      read = `${count} if (n === 0) { r.off = o; return new ${typed}(0); } ${alignExpr("o", p!.size)} const a = r.typed(${typed}, o, n, ${p!.size}); r.off = o + n * ${p!.size}; return a;`;
    } else if (p) {
      read = `${count} const a = new Array(n); if (n === 0) { r.off = o; return a; } ${alignExpr("o", p.size)} const dv = r.dv; for (let i = 0; i < n; i++) { a[i] = ${readExpr(p, "o")}; o += ${p.size}; } r.off = o; return a;`;
    } else {
      read = `${count} r.off = o; const a = new Array(n); for (let i = 0; i < n; i++) a[i] = ${readEl}; return a;`;
    }
    fns.push(`function ra${a}(r) { let o = r.off; ${read} }`);

    const lengthCheck =
      fixed !== undefined
        ? `if (n !== ${fixed}) throw new RangeValidationError(${lit(`field '${name}' expects exactly ${fixed} elements, got `)} + n);`
        : `${bound !== undefined ? `if (n > ${bound}) throw new RangeValidationError(${lit(`field '${name}' exceeds sequence bound ${bound} (got `)} + n + ")");` : ""} w.u32(n);`;
    const fastTyped = typed
      ? `if (x instanceof ${typed}) { const bl = x.byteLength; if (w.off + bl + ${p!.size} > w.cap) w.grow(bl + ${p!.size}); let o = w.off; ${alignExpr("o", p!.size)} w.buf.set(new Uint8Array(x.buffer, x.byteOffset, bl), o); w.off = o + bl; return; }`
      : "";
    fns.push(
      `function wa${a}(w, x) {
        if (x == null) x = ${encDefault};
        if (typeof x !== "object" || typeof x.length !== "number") throw new TypeValidationError(${lit(`field '${name}' expects an array`)});
        const n = x.length; ${lengthCheck}
        if (n === 0) return;
        ${fastTyped}
        ${writeLoop}
      }`,
    );

    let create: string;
    if (defaults !== undefined) {
      create = typed ? `return ${typed}.from(${K(defaults)});` : `return ${K(defaults)}.slice();`;
    } else if (fixed !== undefined) {
      create = typed ? `return new ${typed}(${fixed});` : `const a = new Array(${fixed}); for (let i = 0; i < ${fixed}; i++) a[i] = ${createEl}; return a;`;
    } else {
      create = typed ? `return new ${typed}(0);` : "return [];";
    }
    fns.push(`function ca${a}() { ${create} }`);
    return a;
  };

  const rootDef = defs[0]!;
  const root = structIds.size;
  structIds.set(rootDef.name ?? "", root);
  emitStruct(root, rootDef);
  const src = `"use strict";\n${fns.join("\n")}\nreturn { read: r${root}, write: w${root}, create: c${root} };\n//# sourceURL=rclbunjs-codec:${rootDef.name ?? "message"}`;
  const compiled = new Function("K", "EMPTY", "num", "big", "TypeValidationError", "RangeValidationError", src)(
    consts,
    Object.freeze({}),
    num,
    big,
    TypeValidationError,
    RangeValidationError,
  ) as { read: (r: Reader) => any; write: (w: Writer, v: unknown) => void; create: () => any };

  // Like rclnodejs, a bare string/number/boolean/bigint is the `data` field
  // (publisher.publish("hello") for std_msgs/msg/String).
  const hasData = rootDef.definitions.some((f) => f.name === "data" && !f.isConstant);
  const wrap = (msg: unknown): unknown => {
    if (msg === null || msg === undefined) return {};
    const t = typeof msg;
    if (t === "object") return msg;
    if (hasData && (t === "string" || t === "number" || t === "boolean" || t === "bigint")) return { data: msg };
    throw new TypeValidationError(`${rootDef.name ?? "message"} expects an object, got ${t}`);
  };

  // initial encode buffer size follows the last encoded message (+12.5%)
  let sizeHint = 256;
  // encodeTransient's buffer; taken while writing, so a write that throws drops it
  let spare: Writer | null = null;
  return {
    encode(msg) {
      const w = new Writer(sizeHint);
      compiled.write(w, wrap(msg));
      sizeHint = Math.max(64, w.off + (w.off >> 3) + 16);
      return w.finish();
    },
    encodeTransient(msg) {
      let w = spare;
      spare = null;
      if (w) w.reset();
      else w = new Writer(sizeHint);
      compiled.write(w, wrap(msg));
      sizeHint = Math.max(64, w.off + (w.off >> 3) + 16);
      // keep it unless it is far bigger than the messages being sent now
      if (w.cap <= 65536 || w.cap <= w.off * 4) spare = w;
      return w.buf.subarray(0, w.off);
    },
    decode(bytes, options) {
      if (bytes.length < HEADER) throw new RangeValidationError("CDR buffer too short");
      if (bytes[1] !== 1) throw new TypeValidationError(`unsupported CDR encapsulation 0x${bytes[0]}${bytes[1]}`);
      return compiled.read(new Reader(bytes, options?.zeroCopy === true));
    },
    create: () => compiled.create(),
  };
}
