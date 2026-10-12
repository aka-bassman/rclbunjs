// Message validation API (rclnodejs test/test-message-validation.js) on fixture interfaces.
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { MessageValidationError, RangeValidationError, TypeValidationError, ValidationError } from "../../src/core/errors.ts";

process.env.AMENT_PREFIX_PATH = join(import.meta.dir, "..", "fixtures", "ament");
const { getMessageType } = await import("../../src/interfaces/registry.ts");
const {
  ValidationProblem: P,
  getMessageSchema,
  getFieldNames,
  getFieldType,
  validateMessage,
  assertValidMessage,
  createMessageValidator,
} = await import("../../src/core/messageValidation.ts");

/** Issues as [field, problem] pairs. */
const problems = (obj: unknown, type: string, options?: Parameters<typeof validateMessage>[2]) =>
  validateMessage(obj, type, options).issues.map((i) => [i.field, i.problem]);

describe("ValidationProblem", () => {
  test("problem types", () => {
    expect(P).toEqual({
      UNKNOWN_FIELD: "UNKNOWN_FIELD",
      TYPE_MISMATCH: "TYPE_MISMATCH",
      MISSING_FIELD: "MISSING_FIELD",
      ARRAY_LENGTH: "ARRAY_LENGTH",
      OUT_OF_RANGE: "OUT_OF_RANGE",
      NESTED_ERROR: "NESTED_ERROR",
    });
  });
});

describe("schema introspection", () => {
  test("getMessageSchema for std_msgs/msg/String", () => {
    const schema = getMessageSchema("std_msgs/msg/String")!;
    expect(schema.messageType).toBe("std_msgs/msg/String");
    expect(schema.baseType).toEqual({ pkgName: "std_msgs", type: "String", isPrimitiveType: false });
    expect(schema.fields).toHaveLength(1);
    expect(schema.fields[0]!.name).toBe("data");
    expect(schema.fields[0]!.type.type).toBe("string");
    expect(schema.fields[0]!.type.isPrimitiveType).toBe(true);
  });

  test("nested message fields", () => {
    const schema = getMessageSchema("geometry_msgs/Twist")!;
    expect(schema.messageType).toBe("geometry_msgs/msg/Twist");
    expect(schema.fields.map((f) => f.name)).toEqual(["linear", "angular"]);
    const linear = schema.fields[0]!.type;
    expect(linear.isPrimitiveType).toBe(false);
    expect(linear.type).toBe("Vector3");
    expect(linear.pkgName).toBe("geometry_msgs");
    expect(linear.typeName).toBe("geometry_msgs/msg/Vector3");
    // srv/action nested types keep their full name
    expect(getFieldType("example_interfaces/action/Fibonacci_FeedbackMessage", "feedback")?.typeName).toBe(
      "example_interfaces/action/Fibonacci_Feedback",
    );
  });

  test("array and bound metadata", () => {
    expect(getFieldType("test_msgs/msg/Arrays", "int32_values")).toMatchObject({
      type: "int32",
      isArray: true,
      arraySize: 3,
      isFixedSizeArray: true,
      isUpperBound: false,
      isDynamicArray: false,
    });
    expect(getFieldType("test_msgs/msg/BoundedSequences", "basic_types_values")).toMatchObject({
      type: "BasicTypes",
      isArray: true,
      arraySize: 3,
      isFixedSizeArray: false,
      isUpperBound: true,
      isDynamicArray: true,
    });
    expect(getFieldType("test_msgs/msg/UnboundedSequences", "int32_values")).toMatchObject({
      isArray: true,
      arraySize: undefined,
      isUpperBound: false,
      isDynamicArray: true,
    });
    expect(getFieldType("test_msgs/msg/Strings", "bounded_string_value")?.stringUpperBound).toBe(22);
    expect(getFieldType("test_msgs/msg/Strings", "string_value")?.stringUpperBound).toBeUndefined();
  });

  test("constants and default values", () => {
    const schema = getMessageSchema("test_msgs/msg/Constants")!;
    expect(schema.fields).toEqual([]);
    expect(schema.constants).toContainEqual({ name: "INT32_CONST", type: "int32", value: -30000 });
    const strings = getMessageSchema("test_msgs/msg/Strings")!;
    expect(strings.fields.map((f) => f.name)).not.toContain("STRING_CONST");
    expect(strings.fields.find((f) => f.name === "string_value_default1")?.default_value).toBe("Hello world!");
  });

  test("getFieldNames / getFieldType", () => {
    expect(getFieldNames("geometry_msgs/msg/Vector3")).toEqual(["x", "y", "z"]);
    expect(getFieldNames(getMessageType("std_msgs/msg/String"))).toEqual(["data"]);
    expect(getFieldNames({ package: "std_msgs", type: "msg", name: "Header" })).toEqual(["stamp", "frame_id"]);
    expect(getFieldType("std_msgs/msg/String", "data")?.type).toBe("string");
    expect(getFieldType("std_msgs/msg/String", "unknown_field")).toBeNull();
  });

  test("unresolvable types", () => {
    expect(getMessageSchema("nope_msgs/msg/Nope")).toBeNull();
    expect(getMessageSchema("not a type")).toBeNull();
    expect(getFieldNames("nope_msgs/msg/Nope")).toEqual([]);
    expect(getFieldType("nope_msgs/msg/Nope", "data")).toBeNull();
  });
});

