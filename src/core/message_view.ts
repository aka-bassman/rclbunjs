// Views over C messages (rosidl C structs) for loaned messages.
//
// A view reads and writes the fields of a C message in place: scalars through a
// DataView, fixed-size numeric arrays as TypedArrays over the same memory, nested
// messages as nested views. Only fixed-size message types are supported (no
// strings or sequences), which is also what middlewares can loan.
//
// The layout comes from the introspection typesupport (rb_msg_layout, see
// loaned_message.ts); each struct is compiled (new Function) into a class with
// one getter/setter per field. This module has no native dependency.
import { toArrayBuffer, type Pointer } from "bun:ffi";
import { RangeValidationError, TypeValidationError } from "./errors.ts";
import type { MessageInput } from "../types.ts";

/** @internal C struct layout (rb_msg_layout) */
export interface LayoutField {
  name: string;
  /** rosidl_typesupport_introspection_c field type id */
  type: number;
  offset: number;
  /** 0 = not an array, N = fixed size N, -1 = sequence */
  array: number;
  message?: Layout;
}

/** @internal */
export interface Layout {
  size: number;
  fields: LayoutField[];
}

/** Methods every message view has besides its fields. */
export interface MessageViewMethods<T> {
  /** Deep copy into a plain message object (safe to keep after the view is released). */
  toObject(): T;
  /** Assigns the given fields (nested objects too); omitted fields keep their values. */
  set(values: MessageInput<T>): void;
}

/**
 * A message whose fields live in C memory (a middleware loan or a shim-owned
 * C message). Numeric arrays are TypedArrays over that memory, including
 * int64/uint64 (BigInt64Array/BigUint64Array) and bool (Uint8Array) arrays.
 */
export type MessageView<T> = T & MessageViewMethods<T>;

interface Prim {
  dv: string;
  size: number;
  typed: string;
  kind: "number" | "bigint" | "bool";
}

// field type ids: rosidl_typesupport_introspection_c/field_types.h
const PRIMS: Record<number, Prim> = {
  1: { dv: "Float32", size: 4, typed: "Float32Array", kind: "number" },
  2: { dv: "Float64", size: 8, typed: "Float64Array", kind: "number" },
  4: { dv: "Uint8", size: 1, typed: "Uint8Array", kind: "number" }, // char
  5: { dv: "Uint16", size: 2, typed: "Uint16Array", kind: "number" }, // wchar
  6: { dv: "Uint8", size: 1, typed: "Uint8Array", kind: "bool" },
  7: { dv: "Uint8", size: 1, typed: "Uint8Array", kind: "number" }, // octet / byte
  8: { dv: "Uint8", size: 1, typed: "Uint8Array", kind: "number" },
  9: { dv: "Int8", size: 1, typed: "Int8Array", kind: "number" },
  10: { dv: "Uint16", size: 2, typed: "Uint16Array", kind: "number" },
  11: { dv: "Int16", size: 2, typed: "Int16Array", kind: "number" },
  12: { dv: "Uint32", size: 4, typed: "Uint32Array", kind: "number" },
  13: { dv: "Int32", size: 4, typed: "Int32Array", kind: "number" },
  14: { dv: "BigUint64", size: 8, typed: "BigUint64Array", kind: "bigint" },
  15: { dv: "BigInt64", size: 8, typed: "BigInt64Array", kind: "bigint" },
};
const STRING = 16;
const WSTRING = 17;
const MESSAGE = 18;

