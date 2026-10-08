// Parameters, descriptors and ranges (semantics follow rclnodejs lib/parameter.js
// and rclcpp; integers are bigint, arrays are plain JS arrays).
import { RangeValidationError, TypeValidationError } from "./errors.ts";

export enum ParameterType {
  PARAMETER_NOT_SET = 0,
  PARAMETER_BOOL = 1,
  PARAMETER_INTEGER = 2,
  PARAMETER_DOUBLE = 3,
  PARAMETER_STRING = 4,
  PARAMETER_BYTE_ARRAY = 5,
  PARAMETER_BOOL_ARRAY = 6,
  PARAMETER_INTEGER_ARRAY = 7,
  PARAMETER_DOUBLE_ARRAY = 8,
  PARAMETER_STRING_ARRAY = 9,
}

export const DEFAULT_NUMERIC_RANGE_TOLERANCE = 1e-6;

const T = ParameterType;

function coerce(type: ParameterType, value: unknown, name: string): unknown {
  const bad = (): never => {
    throw new TypeValidationError(`parameter '${name}': value ${String(value)} does not match type ${ParameterType[type]}`);
  };
  const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : ArrayBuffer.isView(v) ? Array.from(v as unknown as ArrayLike<unknown>) : bad());
  switch (type) {
    case T.PARAMETER_NOT_SET:
      return undefined;
    case T.PARAMETER_BOOL:
      return typeof value === "boolean" ? value : bad();
    case T.PARAMETER_INTEGER:
      if (typeof value === "bigint") return value;
      if (typeof value === "number" && Number.isInteger(value)) return BigInt(value);
      return bad();
    case T.PARAMETER_DOUBLE:
      return typeof value === "number" ? value : typeof value === "bigint" ? Number(value) : bad();
    case T.PARAMETER_STRING:
      return typeof value === "string" ? value : bad();
    case T.PARAMETER_BYTE_ARRAY:
      return arr(value).map((x) => (typeof x === "number" && Number.isInteger(x) && x >= 0 && x <= 255 ? x : bad()));
    case T.PARAMETER_BOOL_ARRAY:
      return arr(value).map((x) => (typeof x === "boolean" ? x : bad()));
    case T.PARAMETER_INTEGER_ARRAY:
      return arr(value).map((x) => (typeof x === "bigint" ? x : typeof x === "number" && Number.isInteger(x) ? BigInt(x) : bad()));
    case T.PARAMETER_DOUBLE_ARRAY:
      return arr(value).map((x) => (typeof x === "number" ? x : bad()));
    case T.PARAMETER_STRING_ARRAY:
      return arr(value).map((x) => (typeof x === "string" ? x : bad()));
  }
  return bad();
}

/** Infers a ParameterType from a JS value (bigint -> INTEGER, number -> DOUBLE). */
export function inferParameterType(value: unknown): ParameterType {
  if (value === undefined || value === null) return T.PARAMETER_NOT_SET;
  if (typeof value === "boolean") return T.PARAMETER_BOOL;
  if (typeof value === "bigint") return T.PARAMETER_INTEGER;
  if (typeof value === "number") return T.PARAMETER_DOUBLE;
  if (typeof value === "string") return T.PARAMETER_STRING;
  if (value instanceof Uint8Array) return T.PARAMETER_BYTE_ARRAY;
  if (Array.isArray(value)) {
    const f = value[0];
    if (typeof f === "boolean") return T.PARAMETER_BOOL_ARRAY;
    if (typeof f === "bigint") return T.PARAMETER_INTEGER_ARRAY;
    if (typeof f === "number") return T.PARAMETER_DOUBLE_ARRAY;
    if (typeof f === "string") return T.PARAMETER_STRING_ARRAY;
  }
  throw new TypeValidationError(`cannot infer parameter type of ${String(value)}`);
}

export interface ParameterValueMsg {
  type: number;
  bool_value: boolean;
  integer_value: bigint;
  double_value: number;
  string_value: string;
  byte_array_value: Uint8Array | number[];
  bool_array_value: boolean[];
  integer_array_value: bigint[];
  double_array_value: Float64Array | number[];
  string_array_value: string[];
}

export class Parameter {
  readonly name: string;
  readonly type: ParameterType;
  #value: unknown;

  constructor(name: string, type: ParameterType, value?: unknown) {
    if (typeof name !== "string" || !name) throw new TypeValidationError("parameter name must be a non-empty string");
    this.name = name;
    this.type = type;
    this.#value = coerce(type, value, name);
  }

