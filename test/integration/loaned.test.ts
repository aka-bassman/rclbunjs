import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import * as rclbun from "../../src/index.ts";

// Loaned messages. Fast DDS (Jazzy+) lends memory to publishers of fixed-size types,
// and to subscriptions only with ROS_DISABLE_LOANED_MESSAGES=0; Humble's Fast DDS,
// Cyclone (without shared memory) and Zenoh lend nothing, so the same API runs on
// shim-owned C messages there. Cyclone with shared memory (RCLBUN_CYCLONE_SHM=1 in
// scripts/docker-test.sh) lends too, except to subscriptions on Cyclone 11 (Lyrical+),
// where rmw_cyclonedds aborts on a loaned take, and for types with fixed-size arrays
// there.

let node: rclbun.Node;
beforeAll(async () => {
  await rclbun.init();
  node = rclbun.createNode("loaned_test");
  node.spin();
});
afterAll(() => rclbun.shutdown());

const until = async (cond: () => boolean, ms = 5000) => {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await Bun.sleep(5);
  return cond();
};

const POSE = "geometry_msgs/msg/PoseWithCovariance";
const BASIC = "test_msgs/msg/BasicTypes";
const rmw = process.env.RMW_IMPLEMENTATION ?? "rmw_fastrtps_cpp";
const fastdds = rmw === "rmw_fastrtps_cpp" && process.env.ROS_DISTRO !== "humble";
const cycloneShm = rmw === "rmw_cyclonedds_cpp" && /SharedMemory|PubSubMessageExchange/.test(process.env.CYCLONEDDS_URI ?? "");
const cyclone11 = ["lyrical", "rolling"].includes(process.env.ROS_DISTRO ?? "");
/** publisher loans; `arrays`: the type has fixed-size arrays */
const pubLends = (arrays: boolean) => fastdds || (cycloneShm && !(cyclone11 && arrays));
/** subscription loans with ROS_DISABLE_LOANED_MESSAGES=0 */
const subLends = fastdds || (cycloneShm && !cyclone11);

const basic = {
  bool_value: true,
  byte_value: 0xab,
  char_value: 65,
  float32_value: 1.5,
  float64_value: -2.25,
  int8_value: -8,
  uint8_value: 200,
  int16_value: -1600,
  uint16_value: 60000,
  int32_value: -320000,
  uint32_value: 4000000000,
  int64_value: -(2n ** 40n),
  uint64_value: 2n ** 63n,
};

