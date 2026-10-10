import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import * as rclbun from "../../src/index.ts";

// Cyclone DDS over shared memory (RCLBUN_CYCLONE_SHM=1) does not deliver the transient-local
// ros_discovery_info history to late joiners, so the ros2 CLI never learns node names
// (rclpy nodes alike); the CLI test is skipped there.
const cycloneShm = /SharedMemory|PubSubMessageExchange/.test(process.env.CYCLONEDDS_URI ?? "");

const { Parameter, ParameterType: PT, ParameterDescriptor, FloatingPointRange, IntegerRange } = rclbun;

const until = async (cond: () => boolean | Promise<boolean>, ms = 10000) => {
  const end = Date.now() + ms;
  while (!(await cond()) && Date.now() < end) await Bun.sleep(20);
  return cond();
};

let ctx: rclbun.Context;
let node: rclbun.Node;
beforeAll(async () => {
  writeFileSync(
    "/tmp/rclbun_params.yaml",
    `/**:\n  ros__parameters:\n    from_yaml: "hi"\n    shared: 1\nparam_node:\n  ros__parameters:\n    shared: 7\n    ratio: 3\n    names: [a, b]\n`,
  );
  ctx = new rclbun.Context();
  await rclbun.init(ctx, ["bun", "--ros-args", "-p", "gain:=2.5", "-p", "count:=3", "--params-file", "/tmp/rclbun_params.yaml"]);
  node = rclbun.createNode("param_node", "", ctx);
  node.spin();
});
afterAll(() => ctx.shutdown());