  get value(): any {
    return this.#value;
  }

  set value(v: unknown) {
    this.#value = coerce(this.type, v, this.name);
  }

  validate(): boolean {
    coerce(this.type, this.#value, this.name);
    return true;
  }

  toParameterValueMessage(): ParameterValueMsg {
    const v = this.#value;
    return {
      type: this.type,
      bool_value: this.type === T.PARAMETER_BOOL ? (v as boolean) : false,
      integer_value: this.type === T.PARAMETER_INTEGER ? (v as bigint) : 0n,
      double_value: this.type === T.PARAMETER_DOUBLE ? (v as number) : 0,
      string_value: this.type === T.PARAMETER_STRING ? (v as string) : "",
      byte_array_value: this.type === T.PARAMETER_BYTE_ARRAY ? (v as number[]) : [],
      bool_array_value: this.type === T.PARAMETER_BOOL_ARRAY ? (v as boolean[]) : [],
      integer_array_value: this.type === T.PARAMETER_INTEGER_ARRAY ? (v as bigint[]) : [],
      double_array_value: this.type === T.PARAMETER_DOUBLE_ARRAY ? (v as number[]) : [],
      string_array_value: this.type === T.PARAMETER_STRING_ARRAY ? (v as string[]) : [],
    };
  }

  toParameterMessage(): { name: string; value: ParameterValueMsg } {
    return { name: this.name, value: this.toParameterValueMessage() };
  }

  static valueFromMessage(m: ParameterValueMsg): unknown {
    switch (m.type) {
      case T.PARAMETER_BOOL: return m.bool_value;
      case T.PARAMETER_INTEGER: return m.integer_value;
      case T.PARAMETER_DOUBLE: return m.double_value;
      case T.PARAMETER_STRING: return m.string_value;
      case T.PARAMETER_BYTE_ARRAY: return Array.from(m.byte_array_value);
      case T.PARAMETER_BOOL_ARRAY: return [...m.bool_array_value];
      case T.PARAMETER_INTEGER_ARRAY: return [...m.integer_array_value];
      case T.PARAMETER_DOUBLE_ARRAY: return Array.from(m.double_array_value);
      case T.PARAMETER_STRING_ARRAY: return [...m.string_array_value];
    }
    return undefined;
  }

  static fromParameterMessage(m: { name: string; value: ParameterValueMsg }): Parameter {
    return new Parameter(m.name, m.value.type, Parameter.valueFromMessage(m.value));
  }

  /** From the shim's override JSON ({type: 'integer', value: '42'} etc.). */
  static fromOverride(name: string, o: { type: string; value: unknown }): Parameter {
    switch (o.type) {
      case "bool": return new Parameter(name, T.PARAMETER_BOOL, o.value);
      case "integer": return new Parameter(name, T.PARAMETER_INTEGER, BigInt(o.value as string));
      case "double": return new Parameter(name, T.PARAMETER_DOUBLE, o.value);
      case "string": return new Parameter(name, T.PARAMETER_STRING, o.value);
      case "bool_array": return new Parameter(name, T.PARAMETER_BOOL_ARRAY, o.value);
      case "integer_array": return new Parameter(name, T.PARAMETER_INTEGER_ARRAY, (o.value as string[]).map((x) => BigInt(x)));
      case "double_array": return new Parameter(name, T.PARAMETER_DOUBLE_ARRAY, o.value);
      case "string_array": return new Parameter(name, T.PARAMETER_STRING_ARRAY, o.value);
      case "byte_array": return new Parameter(name, T.PARAMETER_BYTE_ARRAY, o.value);
    }
    return new Parameter(name, T.PARAMETER_NOT_SET);
  }
}

abstract class Range {
  constructor(readonly fromValue: number | bigint, readonly toValue: number | bigint, readonly step: number | bigint) {}
  abstract inRange(v: unknown): boolean;
  abstract isValidType(t: ParameterType): boolean;
}

export class FloatingPointRange extends Range {
  readonly tolerance: number;
  constructor(from: number, to: number, step = 0, tolerance = DEFAULT_NUMERIC_RANGE_TOLERANCE) {
    super(from, to, step);
    this.tolerance = tolerance;
  }
  isValidType(t: ParameterType): boolean {
    return t === T.PARAMETER_DOUBLE || t === T.PARAMETER_DOUBLE_ARRAY;
  }
  inRange(v: unknown): boolean {
    const vals = Array.isArray(v) ? (v as number[]) : [v as number];
    const from = this.fromValue as number;
    const to = this.toValue as number;
    const step = this.step as number;
    const tol = this.tolerance;
    return vals.every((x) => {
      if (Math.abs(x - from) <= tol || Math.abs(x - to) <= tol) return true;
      if (x < from || x > to) return false;
      if (step === 0) return true;
      const k = (x - from) / step;
      return Math.abs(k - Math.round(k)) * step <= tol;
    });
  }
}

export class IntegerRange extends Range {
  constructor(from: bigint, to: bigint, step: bigint = 0n) {
    super(from, to, step);
  }
  isValidType(t: ParameterType): boolean {
    return t === T.PARAMETER_INTEGER || t === T.PARAMETER_INTEGER_ARRAY;
  }
  inRange(v: unknown): boolean {
    const vals = Array.isArray(v) ? (v as bigint[]) : [v as bigint];
    const from = this.fromValue as bigint;
    const to = this.toValue as bigint;
    const step = this.step as bigint;
    return vals.every((x) => {
      if (x === from || x === to) return true;
      if (x < from || x > to) return false;
      return step === 0n || (x - from) % step === 0n;
    });
  }
}

export class ParameterDescriptor {
  readonly name: string;
  type: ParameterType;
  description: string;
  readOnly: boolean;
  additionalConstraints = "";
  dynamicTyping = false;
  #range: Range | undefined;

