import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { filter, firstValueFrom, map, take, toArray } from "rxjs";
import rclbunDefault, * as rclbun from "../../src/index.ts";
import { LoggingSeverity, QoS, features } from "../../src/index.ts";

let node: rclbun.Node;
beforeAll(async () => {
  await rclbun.init();
  node = rclbun.createNode("compat_test");
  node.spin();
});
afterAll(() => rclbun.shutdown());

const until = async (cond: () => boolean, ms = 5000) => {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await Bun.sleep(5);
  return cond();
};

describe("module shape", () => {
  test("default export carries the whole API", () => {
    expect(rclbunDefault.createNode).toBe(rclbun.createNode);
    expect(rclbunDefault.Clock).toBe(rclbun.Clock);
    expect(rclbunDefault.validator.isValidTopicName("ok_topic")).toBe(true);
  });

  test("DistroUtils / RMWUtils", () => {
    const name = process.env.ROS_DISTRO!;
    expect(rclbun.DistroUtils.getDistroName()).toBe(name);
    expect(rclbun.DistroUtils.getDistroId()).toBe(rclbun.DistroUtils.getDistroId(name));
    expect(rclbun.DistroUtils.getDistroId("humble")).toBe(2205);
    expect(rclbun.DistroUtils.getDistroName(2405)).toBe("jazzy");
    expect(rclbun.RMWUtils.getRMWName()).toBe(process.env.RMW_IMPLEMENTATION ?? "rmw_fastrtps_cpp");
    expect(node.getRMWImplementationIdentifier()).toBe(rclbun.RMWUtils.getRMWName());
  });
});

describe("validator", () => {
  test("valid and invalid names", () => {
    const v = rclbun.validator;
    expect(v.validateTopicName("chatter")).toBe(true);
    expect(v.validateFullTopicName("/ns/chatter")).toBe(true);
    expect(v.validateNodeName("my_node")).toBe(true);
    expect(v.validateNamespace("/my/ns")).toBe(true);
    expect(() => v.validateFullTopicName("chatter")).toThrow(rclbun.NameValidationError);
    expect(() => v.validateNodeName("1node")).toThrow(rclbun.NameValidationError);
    expect(() => v.validateNamespace("no_slash")).toThrow(rclbun.NameValidationError);
    expect(() => v.validateTopicName(42 as any)).toThrow(rclbun.TypeValidationError);
    expect(v.isValidTopicName("bad topic")).toBe(false);
    expect(v.isValidNodeName(null)).toBe(false);
  });
});

describe("waitForMessage", () => {
  test("message, timeout and abort", async () => {
    const pub = node.createPublisher("std_msgs/msg/String", "wfm_topic");
    const got = rclbun.waitForMessage("std_msgs/msg/String", node, "wfm_topic", { timeout: 5000, subscriptionOptions: { serializationMode: "plain" } });
    await until(() => pub.subscriptionCount > 0);
    pub.publish({ data: "first" });
    expect((await got).data).toBe("first");
    await until(() => pub.subscriptionCount === 0);
    expect(pub.subscriptionCount).toBe(0);

    await expect(rclbun.waitForMessage("std_msgs/msg/String", node, "wfm_silent", { timeout: 50 })).rejects.toBeInstanceOf(rclbun.TimeoutError);
    const ac = new AbortController();
    const p = rclbun.waitForMessage("std_msgs/msg/String", node, "wfm_silent", { signal: ac.signal });
    ac.abort();
    await expect(p).rejects.toBeInstanceOf(rclbun.AbortError);
    node.destroyPublisher(pub);
  });
});

