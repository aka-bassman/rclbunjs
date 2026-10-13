// Message validation (rclnodejs lib/message_validation.js) over registry
// definitions. Accepts every input form the CDR codec encodes: number or
// bigint for integers, decimal strings for int64/uint64, TypedArrays, plain
// arrays and array-likes for sequences; a null field counts as missing (the
// codec encodes its default value).
import type { MessageDefinition, MessageDefinitionField } from "@foxglove/message-definition";
import { getMessageType, type MessageType, type TypeName } from "../interfaces/registry.ts";
import { MessageValidationError, TypeValidationError } from "./errors.ts";

export const ValidationProblem = {
  /** Field exists in object but not in message schema */
  UNKNOWN_FIELD: "UNKNOWN_FIELD",
  /** Field type doesn't match expected type */
  TYPE_MISMATCH: "TYPE_MISMATCH",
  /** Required field is missing */
  MISSING_FIELD: "MISSING_FIELD",
  /** Array length constraint violated */
  ARRAY_LENGTH: "ARRAY_LENGTH",
  /** Value is out of valid range (integer range, float32 range, string bound) */
  OUT_OF_RANGE: "OUT_OF_RANGE",
  /** Nested message validation failed */
  NESTED_ERROR: "NESTED_ERROR",
} as const;
export type ValidationProblem = (typeof ValidationProblem)[keyof typeof ValidationProblem];

/** Message type name ('pkg/msg/Name', 'pkg/Name', {package, type, name}) or a MessageType. */
export type MessageTypeLike = TypeName | MessageType;

export interface MessageFieldType {
  /** Primitive type ('string', 'float64', ...) or message name ('Vector3') */
  type: string;
  isPrimitiveType: boolean;
  isArray: boolean;
  /** Size of a fixed array or bound of a bounded sequence */
  arraySize?: number;
  isFixedSizeArray: boolean;
  isUpperBound: boolean;
  isDynamicArray: boolean;
  /** Package of a message type */
  pkgName?: string;
  stringUpperBound?: number;
  /** Full name of a message type ('pkg/msg/Name'), accepted by getMessageType() */
  typeName?: string;
}

export interface MessageField {
  name: string;
  type: MessageFieldType;
  default_value?: unknown;
}

export interface MessageConstant {
  name: string;
  type: string;
  value: unknown;
}

export interface MessageSchema {
  fields: MessageField[];
  constants: MessageConstant[];
  /** e.g. 'std_msgs/msg/String' */
  messageType: string;
  baseType?: { pkgName: string; type: string; isPrimitiveType: boolean };
}

export interface MessageValidationOptions {
  /** Report fields that are not in the schema (default false). */
  strict?: boolean;
  /** Check primitive types and value ranges (default true). */
  checkTypes?: boolean;
  /** Report missing fields (default false; encode fills them with defaults). */
  checkRequired?: boolean;
}

export interface MessageValidationIssue {
  /** Field path, e.g. 'linear.x', 'points[2].y', or '(root)' */
  field: string;
  problem: ValidationProblem | "INVALID_TYPE_CLASS";
  expected?: string;
  received?: unknown;
}

export interface MessageValidationResult {
  valid: boolean;
  issues: MessageValidationIssue[];
}

export type MessageValidator = (obj: unknown, options?: MessageValidationOptions) => MessageValidationResult;

const INT_RANGE: Record<string, [bigint, bigint]> = {
  int8: [-128n, 127n],
  uint8: [0n, 255n],
  int16: [-32768n, 32767n],
  uint16: [0n, 65535n],
  int32: [-(2n ** 31n), 2n ** 31n - 1n],
  uint32: [0n, 2n ** 32n - 1n],
  int64: [-(2n ** 63n), 2n ** 63n - 1n],
  uint64: [0n, 2n ** 64n - 1n],
};
INT_RANGE.byte = INT_RANGE.char = INT_RANGE.octet = INT_RANGE.uint8!;

// Sequences of these element types hold in-range values by construction.
const TYPED: Record<string, abstract new (...args: never[]) => ArrayBufferView> = {
  int8: Int8Array,
  uint8: Uint8Array,
  byte: Uint8Array,
  char: Uint8Array,
  octet: Uint8Array,
  int16: Int16Array,
  uint16: Uint16Array,
  int32: Int32Array,
  uint32: Uint32Array,
  int64: BigInt64Array,
  uint64: BigUint64Array,
  float32: Float32Array,
  float64: Float64Array,
};

const FLOAT32_MAX = 3.4028234663852886e38;

function valueType(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  if (ArrayBuffer.isView(v) && !(v instanceof DataView)) return "TypedArray";
  return typeof v;
}

const isMessageType = (t: unknown): t is MessageType =>
  typeof t === "object" && t !== null && Array.isArray((t as MessageType).definitions) && typeof (t as MessageType).encode === "function";

function resolve(t: MessageTypeLike): MessageType | null {
  if (isMessageType(t)) return t;
  try {
    return getMessageType(t);
  } catch {
    return null;
  }
}