describe("validateMessage", () => {
  test("valid messages", () => {
    expect(validateMessage({ data: "hello" }, "std_msgs/msg/String")).toEqual({ valid: true, issues: [] });
    expect(validateMessage({ data: "hello" }, "std_msgs/String").valid).toBe(true);
    expect(validateMessage({ data: "hello" }, getMessageType("std_msgs/msg/String")).valid).toBe(true);
    expect(validateMessage({}, "std_msgs/msg/String").valid).toBe(true); // missing fields get defaults
    expect(validateMessage({}, "test_msgs/msg/Empty").valid).toBe(true);
    const twist = { linear: { x: 1, y: 2, z: 3 }, angular: { x: 0, y: 0, z: 0.5 } };
    expect(validateMessage(twist, "geometry_msgs/msg/Twist").valid).toBe(true);
    const joint = {
      header: { stamp: { sec: 11223, nanosec: 44556 }, frame_id: "base" },
      name: ["a", "b"],
      position: Float64Array.from([1, 2]),
      velocity: [3, 4],
      effort: [],
    };
    expect(validateMessage(joint, "sensor_msgs/msg/JointState", { strict: true }).valid).toBe(true);
  });

  test("defaults and decoded output validate cleanly", () => {
    for (const name of [
      "test_msgs/msg/Arrays",
      "test_msgs/msg/BoundedSequences",
      "test_msgs/msg/UnboundedSequences",
      "test_msgs/msg/MultiNested",
      "test_msgs/msg/Defaults",
      "test_msgs/msg/Strings",
      "test_msgs/msg/WStrings",
      "sensor_msgs/msg/PointCloud2",
      "example_interfaces/action/Fibonacci_FeedbackMessage",
    ]) {
      const mt = getMessageType(name);
      const full = { strict: true, checkRequired: true };
      expect(validateMessage(mt.create(), mt, full)).toEqual({ valid: true, issues: [] });
      expect(validateMessage(mt.decode(mt.encode(mt.create())), mt, full)).toEqual({ valid: true, issues: [] });
    }
  });

  test("codec round-trips of rclpy golden vectors validate cleanly", async () => {
    const cases: { type: string; hex: string; value: unknown }[] = await Bun.file(
      join(import.meta.dir, "..", "fixtures", "golden.json"),
    ).json();
    // Python JSON -> encoder input form (numbers, plain arrays, {$int} -> bigint)
    const input = (v: any): any => {
      if (Array.isArray(v)) return v.map(input);
      if (v && typeof v === "object") {
        if ("$int" in v) return BigInt(v.$int);
        if ("$float" in v) return v.$float === "nan" ? NaN : v.$float === "inf" ? Infinity : -Infinity;
        return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, input(x)]));
      }
      return v;
    };
    for (const c of cases) {
      const mt = getMessageType(c.type);
      const decoded = mt.decode(Uint8Array.from(Buffer.from(c.hex, "hex")));
      expect([c.type, validateMessage(decoded, mt, { strict: true, checkRequired: true }).issues]).toEqual([c.type, []]);
      expect([c.type, validateMessage(input(c.value), mt, { strict: true }).issues]).toEqual([c.type, []]);
    }
  });

  test("wrong primitive types", () => {
    const r = validateMessage({ data: 123 }, "std_msgs/msg/String");
    expect(r.valid).toBe(false);
    expect(r.issues).toEqual([{ field: "data", problem: P.TYPE_MISMATCH, expected: "string", received: "number" }]);
    expect(validateMessage({ data: 1 }, "std_msgs/msg/Bool").issues[0]).toMatchObject({ expected: "boolean", received: "number" });
    expect(validateMessage({ data: "1" }, "std_msgs/msg/Int32").issues[0]).toMatchObject({ expected: "number", received: "string" });
    expect(validateMessage({ data: null }, "std_msgs/msg/Float64").issues[0]).toMatchObject({ expected: "number", received: "null" });
    expect(validateMessage({ data: [1] }, "std_msgs/msg/Float32").issues[0]).toMatchObject({ expected: "number", received: "array" });
    expect(problems({ x: "1", y: {}, z: 0 }, "geometry_msgs/msg/Vector3")).toEqual([
      ["x", P.TYPE_MISMATCH],
      ["y", P.TYPE_MISMATCH],
    ]);
  });

  test("integer ranges", () => {
    const bad: [string, unknown][] = [
      ["int8_value", 128],
      ["int8_value", -129],
      ["uint8_value", -1],
      ["byte_value", 256],
      ["char_value", 300],
      ["int16_value", 40000],
      ["uint16_value", 65536],
      ["int32_value", 2 ** 31],
      ["int32_value", 1.5],
      ["int32_value", NaN],
      ["uint32_value", 2 ** 32],
      ["uint32_value", -1n],
      ["int64_value", 2n ** 63n],
      ["int64_value", 2 ** 64],
      ["int64_value", 0.5],
      ["uint64_value", -1n],
      ["uint64_value", "18446744073709551616"],
    ];
    for (const [field, value] of bad) {
      const r = validateMessage({ [field]: value }, "test_msgs/msg/BasicTypes");
      expect([field, value, r.issues.map((i) => i.problem)]).toEqual([field, value, [P.OUT_OF_RANGE]]);
      expect(r.issues[0]!.received).toBe(value);
    }
    expect(validateMessage({ int8_value: 200 }, "test_msgs/msg/BasicTypes").issues[0]!.expected).toBe("integer in [-128, 127]");
    const ok = {
      int8_value: -128,
      uint8_value: 255,
      int16_value: 32767n, // the codec converts bigint to number
      uint32_value: 2 ** 32 - 1,
      int64_value: -(2n ** 63n),
      uint64_value: 2n ** 64n - 1n,
    };
    expect(validateMessage(ok, "test_msgs/msg/BasicTypes").valid).toBe(true);
  });

  test("float ranges", () => {
    expect(validateMessage({ float32_value: 1e39 }, "test_msgs/msg/BasicTypes").issues[0]?.problem).toBe(P.OUT_OF_RANGE);
    expect(validateMessage({ float64_value: 1e39, float32_value: 3.4e38 }, "test_msgs/msg/BasicTypes").valid).toBe(true);
    // non-finite values are representable
    for (const x of [NaN, Infinity, -Infinity]) {
      expect(validateMessage({ float32_value: x, float64_value: x }, "test_msgs/msg/BasicTypes").valid).toBe(true);
    }
  });

  test("int64/uint64 accept bigint, integer numbers and decimal strings", () => {
    for (const v of [5n, 5, -5, "123", "-9223372036854775808"]) {
      expect(validateMessage({ data: v }, "std_msgs/msg/Int64").valid).toBe(true);
    }
    expect(validateMessage({ data: 2n ** 64n - 1n }, "std_msgs/msg/UInt64").valid).toBe(true);
    expect(validateMessage({ data: "not-a-number" }, "std_msgs/msg/Int64").issues).toEqual([
      { field: "data", problem: P.TYPE_MISMATCH, expected: "bigint", received: "string" },
    ]);
    expect(validateMessage({ data: true }, "std_msgs/msg/UInt64").issues[0]?.problem).toBe(P.TYPE_MISMATCH);
    expect(validateMessage({ data: [1n, 2, "3"] }, "std_msgs/msg/Int64MultiArray").valid).toBe(true);
    expect(validateMessage({ data: BigInt64Array.from([1n, 2n]) }, "std_msgs/msg/Int64MultiArray").valid).toBe(true);
  });

  test("fixed-size arrays", () => {
    expect(validateMessage({ int32_values: [1, 2] }, "test_msgs/msg/Arrays").issues).toEqual([
      { field: "int32_values", problem: P.ARRAY_LENGTH, expected: "exactly 3 elements", received: "2 elements" },
    ]);
    expect(problems({ string_values: ["a", "b", "c", "d"] }, "test_msgs/msg/Arrays")).toEqual([["string_values", P.ARRAY_LENGTH]]);
    expect(problems({ uuid: new Uint8Array(15) }, "unique_identifier_msgs/msg/UUID")).toEqual([["uuid", P.ARRAY_LENGTH]]);
    const ok = { int32_values: Int32Array.from([1, 2, 3]), float64_values: [1, 2, 3], bool_values: [true, false, true] };
    expect(validateMessage(ok, "test_msgs/msg/Arrays").valid).toBe(true);
  });

  test("bounded sequences", () => {
    expect(validateMessage({ int32_values: [1, 2, 3, 4] }, "test_msgs/msg/BoundedSequences").issues).toEqual([
      { field: "int32_values", problem: P.ARRAY_LENGTH, expected: "at most 3 elements", received: "4 elements" },
    ]);
    expect(problems({ float64_values: new Float64Array(4) }, "test_msgs/msg/BoundedSequences")).toEqual([
      ["float64_values", P.ARRAY_LENGTH],
    ]);
    expect(problems({ basic_types_values: [{}, {}, {}, {}] }, "test_msgs/msg/BoundedSequences")).toEqual([
      ["basic_types_values", P.ARRAY_LENGTH],
    ]);
    expect(validateMessage({ int32_values: [], uint8_values: Uint8Array.of(1, 2, 3) }, "test_msgs/msg/BoundedSequences").valid).toBe(
      true,
    );
  });

  test("array elements and containers", () => {
    expect(validateMessage({ int32_values: [1, "bad", 3] }, "test_msgs/msg/UnboundedSequences").issues).toEqual([
      { field: "int32_values[1]", problem: P.TYPE_MISMATCH, expected: "number", received: "string" },
    ]);
    expect(problems({ uint8_values: [0, 256] }, "test_msgs/msg/UnboundedSequences")).toEqual([["uint8_values[1]", P.OUT_OF_RANGE]]);
    // a TypedArray of another element type is checked element by element
    expect(problems({ int8_values: Float64Array.of(1, 1.5) }, "test_msgs/msg/UnboundedSequences")).toEqual([
      ["int8_values[1]", P.OUT_OF_RANGE],
    ]);
    expect(problems({ bool_values: [true, 0] }, "test_msgs/msg/UnboundedSequences")).toEqual([["bool_values[1]", P.TYPE_MISMATCH]]);
    // array-likes are accepted by the encoder
    expect(validateMessage({ int32_values: { length: 2, 0: 1, 1: 2 } }, "test_msgs/msg/UnboundedSequences").valid).toBe(true);
    for (const v of [5, "abc", null, { a: 1 }]) {
      const r = validateMessage({ int32_values: v }, "test_msgs/msg/UnboundedSequences");
      expect(r.issues).toEqual([{ field: "int32_values", problem: P.TYPE_MISMATCH, expected: "array", received: r.issues[0]!.received }]);
    }
  });

  test("bounded strings", () => {
    expect(validateMessage({ bounded_string_value: "x".repeat(22) }, "test_msgs/msg/Strings").valid).toBe(true);
    expect(validateMessage({ bounded_string_value: "x".repeat(23) }, "test_msgs/msg/Strings").issues).toEqual([
      { field: "bounded_string_value", problem: P.OUT_OF_RANGE, expected: "at most 22 characters", received: "23 characters" },
    ]);
    expect(validateMessage({ string_value: "x".repeat(1000) }, "test_msgs/msg/Strings").valid).toBe(true);
  });

  test("nested messages report field paths", () => {
    const twist = { linear: { x: "not a number", y: 2, z: 3 }, angular: { x: 0, y: 0, z: 0.5 } };
    expect(validateMessage(twist, "geometry_msgs/msg/Twist").issues).toEqual([
      { field: "linear.x", problem: P.TYPE_MISMATCH, expected: "number", received: "string" },
    ]);
    expect(problems({ header: { stamp: { sec: 1.5 }, frame_id: 7 } }, "sensor_msgs/msg/JointState")).toEqual([
      ["header.stamp.sec", P.OUT_OF_RANGE],
      ["header.frame_id", P.TYPE_MISMATCH],
    ]);
    const seq = { basic_types_values: [{ int8_value: 1 }, { int8_value: 1000, bool_value: "yes" }] };
    expect(problems(seq, "test_msgs/msg/UnboundedSequences")).toEqual([
      ["basic_types_values[1].bool_value", P.TYPE_MISMATCH],
      ["basic_types_values[1].int8_value", P.OUT_OF_RANGE],
    ]);
    const multi = { unbounded_sequence_of_bounded_sequences: [{}, { int32_values: [1, 2, 3, 4] }] };
    expect(problems(multi, "test_msgs/msg/MultiNested")).toEqual([
      ["unbounded_sequence_of_bounded_sequences[1].int32_values", P.ARRAY_LENGTH],
    ]);
    const feedback = { goal_id: { uuid: [1, 2] }, feedback: { sequence: [0, 1, "2"] } };
    expect(problems(feedback, "example_interfaces/action/Fibonacci_FeedbackMessage")).toEqual([
      ["goal_id.uuid", P.ARRAY_LENGTH],
      ["feedback.sequence[2]", P.TYPE_MISMATCH],
    ]);
  });

  test("nested message values", () => {
    expect(validateMessage({ linear: 5 }, "geometry_msgs/msg/Twist").issues).toEqual([
      { field: "linear", problem: P.TYPE_MISMATCH, expected: "object", received: "number" },
    ]);
    expect(problems({ linear: [1, 2, 3] }, "geometry_msgs/msg/Twist")).toEqual([["linear", P.TYPE_MISMATCH]]);
    // null nested messages are encoded with default values
    expect(validateMessage({ linear: null, angular: undefined }, "geometry_msgs/msg/Twist").valid).toBe(true);
    expect(validateMessage({ basic_types_values: [null, {}] }, "test_msgs/msg/UnboundedSequences").valid).toBe(true);
  });

  test("unknown fields are reported only in strict mode", () => {
    const msg = { data: "hello", unknown_field: "value" };
    expect(validateMessage(msg, "std_msgs/msg/String").valid).toBe(true);
    expect(validateMessage(msg, "std_msgs/msg/String", { strict: false }).valid).toBe(true);
    expect(validateMessage(msg, "std_msgs/msg/String", { strict: true }).issues).toEqual([
      { field: "unknown_field", problem: P.UNKNOWN_FIELD },
    ]);
    const twist = { linear: { x: 1, w: 2 }, angular: {}, extra: 1 };
    expect(problems(twist, "geometry_msgs/msg/Twist", { strict: true })).toEqual([
      ["extra", P.UNKNOWN_FIELD],
      ["linear.w", P.UNKNOWN_FIELD],
    ]);
    // constants are not fields
    expect(problems({ INT32_CONST: 1 }, "test_msgs/msg/Constants", { strict: true })).toEqual([["INT32_CONST", P.UNKNOWN_FIELD]]);
  });

  test("checkRequired reports missing fields", () => {
    expect(validateMessage({}, "std_msgs/msg/String", { checkRequired: true }).issues).toEqual([
      { field: "data", problem: P.MISSING_FIELD, expected: "string" },
    ]);
    expect(problems({ linear: { x: 1 } }, "geometry_msgs/msg/Twist", { checkRequired: true })).toEqual([
      ["linear.y", P.MISSING_FIELD],
      ["linear.z", P.MISSING_FIELD],
      ["angular", P.MISSING_FIELD],
    ]);
  });

  test("checkTypes: false keeps structural checks only", () => {
    const msg = { int32_values: [1, "x"], bool_values: "no", string_values: [1], basic_types_values: [{ int8_value: "a" }] };
    expect(problems(msg, "test_msgs/msg/UnboundedSequences", { checkTypes: false })).toEqual([["bool_values", P.TYPE_MISMATCH]]);
    expect(problems({ int32_values: [1, 2, 3, 4] }, "test_msgs/msg/BoundedSequences", { checkTypes: false })).toEqual([
      ["int32_values", P.ARRAY_LENGTH],
    ]);
    expect(problems({ bounded_string_value: "x".repeat(30) }, "test_msgs/msg/Strings", { checkTypes: false })).toEqual([
      ["bounded_string_value", P.OUT_OF_RANGE],
    ]);
    expect(validateMessage({ data: 1 }, "std_msgs/msg/String", { checkTypes: false }).valid).toBe(true);
  });

  test("bare values stand for a single data field", () => {
    expect(validateMessage("hello", "std_msgs/msg/String").valid).toBe(true);
    expect(validateMessage(true, "std_msgs/msg/Bool").valid).toBe(true);
    expect(validateMessage(5n, "std_msgs/msg/Int64").valid).toBe(true);
    const r = validateMessage(123, "std_msgs/msg/String");
    expect(r.valid).toBe(false);
    expect(r.issues[0]).toMatchObject({ field: "data", problem: P.TYPE_MISMATCH });
    expect(validateMessage(300, "std_msgs/msg/UInt8").issues[0]).toMatchObject({ field: "data", problem: P.OUT_OF_RANGE });
    // not a single-`data` message
    expect(validateMessage(1, "geometry_msgs/msg/Twist").issues[0]).toMatchObject({ field: "(root)", problem: P.TYPE_MISMATCH });
  });

  test("non-object messages", () => {
    for (const v of [null, undefined, [1], new Uint8Array(1)]) {
      const r = validateMessage(v, "std_msgs/msg/String");
      expect(r.valid).toBe(false);
      expect(r.issues).toHaveLength(1);
      expect(r.issues[0]).toMatchObject({ field: "(root)", problem: P.TYPE_MISMATCH, expected: "object" });
    }
    expect(validateMessage(null, "std_msgs/msg/String").issues[0]!.received).toBe("null");
  });

  test("invalid type", () => {
    for (const t of ["nope_msgs/msg/Nope", "NotAType", { package: "nope", type: "msg", name: "X" }]) {
      const r = validateMessage({}, t);
      expect(r.valid).toBe(false);
      expect(r.issues[0]).toMatchObject({ field: "(root)", problem: "INVALID_TYPE_CLASS" });
    }
    // services are not message types
    expect(validateMessage({}, "example_interfaces/srv/AddTwoInts").issues[0]!.problem).toBe("INVALID_TYPE_CLASS");
    expect(validateMessage({ a: 1n, b: 2 }, "example_interfaces/srv/AddTwoInts_Request").valid).toBe(true);
  });

  test("agrees with the codec on size violations", () => {
    const cases: [string, unknown][] = [
      ["test_msgs/msg/Arrays", { int32_values: [1, 2] }],
      ["test_msgs/msg/BoundedSequences", { string_values: ["a", "b", "c", "d"] }],
      ["test_msgs/msg/Strings", { bounded_string_value: "x".repeat(23) }],
    ];
    for (const [type, msg] of cases) {
      expect(validateMessage(msg, type).valid).toBe(false);
      expect(() => getMessageType(type).encode(msg)).toThrow(RangeValidationError);
    }
  });
});