describe("loaned messages", () => {
  test("publish in place; plain and view subscriptions receive it", async () => {
    const pub = node.createPublisher(POSE, "loaned_pose");
    expect(pub.canLoanMessages).toBe(pubLends(true));
    let decoded: any;
    let copy: any;
    let kept: any;
    node.createSubscription(POSE, "loaned_pose", {}, (m: any) => (decoded = m));
    node.createSubscription(POSE, "loaned_pose", { loanedMessages: true }, (m) => {
      copy = m.toObject();
      kept = m;
    });
    expect(await until(() => pub.subscriptionCount === 2)).toBe(true);

    const loan = pub.borrowLoanedMessage();
    expect(loan.isLoaned).toBe(pubLends(true));
    expect(loan.message.pose.orientation.w).toBe(1); // defaults are filled in
    loan.message.pose.position.x = 1.5;
    loan.message.covariance[35] = 9;
    loan.message.set({ pose: { orientation: { z: 0.5 } } });
    pub.publish(loan);
    expect(loan.isValid).toBe(false);
    expect(() => loan.message.pose.position.x).toThrow(TypeError); // the memory went back

    expect(await until(() => !!(decoded && copy))).toBe(true);
    for (const m of [decoded, copy]) {
      expect(m.pose.position.x).toBe(1.5);
      expect(m.pose.orientation).toEqual({ x: 0, y: 0, z: 0.5, w: 1 });
      expect(m.covariance[35]).toBe(9);
      expect(m.covariance).toBeInstanceOf(Float64Array);
    }
    expect(() => kept.pose.position.x).toThrow(TypeError); // views end with the callback
  });

  test("every primitive type matches the CDR path in both directions", async () => {
    const loanedPub = node.createPublisher(BASIC, "loaned_basic_a");
    const cdrPub = node.createPublisher(BASIC, "loaned_basic_b");
    let viaCdr: any;
    let viaView: any;
    let info: rclbun.MessageInfo | undefined;
    node.createSubscription(BASIC, "loaned_basic_a", {}, (m: any) => (viaCdr = m));
    node.createSubscription(BASIC, "loaned_basic_b", { loanedMessages: true }, (m, i) => {
      viaView = m.toObject();
      info = i;
    });
    expect(await until(() => loanedPub.subscriptionCount === 1 && cdrPub.subscriptionCount === 1)).toBe(true);
    const loan = loanedPub.borrowLoanedMessage();
    loan.message.set(basic);
    loanedPub.publish(loan);
    cdrPub.publish(basic);
    expect(await until(() => !!(viaCdr && viaView))).toBe(true);
    expect(viaCdr).toEqual(basic);
    expect(viaView).toEqual(basic);
    expect(info).toBeInstanceOf(rclbun.MessageInfo);
    expect(info!.sourceTimestamp).toBeGreaterThan(0n);
  });

  test("return, misuse and teardown", () => {
    const pub = node.createPublisher(POSE, "loaned_misuse");
    const a = pub.borrowLoanedMessage();
    pub.returnLoanedMessage(a);
    expect(a.isValid).toBe(false);
    expect(() => pub.publish(a)).toThrow(rclbun.OperationError);
    const other = node.createPublisher(POSE, "loaned_misuse_2");
    const b = other.borrowLoanedMessage();
    expect(() => pub.publishLoanedMessage(b)).toThrow(rclbun.OperationError);
    expect(b.isValid).toBe(true);
    // outstanding loans go back when the publisher is destroyed
    const c = pub.borrowLoanedMessage();
    node.destroyPublisher(pub);
    expect(c.isValid).toBe(false);
    other.publish(b);
  });

  test("every borrow starts from the defaults, also when a C message is reused", async () => {
    const pub = node.createPublisher(POSE, "loaned_reuse");
    const got: any[] = [];
    node.createSubscription(POSE, "loaned_reuse", {}, (m: any) => got.push(m));
    expect(await until(() => pub.subscriptionCount === 1)).toBe(true);
    // more loans out at once than the publisher keeps for reuse, all given back
    const many = Array.from({ length: 6 }, () => pub.borrowLoanedMessage());
    many.forEach((l, i) => (l.message.pose.position.x = 100 + i));
    pub.publish(many[0]!);
    for (const l of many.slice(1)) pub.returnLoanedMessage(l);
    for (let i = 1; i <= 6; i++) {
      const loan = pub.borrowLoanedMessage();
      expect(loan.message.pose.position.x).toBe(0);
      expect(loan.message.pose.orientation.w).toBe(1);
      expect(loan.message.covariance[35]).toBe(0);
      loan.message.pose.position.x = i;
      loan.message.pose.orientation.w = -1;
      loan.message.covariance[35] = i;
      pub.publish(loan);
    }
    expect(await until(() => got.length === 7)).toBe(true);
    expect(got.map((m) => m.pose.position.x)).toEqual([100, 1, 2, 3, 4, 5, 6]);
    expect(got.map((m) => m.covariance[35])).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(got.slice(1).every((m) => m.pose.orientation.w === -1)).toBe(true);
    pub.returnLoanedMessage(pub.borrowLoanedMessage());
    node.destroyPublisher(pub); // frees the kept C messages
  });

  test("inactive lifecycle publishers return loans; views do not leave callbacks", async () => {
    const lc = rclbun.createLifecycleNode("loaned_lc");
    const pub = lc.createLifecyclePublisher(POSE, "loaned_lc_pose");
    const loan = pub.borrowLoanedMessage();
    pub.publish(loan); // inactive: dropped and returned
    expect(loan.isValid).toBe(false);
    const loan2 = pub.borrowLoanedMessage();
    pub.publishLoanedMessage(loan2);
    expect(loan2.isValid).toBe(false);
    lc.destroy();
    expect(() => node.createObservableSubscription(POSE, "loaned_obs", { loanedMessages: true })).toThrow(rclbun.TypeValidationError);
    await expect(rclbun.waitForMessage(POSE, node, "loaned_wait", { timeout: 100, subscriptionOptions: { loanedMessages: true } })).rejects.toThrow(rclbun.TypeValidationError);
  });

  test("types with strings or sequences are rejected", () => {
    expect(rclbun.isFixedSizeMessage(rclbun.getMessageType(POSE))).toBe(true);
    expect(rclbun.isFixedSizeMessage(rclbun.getMessageType("std_msgs/msg/String"))).toBe(false);
    const pub = node.createPublisher("sensor_msgs/msg/Imu", "loaned_imu");
    expect(() => pub.borrowLoanedMessage()).toThrow(/header\.frame_id/);
    expect(() => node.createSubscription("std_msgs/msg/String", "loaned_str", { loanedMessages: true }, () => {})).toThrow(/not a fixed-size message/);
  });

  test("another process takes real loans with ROS_DISABLE_LOANED_MESSAGES=0", async () => {
    const child = Bun.spawn(
      [
        "bun",
        "-e",
        `
        const rclbun = await import(${JSON.stringify(join(import.meta.dir, "..", "..", "src", "index.ts"))});
        await rclbun.init();
        const node = rclbun.createNode("loaned_listener");
        let n = 0;
        const sub = node.createSubscription("${BASIC}", "loaned_cross", { loanedMessages: true }, (m) => {
          console.log(JSON.stringify({ canLoan: sub.canLoanMessages, int32: m.int32_value, int64: String(m.int64_value) }));
          if (++n === 3) { rclbun.shutdown(); process.exit(0); }
        });
        node.spin();
        console.log("READY");
        setTimeout(() => process.exit(1), 15000);
        `,
      ],
      { env: { ...process.env, ROS_DISABLE_LOANED_MESSAGES: "0" }, stdout: "pipe" },
    );
    const pub = node.createPublisher(BASIC, "loaned_cross");
    expect(await until(() => pub.subscriptionCount === 1, 10000)).toBe(true);
    for (let i = 1; i <= 3; i++) {
      const loan = pub.borrowLoanedMessage();
      loan.message.int32_value = i;
      loan.message.int64_value = -BigInt(i);
      pub.publish(loan);
      await Bun.sleep(50);
    }
    const out = await new Response(child.stdout).text();
    expect(await child.exited).toBe(0);
    const got = out
      .split("\n")
      .filter((l) => l.startsWith("{"))
      .map((l) => JSON.parse(l));
    expect(got.map((g) => g.int32)).toEqual([1, 2, 3]);
    expect(got.map((g) => g.int64)).toEqual(["-1", "-2", "-3"]);
    for (const g of got) expect(g.canLoan).toBe(subLends);
  }, 30000);

  test("rclpy receives loaned messages and publishes to a view subscription", async () => {
    let fromPy: any;
    node.createSubscription(POSE, "loaned_from_py", { loanedMessages: true }, (m) => (fromPy ??= m.toObject()));
    const pub = node.createPublisher(POSE, "loaned_to_py");
    const py = Bun.spawn(
      [
        "python3",
        "-c",
        `
import rclpy, time
from geometry_msgs.msg import PoseWithCovariance
rclpy.init(); n = rclpy.create_node('loaned_py')
got = []
n.create_subscription(PoseWithCovariance, 'loaned_to_py', lambda m: got.append(m), 10)
p = n.create_publisher(PoseWithCovariance, 'loaned_from_py', 10)
end = time.time() + 15
while time.time() < end and not got:
    msg = PoseWithCovariance(); msg.pose.position.y = 7.0; msg.covariance[0] = 3.0
    p.publish(msg)
    rclpy.spin_once(n, timeout_sec=0.05)
print('PY', got[0].pose.position.z if got else None, got[0].covariance[1] if got else None)
`,
      ],
      { stdout: "pipe" },
    );
    expect(await until(() => pub.subscriptionCount === 1 && fromPy !== undefined, 15000)).toBe(true);
    for (let i = 0; i < 20 && py.exitCode === null; i++) {
      const loan = pub.borrowLoanedMessage();
      loan.message.pose.position.z = 4;
      loan.message.covariance[1] = 5;
      pub.publish(loan);
      await Bun.sleep(50);
    }
    const out = await new Response(py.stdout).text();
    expect(out).toContain("PY 4.0 5.0");
    expect(fromPy.pose.position.y).toBe(7);
    expect(fromPy.covariance[0]).toBe(3);
  }, 30000);
});
