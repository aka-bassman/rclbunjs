// rclbunjs-typegen: JSDoc from interface comments, constants as literal types,
// and constants as properties of the runtime type descriptors.
import { describe, expect, test } from "bun:test";
import { join } from "node:path";

process.env.AMENT_PREFIX_PATH = join(import.meta.dir, "..", "fixtures", "ament");
const { parseInterfaceDocs, jsdoc } = await import("../../src/interfaces/docs.ts");
const { generateDeclarations } = await import("../../src/interfaces/typegen.ts");
const { getActionType, getMessageType, getServiceType } = await import("../../src/interfaces/registry.ts");

describe("interface comments", () => {
  test("message description, comments above a field and trailing comments", () => {
    const docs = parseInterfaceDocs(
      [
        "# A camera frame.",
        "# Second line.",
        "",
        "# Pixel rows.",
        "uint32 height",
        "uint32 width  # pixel columns",
        "string NAME=\"a # b\"  # the '#' in the value is not a comment",
        "",
        "# dropped: followed by a blank line",
        "",
        "uint8[] data",
      ].join("\n"),
      "msg",
    ).get("")!;
    expect(docs.doc).toBe("A camera frame.\nSecond line.");
    expect(docs.members.get("height")).toBe("Pixel rows.");
    expect(docs.members.get("width")).toBe("pixel columns");
    expect(docs.members.get("NAME")).toBe("the '#' in the value is not a comment");
    expect(docs.members.has("data")).toBe(false);
  });

  test("a comment directly above the first field belongs to the field", () => {
    const docs = parseInterfaceDocs("# The value.\nint32 value\n", "msg").get("")!;
    expect(docs.doc).toBeUndefined();
    expect(docs.members.get("value")).toBe("The value.");
  });

  test("service and action sections", () => {
    const srv = parseInterfaceDocs("# Request doc.\n\nint64 a # first\n---\n# Response doc.\n\nint64 sum\n", "srv");
    expect(srv.get("_Request")!.doc).toBe("Request doc.");
    expect(srv.get("_Request")!.members.get("a")).toBe("first");
    expect(srv.get("_Response")!.doc).toBe("Response doc.");
    const action = parseInterfaceDocs("int32 order\n---\nint32[] sequence # result\n---\n# partial\nint32[] sequence\n", "action");
    expect(action.get("_Result")!.members.get("sequence")).toBe("result");
    expect(action.get("_Feedback")!.members.get("sequence")).toBe("partial");
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