const helpers = {
  TypeError: TypeValidationError,
  num(v: unknown, field: string): number {
    const n = typeof v === "bigint" ? Number(v) : v;
    if (typeof n !== "number") throw new TypeValidationError(`field '${field}' expects a number, got ${typeof v}`);
    return n;
  },
  big(v: unknown, field: string): bigint {
    if (typeof v === "bigint") return v;
    if (typeof v === "number" && Number.isInteger(v)) return BigInt(v);
    throw new TypeValidationError(`field '${field}' expects an integer (bigint), got ${String(v)}`);
  },
  fill(dst: { length: number; [i: number]: unknown }, v: unknown, field: string, kind: Prim["kind"]): void {
    const src = v as ArrayLike<unknown> | null;
    if (!src || typeof src.length !== "number") throw new TypeValidationError(`field '${field}' expects an array`);
    if (src.length !== dst.length) throw new RangeValidationError(`field '${field}' needs ${dst.length} elements, got ${src.length}`);
    if (ArrayBuffer.isView(src) && (src as unknown as { constructor: unknown }).constructor === (dst as { constructor: unknown }).constructor) {
      (dst as unknown as { set(a: unknown): void }).set(src);
      return;
    }
    for (let i = 0; i < src.length; i++) {
      dst[i] = kind === "bool" ? (src[i] ? 1 : 0) : kind === "bigint" ? helpers.big(src[i], field) : helpers.num(src[i], field);
    }
  },
  fillViews(dst: { set(v: unknown): void }[], v: unknown, field: string): void {
    const src = v as ArrayLike<unknown> | null;
    if (!src || typeof src.length !== "number") throw new TypeValidationError(`field '${field}' expects an array`);
    if (src.length !== dst.length) throw new RangeValidationError(`field '${field}' needs ${dst.length} elements, got ${src.length}`);
    for (let i = 0; i < src.length; i++) dst[i]!.set(src[i]);
  },
};

export type ViewClass = new (dv: DataView, base: number) => MessageViewMethods<unknown>;

/** Field path of the first string or sequence, or null for fixed-size layouts. */
function variableField(layout: Layout, prefix = ""): string | null {
  for (const f of layout.fields) {
    const path = prefix + f.name;
    if (f.type === STRING || f.type === WSTRING || f.array < 0) return path;
    if (f.type === MESSAGE && f.message) {
      const inner = variableField(f.message, `${path}.`);
      if (inner) return inner;
    }
  }
  return null;
}

/** @internal compiles a view class for a fixed-size layout (exported for tests) */
export function compileView(layout: Layout, typeName: string): ViewClass {
  const variable = variableField(layout);
  if (variable) throw new TypeError(`${typeName}: field '${variable}' is a string or a sequence`);
  return compile(layout, typeName);
}