describe("local parameters", () => {
  test("declare, get, set, undeclare", () => {
    const p = node.declareParameter(new Parameter("speed", PT.PARAMETER_DOUBLE, 1.0));
    expect(p.value).toBe(1.0);
    expect(node.getParameter("speed").value).toBe(1.0);
    expect(node.setParameter(new Parameter("speed", PT.PARAMETER_DOUBLE, 2.0)).successful).toBe(true);
    expect(node.getParameter("speed").value).toBe(2.0);
    const bad = node.setParameter(new Parameter("speed", PT.PARAMETER_STRING, "fast"));
    expect(bad.successful).toBe(false);
    expect(node.setParameter(new Parameter("undeclared", PT.PARAMETER_BOOL, true)).successful).toBe(false);
    expect(() => node.declareParameter(new Parameter("speed", PT.PARAMETER_DOUBLE, 1.0))).toThrow();
    node.undeclareParameter("speed");
    expect(node.hasParameter("speed")).toBe(false);
    expect(node.getParameter("speed").type).toBe(PT.PARAMETER_NOT_SET);
  });

  test("descriptors: read-only and ranges", () => {
    const d = new ParameterDescriptor("ro", PT.PARAMETER_INTEGER, "read only", true);
    node.declareParameter(new Parameter("ro", PT.PARAMETER_INTEGER, 5n), d);
    expect(node.setParameter(new Parameter("ro", PT.PARAMETER_INTEGER, 6n)).successful).toBe(false);
    const rd = new ParameterDescriptor("pct", PT.PARAMETER_DOUBLE);
    rd.rangeConstraint = new FloatingPointRange(0, 1, 0.25);
    node.declareParameter(new Parameter("pct", PT.PARAMETER_DOUBLE, 0.5), rd);
    expect(node.setParameter(new Parameter("pct", PT.PARAMETER_DOUBLE, 0.75)).successful).toBe(true);
    expect(node.setParameter(new Parameter("pct", PT.PARAMETER_DOUBLE, 0.6)).successful).toBe(false);
    expect(node.setParameter(new Parameter("pct", PT.PARAMETER_DOUBLE, 1.5)).successful).toBe(false);
    const ir = new ParameterDescriptor("lvl", PT.PARAMETER_INTEGER);
    ir.rangeConstraint = new IntegerRange(0n, 10n, 2n);
    node.declareParameter(new Parameter("lvl", PT.PARAMETER_INTEGER, 4n), ir);
    expect(node.setParameter(new Parameter("lvl", PT.PARAMETER_INTEGER, 5n)).successful).toBe(false);
  });

  test("callbacks: on-set veto, pre-set rewrite, post-set", () => {
    node.declareParameter(new Parameter("mode", PT.PARAMETER_STRING, "auto"));
    const veto = (ps: rclbun.Parameter[]) => ({ successful: !ps.some((p) => p.value === "forbidden"), reason: "nope" });
    const seen: string[] = [];
    const post = (ps: rclbun.Parameter[]) => seen.push(...ps.map((p) => String(p.value)));
    const pre = (ps: rclbun.Parameter[]) => ps.map((p) => (p.value === "MANUAL" ? new Parameter(p.name, p.type, "manual") : p));
    node.addOnSetParametersCallback(veto);
    node.addPostSetParametersCallback(post);
    node.addPreSetParametersCallback(pre);
    expect(node.setParameter(new Parameter("mode", PT.PARAMETER_STRING, "forbidden")).reason).toBe("nope");
    expect(node.setParameter(new Parameter("mode", PT.PARAMETER_STRING, "MANUAL")).successful).toBe(true);
    expect(node.getParameter("mode").value).toBe("manual");
    expect(seen).toEqual(["manual"]);
    node.removeOnSetParametersCallback(veto);
    node.removePostSetParametersCallback(post);
    node.removePreSetParametersCallback(pre);
  });

  test("overrides from --ros-args -p and --params-file", () => {
    expect(node.declareParameter(new Parameter("gain", PT.PARAMETER_DOUBLE, 1.0)).value).toBe(2.5);
    expect(node.declareParameter(new Parameter("count", PT.PARAMETER_INTEGER, 0n)).value).toBe(3n);
    expect(node.declareParameter(new Parameter("from_yaml", PT.PARAMETER_STRING, "")).value).toBe("hi");
    // exact node match wins over the wildcard
    expect(node.declareParameter(new Parameter("shared", PT.PARAMETER_INTEGER, 0n)).value).toBe(7n);
    // YAML integer accepted for a double parameter
    expect(node.declareParameter(new Parameter("ratio", PT.PARAMETER_DOUBLE, 0)).value).toBe(3);
    expect(node.declareParameter(new Parameter("names", PT.PARAMETER_STRING_ARRAY, [])).value).toEqual(["a", "b"]);
    expect(node.declareParameter(new Parameter("gain2", PT.PARAMETER_DOUBLE, 1.0), undefined, true).value).toBe(1.0);
  });

  test("node-local argument overrides win over global ones", () => {
    const local = rclbun.createNode("param_local", "", ctx, {}, ["-p", "gain:=9.5", "-p", "flags:=[true, false]"]);
    expect(local.declareParameter(new Parameter("gain", PT.PARAMETER_DOUBLE, 0)).value).toBe(9.5);
    expect(local.declareParameter(new Parameter("flags", PT.PARAMETER_BOOL_ARRAY, [])).value).toEqual([true, false]);
    expect(local.declareParameter(new Parameter("from_yaml", PT.PARAMETER_STRING, "")).value).toBe("hi");
    local.destroy();
  });
});

