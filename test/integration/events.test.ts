import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as rclbun from "../../src/index.ts";
const { QoS, HistoryPolicy: H, ReliabilityPolicy: R } = rclbun;

let node: rclbun.Node;
beforeAll(async () => {
  await rclbun.init();
  node = rclbun.createNode("events_test");
  node.spin();
});
afterAll(() => rclbun.shutdown());

const until = async (cond: () => boolean, ms = 5000) => {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await Bun.sleep(10);
  return cond();
};

// rmw_zenoh_cpp accepts incompatible-QoS and deadline handlers but never fires
// them (rclpy gets none either), so those two tests are skipped there.
const zenoh = process.env.RMW_IMPLEMENTATION === "rmw_zenoh_cpp";

describe("QoS events", () => {
  // matched events were added in Iron
  test.skipIf(process.env.ROS_DISTRO === "humble")("matched events on publisher and subscription", async () => {
    let pubMatched: any;
    let subMatched: any;
    node.createPublisher("std_msgs/msg/String", "ev_match", undefined, { matched: (s: any) => (pubMatched = s) });
    node.createSubscription("std_msgs/msg/String", "ev_match", {}, () => {}, { matched: (s: any) => (subMatched = s) });
    expect(await until(() => pubMatched?.current_count === 1 && subMatched?.current_count === 1)).toBe(true);
  });

  test.skipIf(zenoh)("incompatible QoS is reported", async () => {
    let offered: any;
    let requested: any;
    const be = new QoS(H.RMW_QOS_POLICY_HISTORY_KEEP_LAST, 10, R.RMW_QOS_POLICY_RELIABILITY_BEST_EFFORT);
    const rel = new QoS(H.RMW_QOS_POLICY_HISTORY_KEEP_LAST, 10, R.RMW_QOS_POLICY_RELIABILITY_RELIABLE);
    node.createPublisher("std_msgs/msg/String", "ev_incompat", { qos: be }, { incompatibleQos: (s: any) => (offered = s) });
    node.createSubscription("std_msgs/msg/String", "ev_incompat", { qos: rel }, () => {}, { incompatibleQos: (s: any) => (requested = s) });
    expect(await until(() => offered?.total_count >= 1 && requested?.total_count >= 1)).toBe(true);
    expect(requested.last_policy_kind).toBeGreaterThan(0);
  });

  test.skipIf(zenoh)("deadline missed", async () => {
    let missed: any;
    const q = new QoS(H.RMW_QOS_POLICY_HISTORY_KEEP_LAST, 10, R.RMW_QOS_POLICY_RELIABILITY_RELIABLE);
    q.deadline = 50_000_000n;
    const pub = node.createPublisher("std_msgs/msg/String", "ev_deadline", { qos: q });
    node.createSubscription("std_msgs/msg/String", "ev_deadline", { qos: q }, () => {}, { deadline: (s: any) => (missed = s) });
    await Bun.sleep(100);
    pub.publish({ data: "once" });
    expect(await until(() => missed?.total_count >= 1, 3000)).toBe(true);
  });
});

describe("content filter", () => {
  test("filters messages at the reader", async () => {
    const got: string[] = [];
    const sub = node.createSubscription("std_msgs/msg/String", "cft", { contentFilter: { expression: "data = %0", parameters: ["'keep'"] } }, (m: any) =>
      got.push(m.data),
    );
    if (!sub.isContentFilterSupported()) return;
    expect(sub.hasContentFilter()).toBe(true);
    expect(sub.getContentFilter()).toEqual({ expression: "data = %0", parameters: ["'keep'"] });
    const pub = node.createPublisher("std_msgs/msg/String", "cft");
    await until(() => pub.subscriptionCount > 0);
    for (const d of ["drop", "keep", "drop", "keep"]) pub.publish({ data: d });
    await Bun.sleep(300);
    expect(got).toEqual(["keep", "keep"]);
    expect(sub.clearContentFilter()).toBe(true);
    pub.publish({ data: "now anything" });
    expect(await until(() => got.includes("now anything"))).toBe(true);
  });
});
