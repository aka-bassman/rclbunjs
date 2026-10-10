// rclbunjs-typegen: JSDoc from interface comments (.msg/.srv/.action, or the
// annotations of an .idl-only interface), constants as literal types, and
// constants as properties of the runtime type descriptors.
import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

process.env.AMENT_PREFIX_PATH = join(import.meta.dir, "..", "fixtures", "ament");
const { parseIdlDocs, parseInterfaceDocs, jsdoc } = await import("../../src/interfaces/docs.ts");
const { generateDeclarations } = await import("../../src/interfaces/typegen.ts");
const { getActionType, getMessageType, getServiceType } = await import("../../src/interfaces/registry.ts");

describe("interface comments (rosidl_adapter rules)", () => {
  test("message description, comments above a field and trailing comments", () => {
    const docs = parseInterfaceDocs(
      [
        "# A camera frame.",
        "#   Second line, indented.",
        "",
        "# Pixel rows.",
        "uint32 height",
        "uint32 width  # pixel columns",
        "string NAME=\"a # b\"  # the '#' in the value is not a comment",
        "",
        "# kept: a blank line does not end a comment block",
        "",
        "uint8[] data",
        "# dropped: nothing follows",
      ].join("\n"),
      "msg",
    ).get("")!;
    expect(docs.doc).toBe("A camera frame.\n  Second line, indented.");
    expect(docs.members.get("height")).toBe("Pixel rows.");
    expect(docs.members.get("width")).toBe("pixel columns");
    expect(docs.members.get("NAME")).toBe("the '#' in the value is not a comment");
    expect(docs.members.get("data")).toBe("kept: a blank line does not end a comment block");
    expect(docs.members.size).toBe(4);
  });

  test("the comment lines at the top describe the message, blank line or not", () => {
    const docs = parseInterfaceDocs("# The value.\nint32 value\n", "msg").get("")!;
    expect(docs.doc).toBe("The value.");
    expect(docs.members.size).toBe(0);
    const indented = parseInterfaceDocs("\n# Not at the top.\nint32 value\n", "msg").get("")!;
    expect(indented.doc).toBeUndefined();
    expect(indented.members.get("value")).toBe("Not at the top.");
  });

  test("indented comment lines continue the previous field; blank lines are condensed", () => {
    const docs = parseInterfaceDocs(
      ["uint8 a", "string format   # The format.", "                #   - jpeg", "                #", "                #", "                #   - png", "uint8 b"].join("\n"),
      "msg",
    ).get("")!;
    expect(docs.members.get("format")).toBe("The format.\n  - jpeg\n\n  - png");
    expect(docs.members.has("b")).toBe(false);
  });

  test("a single [unit] is the unit of a field", () => {
    const docs = parseInterfaceDocs(
      ["float32 angle_min # start angle of the scan [rad]", "float32 range # [m]", "float32 two # [a] or [b]", "float32[] r # range data [m] (values < [min, max] are discarded)"].join("\n"),
      "msg",
    ).get("")!;
    expect(docs.members.get("angle_min")).toBe("start angle of the scan");
    expect(docs.units.get("angle_min")).toBe("rad");
    expect(docs.members.has("range")).toBe(false);
    expect(docs.units.get("range")).toBe("m");
    expect(docs.units.has("two")).toBe(false);
    expect(docs.members.get("r")).toBe("range data (values < [min, max] are discarded)");
    expect(docs.units.get("r")).toBe("m");
  });

  test("service and action sections", () => {
    const srv = parseInterfaceDocs("# Request doc.\n\nint64 a # first\n---\n# Response doc.\n\nint64 sum\n", "srv");
    expect(srv.get("_Request")!.doc).toBe("Request doc.");
    expect(srv.get("_Request")!.members.get("a")).toBe("first");
    expect(srv.get("_Response")!.doc).toBe("Response doc.");
    const action = parseInterfaceDocs("int32 order\n---\nint32[] sequence # result\n---\n# partial\nint32[] sequence\n", "action");
    expect(action.get("_Result")!.members.get("sequence")).toBe("result");
    expect(action.get("_Feedback")!.doc).toBe("partial");
  });

  test("every .msg/.srv/.action in the fixtures gives the docs rosidl_adapter wrote into its .idl", () => {
    const root = join(import.meta.dir, "..", "fixtures", "ament", "share");
    const suffixes: Record<string, string[]> = { msg: [""], srv: ["_Request", "_Response"], action: ["_Goal", "_Result", "_Feedback"] };
    const plain = (d?: { doc?: string; members: Map<string, string>; units: Map<string, string> }) =>
      d ? { doc: d.doc, members: Object.fromEntries(d.members), units: Object.fromEntries(d.units) } : { doc: undefined, members: {}, units: {} };
    let structs = 0;
    for (const pkg of readdirSync(root)) {
      for (const kind of ["msg", "srv", "action"] as const) {
        const dir = join(root, pkg, kind);
        if (!existsSync(dir)) continue;
        for (const f of readdirSync(dir).filter((f) => f.endsWith(`.${kind}`))) {
          const short = f.slice(0, -kind.length - 1);
          const fromMsg = parseInterfaceDocs(readFileSync(join(dir, f), "utf8"), kind);
          const fromIdl = parseIdlDocs(readFileSync(join(dir, `${short}.idl`), "utf8"));
          for (const s of suffixes[kind]!) {
            expect({ name: `${pkg}/${kind}/${short}${s}`, ...plain(fromMsg.get(s)) }).toEqual({ name: `${pkg}/${kind}/${short}${s}`, ...plain(fromIdl.get(short + s)) });
            structs++;
          }
        }
      }
    }
    expect(structs).toBeGreaterThan(150);
  });

  test(".idl: @verbatim comments of structs, members and constants, and @unit", () => {
    const docs = parseIdlDocs(readFileSync(join(import.meta.dir, "..", "fixtures", "ament", "share", "rclbun_idl_msgs", "msg", "Reading.idl"), "utf8"));
    expect([...docs.keys()]).toEqual(["Reading"]);
    const r = docs.get("Reading")!;
    expect(r.doc).toBe("A sensor reading.\n\nValues are in SI units.");
    expect(r.members.get("STATE_WARMUP")).toBe("The sensor is warming up.");
    expect(r.members.get("DEFAULT_SENSOR")).toBe('Name of the "default" sensor.');
    expect(r.members.get("accel")).toBe("Acceleration per axis.");
    expect(r.units.get("accel")).toBe("m/s^2");
    expect(r.members.get("state")).toBe("One of the STATE_* constants.");
    expect(r.members.has("samples")).toBe(false); // a // comment is not documentation
  });

  test("jsdoc blocks", () => {
    expect(jsdoc("  ", "one line")).toBe("  /** one line */\n");
    expect(jsdoc("  ", undefined)).toBe("");
    expect(jsdoc("", "a */ b\nc", ["@default 1"])).toBe("/**\n * a *\\/ b\n * c\n *\n * @default 1\n */\n");
  });
});