describe("remote access", () => {
  const sh = (cmd: string) => {
    const r = Bun.spawnSync(["bash", "-c", cmd], { env: { ...process.env } });
    return r.stdout.toString() + r.stderr.toString();
  };

  test.skipIf(cycloneShm)("ros2 param CLI against the bun node", async () => {
    node.declareParameter(new Parameter("cli_param", PT.PARAMETER_INTEGER, 10n));
    const cli = async (args: string) => (await Bun.$`ros2 param ${{ raw: args }} --no-daemon`.nothrow().quiet()).text();
    // discovery of a fresh CLI participant can take a moment
    let listed = "";
    for (let i = 0; i < 10 && !listed.includes("cli_param"); i++) listed = await cli("list /param_node");
    expect(listed).toContain("cli_param");
    expect(await cli("get /param_node cli_param")).toContain("Integer value is: 10");
    expect(await cli("set /param_node cli_param 42")).toContain("Set parameter successful");
    expect(node.getParameter("cli_param").value).toBe(42n);
    expect(await cli("describe /param_node cli_param")).toContain("Type: integer");
    void sh;
  }, 180000);

  test("ParameterClient against an rclpy node", async () => {
    const p = Bun.spawn(["python3", "-c", `
import rclpy
rclpy.init(); n = rclpy.create_node('py_params')
n.declare_parameter('rate', 10.0); n.declare_parameter('label', 'x'); n.declare_parameter('ids', [1, 2])
rclpy.spin(n)
`]);
    const pc = node.createParameterClient("/py_params", { timeout: 5000 });
    expect(await pc.waitForService(15000)).toBe(true);
    const [rate, label, ids] = await pc.getParameters(["rate", "label", "ids"]);
    expect(rate!.value).toBe(10.0);
    expect(label!.value).toBe("x");
    expect(ids!.value).toEqual([1n, 2n]);
    const r = await pc.setParameter("rate", 20);
    expect(r.successful).toBe(true);
    expect((await pc.getParameter("rate")).value).toBe(20);
    const list = await pc.listParameters();
    expect(list.names).toContain("label");
    const types = await pc.getParameterTypes(["ids"]);
    expect(types[0]).toBe(PT.PARAMETER_INTEGER_ARRAY);
    pc.destroy();
    p.kill();
  }, 60000);

  test("parameter events are published", async () => {
    let ev: any;
    node.createSubscription("rcl_interfaces/msg/ParameterEvent", "/parameter_events", (m: any) => {
      if (m.node === "/param_node") ev = m;
    });
    await Bun.sleep(200);
    node.declareParameter(new Parameter("evt", PT.PARAMETER_BOOL, true));
    expect(await until(() => ev?.new_parameters?.[0]?.name === "evt")).toBe(true);
  });
});

describe("parameter event handler / watcher", () => {
  test("callbacks fire for a watched parameter", async () => {
    const other = rclbun.createNode("watched_node", "", ctx);
    other.declareParameter(new Parameter("level", PT.PARAMETER_INTEGER, 1n));
    const h = node.createParameterEventHandler();
    const seen: bigint[] = [];
    h.addParameterCallback("level", "/watched_node", (p) => seen.push(p.value));
    const w = node.createParameterWatcher("/watched_node", ["level"]);
    expect(await w.start(5000)).toBe(true);
    const changes: rclbun.Parameter[][] = [];
    w.on("change", (ps: rclbun.Parameter[]) => changes.push(ps));
    other.spin();
    await Bun.sleep(300);
    other.setParameter(new Parameter("level", PT.PARAMETER_INTEGER, 2n));
    expect(await until(() => seen.includes(2n) && changes.length > 0)).toBe(true);
    expect((await w.getCurrentValues({ timeout: 3000 }))[0]!.value).toBe(2n);
    w.destroy();
    h.destroy();
    other.destroy();
  }, 20000);
});

describe("time source", () => {
  test("use_sim_time follows /clock", async () => {
    const clockPub = node.createPublisher("rosgraph_msgs/msg/Clock", "/clock");
    expect(node.getClock().isRosTimeActive).toBe(false);
    expect(node.setParameter(new Parameter("use_sim_time", PT.PARAMETER_BOOL, true)).successful).toBe(true);
    expect(node.getClock().isRosTimeActive).toBe(true);
    const ok = await until(() => {
      clockPub.publish({ clock: { sec: 1234, nanosec: 5 } });
      return node.now().nanoseconds === 1234_000_000_005n;
    }, 5000);
    expect(ok).toBe(true);
    node.setParameter(new Parameter("use_sim_time", PT.PARAMETER_BOOL, false));
    expect(node.getClock().isRosTimeActive).toBe(false);
    expect(node.now().nanoseconds).toBeGreaterThan(1_700_000_000_000_000_000n);
  });
});