  constructor(name: string, type: ParameterType = T.PARAMETER_NOT_SET, description = "", readOnly = false, range?: Range) {
    this.name = name;
    this.type = type;
    this.description = description;
    this.readOnly = readOnly;
    if (range) this.rangeConstraint = range;
  }

  get rangeConstraint(): Range | undefined {
    return this.#range;
  }

  set rangeConstraint(r: Range | undefined) {
    if (r && this.type !== T.PARAMETER_NOT_SET && !r.isValidType(this.type)) {
      throw new TypeValidationError(`range does not apply to parameter type ${ParameterType[this.type]}`);
    }
    this.#range = r;
  }

  hasRange(): boolean {
    return this.#range !== undefined;
  }

  validate(): boolean {
    if (this.#range && !this.#range.isValidType(this.type)) throw new TypeValidationError("invalid range for type");
    return true;
  }

  /** Throws if `p` violates this descriptor (type, range). Read-only is checked by the node. */
  validateParameter(p: Parameter): void {
    if (p.name !== this.name) throw new TypeValidationError(`descriptor/parameter name mismatch: ${this.name} vs ${p.name}`);
    if (!this.dynamicTyping && this.type !== T.PARAMETER_NOT_SET && p.type !== this.type) {
      throw new TypeValidationError(`parameter '${p.name}' must be of type ${ParameterType[this.type]}, got ${ParameterType[p.type]}`);
    }
    if (this.#range && p.type !== T.PARAMETER_NOT_SET && !this.#range.inRange(p.value)) {
      throw new RangeValidationError(`parameter '${p.name}' value ${String(p.value)} out of range`);
    }
  }

  toMessage() {
    const r = this.#range;
    return {
      name: this.name,
      type: this.type,
      description: this.description,
      additional_constraints: this.additionalConstraints,
      read_only: this.readOnly,
      dynamic_typing: this.dynamicTyping,
      floating_point_range: r instanceof FloatingPointRange ? [{ from_value: r.fromValue, to_value: r.toValue, step: r.step }] : [],
      integer_range: r instanceof IntegerRange ? [{ from_value: r.fromValue, to_value: r.toValue, step: r.step }] : [],
    };
  }

  static fromParameter(p: Parameter): ParameterDescriptor {
    return new ParameterDescriptor(p.name, p.type);
  }

  static fromMessage(m: ReturnType<ParameterDescriptor["toMessage"]>): ParameterDescriptor {
    const d = new ParameterDescriptor(m.name, m.type, m.description, m.read_only);
    d.additionalConstraints = m.additional_constraints;
    d.dynamicTyping = m.dynamic_typing ?? false;
    const f = m.floating_point_range?.[0];
    const i = m.integer_range?.[0];
    if (f) d.#range = new FloatingPointRange(f.from_value as number, f.to_value as number, f.step as number);
    if (i) d.#range = new IntegerRange(BigInt(i.from_value), BigInt(i.to_value), BigInt(i.step));
    return d;
  }
}