describe("ObservableSubscription", () => {
  test("rxjs operators and async iteration", async () => {
    const pub = node.createPublisher("std_msgs/msg/Int32", "obs_ints");
    const obs = node.createObservableSubscription("std_msgs/msg/Int32", "obs_ints");
    expect(obs.topic).toBe("/obs_ints");
    const evens = firstValueFrom(
      (obs.observable as any).pipe(
        map((m: any) => m.data as number),
        filter((n: number) => n % 2 === 0),
        take(3),
        toArray(),
      ),
    );
    const iterated: number[] = [];
    const iterating = (async () => {
      for await (const m of obs) {
        iterated.push((m as any).data);
        if (iterated.length === 6) break;
      }
    })();
    await until(() => pub.subscriptionCount > 0);
    for (let i = 1; i <= 6; i++) pub.publish({ data: i });
    expect(await evens).toEqual([2, 4, 6]);
    await iterating;
    expect(iterated).toEqual([1, 2, 3, 4, 5, 6]);
    obs.complete();
    expect(obs.isDestroyed).toBe(true);
    node.destroySubscription(obs.subscription);
    node.destroyPublisher(pub);
  });
});

describe("logger service and rosout QoS", () => {
  test.skipIf(!features.loggerService)("~/get_logger_levels and ~/set_logger_levels", async () => {
    const n = rclbun.createNode("logger_svc", "", undefined, { enableLoggerService: true });
    n.spin();
    const get = node.createClient("rcl_interfaces/srv/GetLoggerLevels", "/logger_svc/get_logger_levels");
    const set = node.createClient("rcl_interfaces/srv/SetLoggerLevels", "/logger_svc/set_logger_levels");
    expect(await get.waitForService(5000)).toBe(true);
    expect(await set.waitForService(5000)).toBe(true);

    const r1: any = await set.sendRequestAsync({ levels: [{ name: "compat.child", level: LoggingSeverity.DEBUG }, { name: "compat.bad", level: 7 }] }, { timeout: 5000 });
    expect(r1.results.map((x: any) => x.successful)).toEqual([true, false]);
    expect(r1.results[1].reason.length).toBeGreaterThan(0);
    expect(rclbun.Logging.getLogger("compat.child").loggerEffectiveLevel).toBe(LoggingSeverity.DEBUG);

    const r2: any = await get.sendRequestAsync({ names: ["compat.child", "compat.unset"] }, { timeout: 5000 });
    expect(r2.levels).toEqual([
      { name: "compat.child", level: LoggingSeverity.DEBUG },
      { name: "compat.unset", level: 0 },
    ]);
    const plain = rclbun.createNode("no_logger_svc");
    expect(plain.getServiceNamesAndTypesByNode("no_logger_svc").map((x) => x.name)).not.toContain("/no_logger_svc/get_logger_levels");
    plain.destroy();
    n.destroy();
  });

  test("log calls reach /rosout", async () => {
    const logs: any[] = [];
    const sub = node.createSubscription("rcl_interfaces/msg/Log", "/rosout", { qos: QoS.profileRosoutDefault }, (m: any) => {
      if (m.name === "compat_test") logs.push(m);
    });
    expect(await until(() => sub.publisherCount > 0)).toBe(true);
    const ok = await until(() => {
      node.getLogger().info("hello rosout");
      return logs.some((m) => m.msg === "hello rosout");
    });
    expect(ok).toBe(true);
    expect(logs.find((m) => m.msg === "hello rosout").level).toBe(20);
    node.destroySubscription(sub);
  });

  test.skipIf(!features.rosoutSubloggers)("child loggers publish to /rosout and are released with their node", async () => {
    const n = rclbun.createNode("sublogger_node");
    const child = n.getLogger().getChild("worker");
    const grandchild = child.getChild("io");
    const names = new Set<string>();
    const sub = node.createSubscription("rcl_interfaces/msg/Log", "/rosout", { qos: QoS.profileRosoutDefault }, (m: any) => names.add(m.name));
    const ok = await until(() => {
      child.info("from child");
      grandchild.info("from grandchild");
      return names.has("sublogger_node.worker") && names.has("sublogger_node.worker.io");
    });
    expect(ok).toBe(true);
    grandchild.destroy();
    n.destroy();
    // the node's rosout publisher is gone; logging through the child must not touch it
    child.info("after node destroy");
    child.destroy();
    const again = rclbun.createNode("sublogger_node");
    again.getLogger().getChild("worker").info("recreated");
    again.destroy();
    node.destroySubscription(sub);
  });

  test("rosoutQos is applied to the node's /rosout publisher", async () => {
    const qos = new QoS(rclbun.HistoryPolicy.RMW_QOS_POLICY_HISTORY_KEEP_LAST, 42, rclbun.ReliabilityPolicy.RMW_QOS_POLICY_RELIABILITY_RELIABLE, rclbun.DurabilityPolicy.RMW_QOS_POLICY_DURABILITY_VOLATILE);
    const n = rclbun.createNode("rosout_qos_node", "", undefined, { rosoutQos: qos });
    const ep = await (async () => {
      for (let i = 0; i < 100; i++) {
        const e = node.getPublishersInfoByTopic("/rosout").find((x) => x.node_name === "rosout_qos_node");
        if (e) return e;
        await Bun.sleep(20);
      }
    })();
    expect(ep).toBeDefined();
    expect(ep!.qos_profile.durability).toBe(rclbun.DurabilityPolicy.RMW_QOS_POLICY_DURABILITY_VOLATILE);
    n.destroy();
  });
});