function fieldType(f: MessageDefinitionField): MessageFieldType {
  const complex = f.isComplex === true;
  const parts = complex ? f.type.split("/") : [];
  const isArray = f.isArray === true;
  const fixed = isArray && f.arrayLength !== undefined;
  return {
    type: complex ? parts[parts.length - 1]! : f.type,
    isPrimitiveType: !complex,
    isArray,
    arraySize: isArray ? (f.arrayLength ?? f.arrayUpperBound) : undefined,
    isFixedSizeArray: fixed,
    isUpperBound: isArray && !fixed && f.arrayUpperBound !== undefined,
    isDynamicArray: isArray && !fixed,
    pkgName: complex ? parts[0] : undefined,
    stringUpperBound: f.upperBound,
    typeName: complex ? f.type : undefined,
  };
}

/** Schema of a message type (fields, constants), or null if the type cannot be resolved. */
export function getMessageSchema(typeClass: MessageTypeLike): MessageSchema | null {
  const mt = resolve(typeClass);
  const root = mt?.definitions[0];
  if (!mt || !root) return null;
  return {
    fields: root.definitions
      .filter((f) => !f.isConstant)
      .map((f) => ({ name: f.name, type: fieldType(f), default_value: f.defaultValue })),
    constants: root.definitions.filter((f) => f.isConstant).map((f) => ({ name: f.name, type: f.type, value: f.value })),
    messageType: mt.name,
    baseType: { pkgName: mt.pkg, type: mt.shortName, isPrimitiveType: false },
  };
}

export function getFieldNames(typeClass: MessageTypeLike): string[] {
  return getMessageSchema(typeClass)?.fields.map((f) => f.name) ?? [];
}

export function getFieldType(typeClass: MessageTypeLike, fieldName: string): MessageFieldType | null {
  return getMessageSchema(typeClass)?.fields.find((f) => f.name === fieldName)?.type ?? null;
}

interface Struct {
  fields: MessageDefinitionField[];
  names: Set<string>;
}

interface Ctx {
  defs: Map<string, MessageDefinition>;
  strict: boolean;
  checkTypes: boolean;
  checkRequired: boolean;
  issues: MessageValidationIssue[];
}

type Problem = Omit<MessageValidationIssue, "field">;

const defsCache = new WeakMap<MessageType, Map<string, MessageDefinition>>();
const structCache = new WeakMap<MessageDefinition, Struct>();

function definitionsOf(mt: MessageType): Map<string, MessageDefinition> {
  let m = defsCache.get(mt);
  if (!m) {
    m = new Map(mt.definitions.map((d) => [d.name ?? "", d]));
    defsCache.set(mt, m);
  }
  return m;
}

function structOf(d: MessageDefinition): Struct {
  let s = structCache.get(d);
  if (!s) {
    const fields = d.definitions.filter((f) => !f.isConstant);
    s = { fields, names: new Set(fields.map((f) => f.name)) };
    structCache.set(d, s);
  }
  return s;
}

const join = (path: string, name: string) => (path ? `${path}.${name}` : name);
const mismatch = (expected: string, v: unknown): Problem => ({
  problem: ValidationProblem.TYPE_MISMATCH,
  expected,
  received: valueType(v),
});

function checkPrimitive(v: unknown, f: MessageDefinitionField, checkTypes: boolean): Problem | null {
  const t = f.type;
  if (t === "string" || t === "wstring") {
    if (typeof v !== "string") return checkTypes ? mismatch("string", v) : null;
    if (f.upperBound !== undefined && v.length > f.upperBound) {
      return {
        problem: ValidationProblem.OUT_OF_RANGE,
        expected: `at most ${f.upperBound} characters`,
        received: `${v.length} characters`,
      };
    }
    return null;
  }
  if (!checkTypes) return null;
  if (t === "bool") return typeof v === "boolean" ? null : mismatch("boolean", v);
  if (t === "float32" || t === "float64") {
    if (typeof v !== "number" && typeof v !== "bigint") return mismatch("number", v);
    const x = Number(v);
    if (t === "float32" && Number.isFinite(x) && !Number.isFinite(Math.fround(x))) {
      return { problem: ValidationProblem.OUT_OF_RANGE, expected: `float32 in [-${FLOAT32_MAX}, ${FLOAT32_MAX}]`, received: v };
    }
    return null;
  }
  const range = INT_RANGE[t];
  if (!range) return null; // unknown primitive: the codec rejects it
  const wide = t === "int64" || t === "uint64";
  let x: number | bigint;
  if (typeof v === "number" || typeof v === "bigint") x = v;
  else if (wide && typeof v === "string" && /^-?\d+$/.test(v)) x = BigInt(v);
  else return mismatch(wide ? "bigint" : "number", v);
  const [lo, hi] = range;
  if ((typeof x === "number" && !Number.isInteger(x)) || x < lo || x > hi) {
    return { problem: ValidationProblem.OUT_OF_RANGE, expected: `integer in [${lo}, ${hi}]`, received: v };
  }
  return null;
}

function checkElement(v: unknown, f: MessageDefinitionField, path: string, c: Ctx): void {
  if (f.isComplex) {
    const d = c.defs.get(f.type);
    if (d) checkMessage(v, d, path, c);
    return;
  }
  const p = checkPrimitive(v, f, c.checkTypes);
  if (p) c.issues.push({ field: path, ...p });
}