function compile(layout: Layout, typeName: string): ViewClass {
  const K: unknown[] = [helpers];
  const k = (v: unknown) => `K[${K.push(v) - 1}]`;
  const body: string[] = [];
  const toObject: string[] = [];
  const names: string[] = [];
  let cache = 0;
  for (const f of layout.fields) {
    const n = f.name;
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(n)) throw new TypeError(`${typeName}: unsupported field name '${n}'`);
    names.push(n);
    const at = `this.$b + ${f.offset}`;
    if (f.type === MESSAGE) {
      const inner = k(compile(f.message!, `${typeName}.${n}`));
      const c = `this.$${cache++}`;
      if (f.array === 0) {
        body.push(`get ${n}() { return ${c} ??= new ${inner}(this.$dv, ${at}); }`);
        body.push(`set ${n}(v) { this.${n}.set(v); }`);
        toObject.push(`${n}: this.${n}.toObject()`);
      } else {
        const stride = f.message!.size;
        body.push(`get ${n}() { return ${c} ??= Object.freeze(Array.from({ length: ${f.array} }, (_, i) => new ${inner}(this.$dv, ${at} + i * ${stride}))); }`);
        body.push(`set ${n}(v) { K[0].fillViews(this.${n}, v, ${JSON.stringify(n)}); }`);
        toObject.push(`${n}: this.${n}.map((e) => e.toObject())`);
      }
      continue;
    }
    const p = PRIMS[f.type];
    if (!p) throw new TypeError(`${typeName}: field '${n}' has a type that message views do not support (type id ${f.type})`);
    if (f.array === 0) {
      const le = p.size > 1 ? ", true" : "";
      const get = p.kind === "bool" ? `this.$dv.getUint8(${at}) !== 0` : `this.$dv.get${p.dv}(${at}${le})`;
      const val = p.kind === "bool" ? "v ? 1 : 0" : p.kind === "bigint" ? `K[0].big(v, ${JSON.stringify(n)})` : `K[0].num(v, ${JSON.stringify(n)})`;
      body.push(`get ${n}() { return ${get}; }`);
      body.push(`set ${n}(v) { this.$dv.set${p.dv}(${at}, ${val}${le}); }`);
      toObject.push(`${n}: this.${n}`);
    } else {
      const c = `this.$${cache++}`;
      body.push(`get ${n}() { return ${c} ??= new ${p.typed}(this.$dv.buffer, this.$dv.byteOffset + ${at}, ${f.array}); }`);
      body.push(`set ${n}(v) { K[0].fill(this.${n}, v, ${JSON.stringify(n)}, "${p.kind}"); }`);
      // same shapes as a decoded message: int64 and bool arrays are plain arrays
      toObject.push(
        p.kind === "bool" ? `${n}: Array.from(this.${n}, (b) => b !== 0)` : p.kind === "bigint" ? `${n}: Array.from(this.${n})` : `${n}: this.${n}.slice()`,
      );
    }
  }
  const src = `return class {
  constructor(dv, base) { this.$dv = dv; this.$b = base; }
  ${body.join("\n  ")}
  toObject() { return { ${toObject.join(", ")} }; }
  set(v) {
    if (v === null || typeof v !== "object") throw new K[0].TypeError("${typeName}: expected an object");
    for (const key of FIELDS) if (key in v && v[key] !== undefined) this[key] = v[key];
  }
  toJSON() { return this.toObject(); }
};
//# sourceURL=rclbunjs-view:${typeName}`;
  const fields = new Set(names);
  return new Function("K", "FIELDS", src)(K, fields) as ViewClass;
}

export interface ViewInfo {
  size: number;
  View: ViewClass;
}

/** Field path of the first string or sequence in a layout, or null if it is fixed-size. */
export function firstVariableField(layout: Layout): string | null {
  return variableField(layout);
}

/**
 * Creates a view over `size` bytes at `p`. `release()` detaches the memory so the
 * view and every array taken from it stop working instead of touching memory
 * that went back to the middleware.
 */
export function openView<T>(info: ViewInfo, p: Pointer): { view: MessageView<T>; release(): void } {
  const ab = toArrayBuffer(p, 0, info.size);
  return {
    view: new info.View(new DataView(ab), 0) as MessageView<T>,
    release: () => void ab.transfer(0),
  };
}

const keep = () => {};
// Addresses a ReusedViews remembers; middleware loans cycle through a small pool,
// and an entity that sees more distinct addresses than this starts over.
const MAX_REUSED = 64;

/**
 * @internal Views for publishers and subscriptions created with `reuseViews`: one
 * view per message address, kept instead of detached. An ArrayBuffer over n bytes
 * counts as n bytes of allocation for the garbage collector, so a fresh 1 MiB view
 * per message triggers a collection every few messages.
 */
export class ReusedViews {
  readonly #views = new Map<number, MessageViewMethods<unknown>>();

  constructor(readonly info: ViewInfo) {}

  open<T>(p: Pointer): { view: MessageView<T>; release(): void } {
    let view = this.#views.get(p as number);
    if (!view) {
      if (this.#views.size >= MAX_REUSED) this.#views.clear();
      view = new this.info.View(new DataView(toArrayBuffer(p, 0, this.info.size)), 0);
      this.#views.set(p as number, view);
    }
    return { view: view as MessageView<T>, release: keep };
  }

  clear(): void {
    this.#views.clear();
  }
}