describe("action graph", () => {
  test("action servers and clients by node", async () => {
    const server = new rclbun.ActionServer(node, "example_interfaces/action/Fibonacci", "graph_fib", async (gh: any) => {
      gh.succeed();
      return { sequence: [] };
    });
    const other = rclbun.createNode("action_graph_client");
    const client = new rclbun.ActionClient(other, "example_interfaces/action/Fibonacci", "graph_fib");
    const ok = await until(
      () =>
        rclbun.getActionServerNamesAndTypesByNode(node, "compat_test", "/").some((a) => a.name === "/graph_fib") &&
        rclbun.getActionClientNamesAndTypesByNode(node, "action_graph_client", "/").some((a) => a.name === "/graph_fib"),
    );
    expect(ok).toBe(true);
    expect(rclbun.getActionServerNamesAndTypesByNode(node, "compat_test", "/").find((a) => a.name === "/graph_fib")!.types).toEqual([
      "example_interfaces/action/Fibonacci",
    ]);
    client.destroy();
    server.destroy();
    other.destroy();
  });
});

describe("QoS overriding options", () => {
  const { QoSOverridingOptions, QoSPolicyKind, ReliabilityPolicy, Parameter, ParameterType } = rclbun;

  test("qos_overrides.* parameters override publisher and subscription QoS", () => {
    const n = rclbun.createNode(
      "qos_override_node",
      "",
      undefined,
      {
        parameterOverrides: [
          new Parameter("qos_overrides./qos_topic.publisher.depth", ParameterType.PARAMETER_INTEGER, 42n),
          new Parameter("qos_overrides./qos_topic.publisher.reliability", ParameterType.PARAMETER_STRING, "best_effort"),
        ],
      },
      ["--ros-args", "-p", "qos_overrides./qos_topic.subscription_fast.depth:=7"],
    );
    const pub = n.createPublisher("std_msgs/msg/String", "qos_topic", { qosOverridingOptions: QoSOverridingOptions.withDefaultPolicies() });
    expect(pub.qos.depth).toBe(42);
    expect(pub.qos.reliability).toBe(ReliabilityPolicy.RMW_QOS_POLICY_RELIABILITY_BEST_EFFORT);
    expect(n.getParameter("qos_overrides./qos_topic.publisher.history").value).toBe("keep_last");
    // read-only once declared
    expect(n.setParameter(new Parameter("qos_overrides./qos_topic.publisher.depth", ParameterType.PARAMETER_INTEGER, 1n)).successful).toBe(false);

    const sub = n.createSubscription(
      "std_msgs/msg/String",
      "qos_topic",
      { qosOverridingOptions: new QoSOverridingOptions([QoSPolicyKind.DEPTH], { entityId: "fast" }) },
      () => {},
    );
    expect(sub.qos.depth).toBe(7);
    expect(sub.qos.reliability).toBe(ReliabilityPolicy.RMW_QOS_POLICY_RELIABILITY_RELIABLE);

    // without options nothing is declared or overridden
    const plain = n.createPublisher("std_msgs/msg/String", "other_topic");
    expect(plain.qos.depth).toBe(10);
    expect(n.hasParameter("qos_overrides./other_topic.publisher.depth")).toBe(false);
    n.destroy();
  });

  test("validation callback can reject the final QoS", () => {
    const n = rclbun.createNode("qos_override_reject", "", undefined, {
      parameterOverrides: [new Parameter("qos_overrides./strict_topic.publisher.depth", ParameterType.PARAMETER_INTEGER, 1n)],
    });
    const opts = QoSOverridingOptions.withDefaultPolicies({
      callback: (q) => (q.depth < 5 ? { successful: false, reason: "depth too small" } : { successful: true }),
    });
    expect(() => n.createPublisher("std_msgs/msg/String", "strict_topic", { qosOverridingOptions: opts })).toThrow("depth too small");
    n.destroy();
  });
});

