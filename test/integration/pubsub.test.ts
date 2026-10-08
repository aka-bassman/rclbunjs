import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as rclbun from "../../src/index.ts";

let node: rclbun.Node;
beforeAll(async () => {
  await rclbun.init();
  node = rclbun.createNode("pubsub_test");
  node.spin();
});
afterAll(() => rclbun.shutdown());

const until = async (cond: () => boolean, ms = 5000) => {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await Bun.sleep(5);
  return cond();
};

describe("publisher/subscription", () => {
  test("same-process string round trip", async () => {
    const got: string[] = [];
    // KEEP_LAST depth must hold the whole burst: nothing is taken until we yield
    const qos = new rclbun.QoS(rclbun.HistoryPolicy.RMW_QOS_POLICY_HISTORY_KEEP_LAST, 50, rclbun.ReliabilityPolicy.RMW_QOS_POLICY_RELIABILITY_RELIABLE);
    const sub = node.createSubscription("std_msgs/msg/String", "rt_chatter", { qos }, (m: any) => got.push(m.data));
    const pub = node.createPublisher("std_msgs/msg/String", "rt_chatter");
    expect(await until(() => pub.subscriptionCount > 0)).toBe(true);
    for (let i = 0; i < 20; i++) pub.publish({ data: `hello ${i} ✓` });
    expect(await until(() => got.length === 20)).toBe(true);
    expect(got[0]).toBe("hello 0 ✓");
    node.destroySubscription(sub);
    node.destroyPublisher(pub);
  });

  test("complex message, typed arrays, message info", async () => {
    let got: any;
    let info: rclbun.MessageInfo | undefined;
    node.createSubscription("sensor_msgs/msg/JointState", "joints", (m: any, i?: rclbun.MessageInfo) => {
      got = m;
      info = i;
    });
    const pub = node.createPublisher("sensor_msgs/msg/JointState", "joints");
    await until(() => pub.subscriptionCount > 0);
    pub.publish({ header: { stamp: { sec: 5, nanosec: 6 }, frame_id: "base" }, name: ["a", "b"], position: [1.5, 2.5] });
    expect(await until(() => got !== undefined)).toBe(true);
    expect(got.header.frame_id).toBe("base");
    expect(got.header.stamp).toEqual({ sec: 5, nanosec: 6 });
    expect(got.position).toBeInstanceOf(Float64Array);
    expect(Array.from(got.position)).toEqual([1.5, 2.5]);
    expect(got.velocity.length).toBe(0);
    expect(info!.sourceTimestamp).toBeGreaterThan(0n);
  });

  test("raw publish and raw subscription", async () => {
    let raw: Uint8Array | undefined;
    node.createSubscription("std_msgs/msg/String", "raw_topic", { isRaw: true }, (m: any) => (raw = m));
    const pub = node.createPublisher("std_msgs/msg/String", "raw_topic");
    await until(() => pub.subscriptionCount > 0);
    pub.publish(rclbun.serializeMessage({ data: "raw!" }, "std_msgs/msg/String"));
    expect(await until(() => raw !== undefined)).toBe(true);
    expect(rclbun.deserializeMessage<any>(raw!, "std_msgs/msg/String").data).toBe("raw!");
  });

  test("plain serialization mode", async () => {
    let got: any;
    node.createSubscription("std_msgs/msg/Float64MultiArray", "plain_topic", { serializationMode: "plain" }, (m: any) => (got = m));
    const pub = node.createPublisher("std_msgs/msg/Float64MultiArray", "plain_topic");
    await until(() => pub.subscriptionCount > 0);
    pub.publish({ data: new Float64Array([1, 2, 3]) });
    expect(await until(() => got !== undefined)).toBe(true);
    expect(Array.isArray(got.data)).toBe(true);
    expect(got.data).toEqual([1, 2, 3]);
  });

  test("qos and graph", async () => {
    const pub = node.createPublisher("std_msgs/msg/String", "qos_topic", { qos: rclbun.QoS.profileSensorData });
    expect(pub.actualQoS.reliability).toBe(rclbun.ReliabilityPolicy.RMW_QOS_POLICY_RELIABILITY_BEST_EFFORT);
    expect(node.countPublishers("qos_topic")).toBe(1);
    const topics = node.getTopicNamesAndTypes();
    expect(topics.find((t) => t.name === "/qos_topic")?.types).toEqual(["std_msgs/msg/String"]);
    const infos = node.getPublishersInfoByTopic("qos_topic");
    expect(infos[0]?.node_name).toBe("pubsub_test");
    expect(node.getNodeNames()).toContain("pubsub_test");
  });
});

describe("timers and guards", () => {
  test("timer fires periodically and can be canceled", async () => {
    let n = 0;
    const t = node.createTimer(20_000_000n, () => n++);
    await Bun.sleep(230);
    t.cancel();
    const at = n;
    expect(at).toBeGreaterThanOrEqual(8);
    expect(at).toBeLessThanOrEqual(13);
    await Bun.sleep(80);
    expect(n).toBe(at);
    node.destroyTimer(t);
  });

  test("guard condition", async () => {
    let fired = 0;
    const g = node.createGuardCondition(() => fired++);
    g.trigger();
    expect(await until(() => fired === 1)).toBe(true);
  });
});

describe("service/client", () => {
  test("request/response with bigint fields", async () => {
    node.createService("example_interfaces/srv/AddTwoInts", "add_two_ints", (req: any) => ({ sum: req.a + req.b }));
    const cli = node.createClient("example_interfaces/srv/AddTwoInts", "add_two_ints");
    expect(await cli.waitForService(3000)).toBe(true);
    const r: any = await cli.sendRequestAsync({ a: 2n, b: 40n }, { timeout: 3000 });
    expect(r.sum).toBe(42n);
  });

  test("response.send style and callback client", async () => {
    node.createService("std_srvs/srv/SetBool", "set_bool", (req: any, res) => {
      const r = res.template as any;
      r.success = req.data;
      r.message = req.data ? "on" : "off";
      res.send(r);
    });
    const cli = node.createClient("std_srvs/srv/SetBool", "set_bool");
    await cli.waitForService(3000);
    const r: any = await new Promise((resolve) => cli.sendRequest({ data: true }, resolve));
    expect(r).toEqual({ success: true, message: "on" });
  });

  test("timeout rejects", async () => {
    const cli = node.createClient("std_srvs/srv/Trigger", "nobody_home");
    await expect(cli.sendRequestAsync({}, { timeout: 100 })).rejects.toBeInstanceOf(rclbun.TimeoutError);
  });
});