describe("assertValidMessage", () => {
  test("passes valid messages", () => {
    expect(() => assertValidMessage({ data: "hello" }, "std_msgs/msg/String")).not.toThrow();
    expect(() => assertValidMessage({ data: 5 }, getMessageType("std_msgs/msg/Int64"))).not.toThrow();
  });

  test("throws MessageValidationError with the issues", () => {
    let err: unknown;
    try {
      assertValidMessage({ data: 123 }, "std_msgs/String");
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(MessageValidationError);
    expect(err).toBeInstanceOf(ValidationError);
    const e = err as MessageValidationError;
    expect(e.code).toBe("MESSAGE_VALIDATION_ERROR");
    expect(e.message).toBe("Invalid message for 'std_msgs/msg/String': data: TYPE_MISMATCH");
    expect(e.entityType).toBe("message");
    expect(e.entityName).toBe("std_msgs/msg/String");
    expect(e.messageType).toBe("std_msgs/msg/String");
    expect(e.issues.map((i) => i.field)).toEqual(["data"]);
    expect(e.hasFieldIssue("data")).toBe(true);
    expect(e.getIssuesByType("TYPE_MISMATCH")).toHaveLength(1);
    expect(e.details).toEqual({
      messageType: "std_msgs/msg/String",
      issues: [{ field: "data", problem: "TYPE_MISMATCH", expected: "string", received: "number" }],
    });
  });

  test("respects options", () => {
    const msg = { data: "hello", unknown: "field" };
    expect(() => assertValidMessage(msg, "std_msgs/msg/String")).not.toThrow();
    expect(() => assertValidMessage(msg, "std_msgs/msg/String", { strict: true })).toThrow(MessageValidationError);
    expect(() => assertValidMessage({}, "std_msgs/msg/String", { checkRequired: true })).toThrow(MessageValidationError);
  });

  test("invalid type", () => {
    expect(() => assertValidMessage({}, "nope_msgs/msg/Nope")).toThrow(MessageValidationError);
  });
});

describe("createMessageValidator", () => {
  test("reusable validator with default options", () => {
    const validate = createMessageValidator("std_msgs/msg/String", { strict: true });
    expect(typeof validate).toBe("function");
    for (let i = 0; i < 3; i++) {
      expect(validate({ data: `hello ${i}` })).toEqual({ valid: true, issues: [] });
      expect(validate({ data: "hello", extra: i }).valid).toBe(false);
      expect(validate({ data: i }).issues).toEqual([{ field: "data", problem: P.TYPE_MISMATCH, expected: "string", received: "number" }]);
    }
  });

  test("per-call options override defaults", () => {
    const validate = createMessageValidator("std_msgs/msg/String", { strict: true });
    expect(validate({ data: "hello", extra: "field" }, { strict: false }).valid).toBe(true);
    expect(validate({}, { checkRequired: true }).issues[0]!.problem).toBe(P.MISSING_FIELD);
    expect(validate({ data: 1 }, { checkTypes: false }).valid).toBe(true);
  });

  test("accepts a MessageType and nested types", () => {
    const validate = createMessageValidator(getMessageType("sensor_msgs/msg/PointCloud2"));
    expect(validate({ fields: [{ name: "x", offset: 0, datatype: 7, count: 1 }] }).valid).toBe(true);
    expect(validate({ fields: [{ name: "x", datatype: 300 }] }).issues).toEqual([
      { field: "fields[0].datatype", problem: P.OUT_OF_RANGE, expected: "integer in [0, 255]", received: 300 },
    ]);
  });

  test("throws TypeValidationError for an invalid type", () => {
    expect(() => createMessageValidator("nope_msgs/msg/Nope")).toThrow(TypeValidationError);
    expect(() => createMessageValidator(null as never)).toThrow(TypeValidationError);
  });
});