describe("rclnodejs shorthands and validation hooks", () => {
  test("publish a bare value for single-data messages", async () => {
    const got: string[] = [];
    node.createSubscription("std_msgs/msg/String", "bare_topic", (m: any) => got.push(m.data));
    const pub = node.createPublisher("std_msgs/msg/String", "bare_topic");
    await until(() => pub.subscriptionCount > 0);
    pub.publish("hello bare");
    expect(await until(() => got.includes("hello bare"))).toBe(true);
    expect(() => node.createPublisher("geometry_msgs/msg/Twist", "bare_twist").publish(1 as any)).toThrow(rclbun.TypeValidationError);
  });

  test("validateMessages / validateRequests", async () => {
    const pub = node.createPublisher("std_msgs/msg/String", "validated", { validateMessages: true });
    expect(pub.willValidateMessage).toBe(true);
    expect(() => pub.publish({ data: 5 } as any)).toThrow(rclbun.MessageValidationError);
    expect(() => pub.publish({ data: "ok", extra: 1 } as any)).toThrow(rclbun.MessageValidationError); // strict by default
    pub.setValidation({ strict: false });
    pub.publish({ data: "ok", extra: 1 } as any);
    // validate: false skips validation; the encoder still rejects the value, with its own error
    expect(() => pub.publish({ data: 5 } as any, { validate: false })).toThrow(rclbun.TypeValidationError);
    expect(() => pub.publish({ data: 5 } as any, { validate: false })).not.toThrow(rclbun.MessageValidationError);
    pub.willValidateMessage = false;
    expect(pub.willValidateMessage).toBe(false);

    node.createService("example_interfaces/srv/AddTwoInts", "validated_add", (r: any) => ({ sum: r.a + r.b }));
    const cli = node.createClient("example_interfaces/srv/AddTwoInts", "validated_add", { validateRequests: true });
    await cli.waitForService(5000);
    await expect(cli.sendRequestAsync({ a: "x" } as any, { timeout: 2000 })).rejects.toBeInstanceOf(rclbun.MessageValidationError);
    expect(((await cli.sendRequestAsync({ a: 1n, b: 2n }, { timeout: 5000 })) as any).sum).toBe(3n);
  });

  test("node, context and logging helpers", () => {
    expect(node.getParameterTypes(["use_sim_time", "nope"])).toEqual([rclbun.ParameterType.PARAMETER_BOOL]);
    expect(rclbun.Context.defaultContext().isOk).toBe(true);
    expect(rclbun.Logging.getLoggingDirectory()).toBe(process.env.ROS_LOG_DIR ?? `${process.env.HOME}/.ros/log`);
    expect(typeof node.startSpinning).toBe("function");
  });
});