function checkArray(v: unknown, f: MessageDefinitionField, path: string, c: Ctx): void {
  if (v === null || typeof v !== "object" || typeof (v as ArrayLike<unknown>).length !== "number") {
    c.issues.push({ field: path, ...mismatch("array", v) });
    return;
  }
  const arr = v as ArrayLike<unknown>;
  const n = arr.length;
  if (f.arrayLength !== undefined) {
    if (n !== f.arrayLength) {
      c.issues.push({
        field: path,
        problem: ValidationProblem.ARRAY_LENGTH,
        expected: `exactly ${f.arrayLength} elements`,
        received: `${n} elements`,
      });
      return;
    }
  } else if (f.arrayUpperBound !== undefined && n > f.arrayUpperBound) {
    c.issues.push({
      field: path,
      problem: ValidationProblem.ARRAY_LENGTH,
      expected: `at most ${f.arrayUpperBound} elements`,
      received: `${n} elements`,
    });
    return;
  }
  const typed = TYPED[f.type];
  if (typed && arr instanceof typed) return;
  for (let i = 0; i < n; i++) checkElement(arr[i], f, `${path}[${i}]`, c);
}

function checkMessage(v: unknown, d: MessageDefinition, path: string, c: Ctx): void {
  // nested null/undefined is encoded as the default message
  if (v === null || v === undefined) return;
  if (typeof v !== "object" || Array.isArray(v) || ArrayBuffer.isView(v)) {
    if (c.checkTypes) c.issues.push({ field: path, ...mismatch("object", v) });
    return;
  }
  const o = v as Record<string, unknown>;
  const s = structOf(d);
  if (c.strict) {
    for (const k of Object.keys(o)) {
      if (!s.names.has(k)) c.issues.push({ field: join(path, k), problem: ValidationProblem.UNKNOWN_FIELD });
    }
  }
  for (const f of s.fields) {
    const p = join(path, f.name);
    const x = o[f.name];
    if (x === undefined || x === null) {
      if (c.checkRequired) c.issues.push({ field: p, problem: ValidationProblem.MISSING_FIELD, expected: f.type });
    } else if (f.isArray) checkArray(x, f, p, c);
    else checkElement(x, f, p, c);
  }
}

function run(obj: unknown, mt: MessageType, options: MessageValidationOptions): MessageValidationResult {
  const c: Ctx = {
    defs: definitionsOf(mt),
    strict: options.strict ?? false,
    checkTypes: options.checkTypes ?? true,
    checkRequired: options.checkRequired ?? false,
    issues: [],
  };
  const t = typeof obj;
  const fields = mt.definitions[0]!.definitions.filter((f) => !f.isConstant);
  if ((t === "string" || t === "number" || t === "boolean" || t === "bigint") && fields.length === 1 && fields[0]!.name === "data") {
    // rclnodejs: a bare value stands for the single `data` field
    checkMessage({ data: obj }, mt.definitions[0]!, "", c);
  } else if (obj === null || t !== "object" || Array.isArray(obj) || ArrayBuffer.isView(obj)) {
    c.issues.push({ field: "(root)", ...mismatch("object", obj) });
  } else {
    checkMessage(obj, mt.definitions[0]!, "", c);
  }
  return { valid: c.issues.length === 0, issues: c.issues };
}

/** Validates a plain message object against its type; never throws. */
export function validateMessage(
  obj: unknown,
  typeClass: MessageTypeLike,
  options: MessageValidationOptions = {},
): MessageValidationResult {
  const mt = resolve(typeClass);
  if (!mt) {
    return {
      valid: false,
      issues: [
        {
          field: "(root)",
          problem: "INVALID_TYPE_CLASS",
          expected: "valid message type",
          received: typeof typeClass === "string" ? typeClass : valueType(typeClass),
        },
      ],
    };
  }
  return run(obj, mt, options);
}

function fail(mt: MessageType | string, issues: MessageValidationIssue[]): never {
  throw new MessageValidationError(typeof mt === "string" ? mt : mt.name, issues);
}

/** Throws MessageValidationError (details: { messageType, issues }) if `obj` is invalid. */
export function assertValidMessage(obj: unknown, typeClass: MessageTypeLike, options: MessageValidationOptions = {}): void {
  const mt = resolve(typeClass);
  const result = mt ? run(obj, mt, options) : validateMessage(obj, typeClass, options);
  if (!result.valid) fail(mt ?? String(typeClass), result.issues);
}

/** Resolves the type once and returns a reusable validator; per-call options override the defaults. */
export function createMessageValidator(typeClass: MessageTypeLike, defaultOptions: MessageValidationOptions = {}): MessageValidator {
  const mt = resolve(typeClass);
  if (!mt) {
    throw new TypeValidationError(`Invalid type for 'typeClass': expected valid message type, got ${String(typeClass)}`, {
      details: typeClass,
    });
  }
  return (obj, options = {}) => run(obj, mt, { ...defaultOptions, ...options });
}