describe("generated declarations", () => {
  const { text, errors } = generateDeclarations({ packages: ["action_msgs", "std_msgs", "test_msgs", "example_interfaces", "builtin_interfaces", "unique_identifier_msgs"] });

  test("no errors", () => {
    expect(errors).toEqual([]);
  });

  test("message and field docs", () => {
    expect(text).toContain("   * Standard metadata for higher-level stamped data types.");
    expect(text).toContain("    /** Transform frame with which this data is associated. */\n    frame_id: string;");
  });

  test("constants as literal types, with docs, in MessageConstantsMap", () => {
    expect(text).toContain("    /** The goal was achieved successfully by the action server. */\n    readonly STATUS_SUCCEEDED: 4;");
    expect(text).toContain("    readonly INT64_CONST: -40000000n;");
    expect(text).toContain("    readonly BOOL_CONST: true;");
    expect(text).toContain('    "action_msgs/msg/GoalStatus": action_msgs__msg__GoalStatus__Constants;');
  });

  test("defaults and array bounds", () => {
    expect(text).toContain("    /** @default -40000000n */\n    int64_value: bigint;");
    expect(text).toMatch(/Fixed length: 3\.\s+\*\/\n\s+bool_values: boolean\[\];/);
    expect(text).toMatch(/At most 3 elements\./);
  });
});

describe("interfaces defined only in .idl", () => {
  const { text, errors, counts } = generateDeclarations({ packages: ["rclbun_idl_msgs"] });

  test("declarations with docs, units and constants", () => {
    expect(errors).toEqual([]);
    expect(counts).toEqual({ messages: 2, services: 1, actions: 0 });
    expect(text).toContain("   * A sensor reading.\n   *\n   * Values are in SI units.\n   *\n   * `rclbun_idl_msgs/msg/Reading`");
    expect(text).toContain("    /**\n     * Acceleration per axis.\n     *\n     * Unit: m/s^2.\n     * Fixed length: 3.\n     */\n    accel: Float64Array | number[];");
    expect(text).toContain("    /** The sensor is warming up. */\n    readonly STATE_WARMUP: 0;");
    expect(text).toContain("    readonly MIN_TICKS: -9007199254740993n;");
    expect(text).toContain('    "rclbun_idl_msgs/msg/Reading": rclbun_idl_msgs__msg__Reading__Constants;');
    expect(text).toContain("   * Starts a calibration.");
    expect(text).toContain("    /**\n     * Why it failed,\n     * if it did.\n     */\n    message: string;");
    expect(text).toContain("  interface rclbun_idl_msgs__msg__Ping {\n  }");
  });

  test("runtime: constants (64-bit as bigint), defaults and the empty struct", () => {
    const reading = getMessageType("rclbun_idl_msgs/msg/Reading") as any;
    expect(reading.STATE_READY).toBe(1);
    expect(reading.DEFAULT_SENSOR).toBe("imu; front");
    expect(reading.MIN_TICKS).toBe(-9007199254740993n);
    expect(reading.create().state).toBe(1);
    const back = reading.decode(reading.encode({ accel: [1, 2, 3], samples: [0.5], label: "x" }));
    expect(back.state).toBe(1);
    expect([...back.accel]).toEqual([1, 2, 3]);
    const ping = getMessageType("rclbun_idl_msgs/msg/Ping");
    expect(ping.decode(ping.encode({}))).toEqual({});
    expect(ping.encode({}).length).toBe(4 + 1); // CDR header + rosidl's placeholder byte
  });
});

describe("runtime constants (rclnodejs style)", () => {
  test("constants are properties of the type descriptor", () => {
    const status = getMessageType("action_msgs/msg/GoalStatus") as any;
    expect(status.STATUS_SUCCEEDED).toBe(4);
    expect(status.constants.STATUS_SUCCEEDED).toBe(4);
    expect((getMessageType("test_msgs/msg/Constants") as any).INT64_CONST).toBe(-40000000n);
  });

  test("Request/Response and Goal/Result/Feedback aliases", () => {
    const srv = getServiceType("example_interfaces/srv/AddTwoInts");
    expect(srv.Request).toBe(srv.request);
    expect(srv.Response).toBe(srv.response);
    const act = getActionType("example_interfaces/action/Fibonacci");
    expect(act.Goal).toBe(act.goal);
    expect(act.Result).toBe(act.result);
    expect(act.Feedback).toBe(act.feedback);
  });
});
