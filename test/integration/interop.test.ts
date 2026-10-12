// Interop with the ros2 CLI / rclpy running in the same container.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as rclbun from "../../src/index.ts";

// Cyclone DDS over shared memory (RCLBUN_CYCLONE_SHM=1) does not deliver the transient-local
// ros_discovery_info history to late joiners, so the ros2 CLI never learns node names
// (rclpy nodes alike); the CLI test is skipped there.
const cycloneShm = /SharedMemory|PubSubMessageExchange/.test(process.env.CYCLONEDDS_URI ?? "");

let node: rclbun.Node;
beforeAll(async () => {
  await rclbun.init();
  node = rclbun.createNode("interop_test");
  node.spin();
});
afterAll(() => rclbun.shutdown());

const py = (code: string) => Bun.spawn(["python3", "-c", code], { stdout: "pipe", stderr: "pipe" });
const until = async (cond: () => boolean, ms = 10000) => {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await Bun.sleep(10);
  return cond();
};

describe("interop with rclpy", () => {
  test("rclpy publishes, rclbunjs subscribes (Twist)", async () => {
    let got: any;
    node.createSubscription("geometry_msgs/msg/Twist", "py_twist", (m: any) => (got = m));
    const p = py(`
import rclpy, time
from geometry_msgs.msg import Twist
rclpy.init(); n = rclpy.create_node('py_pub'); pub = n.create_publisher(Twist, 'py_twist', 10)
m = Twist(); m.linear.x = 1.25; m.angular.z = -3.5
for _ in range(100):
    pub.publish(m); time.sleep(0.05)
    if pub.get_subscription_count() and _ > 10: break
`);
    expect(await until(() => got !== undefined)).toBe(true);
    expect(got.linear.x).toBe(1.25);
    expect(got.angular.z).toBe(-3.5);
    p.kill();
  }, 20000);

  test("rclbunjs publishes, rclpy subscribes (test_msgs/Arrays round trip via echo node)", async () => {
    // python echo: receives on bun_out, republishes on bun_back
    const p = py(`
import rclpy
from test_msgs.msg import Arrays
rclpy.init(); n = rclpy.create_node('py_echo')
pub = n.create_publisher(Arrays, 'bun_back', 10)
n.create_subscription(Arrays, 'bun_out', lambda m: pub.publish(m), 10)
rclpy.spin(n)
`);
    let back: any;
    node.createSubscription("test_msgs/msg/Arrays", "bun_back", (m: any) => (back = m));
    const pub = node.createPublisher("test_msgs/msg/Arrays", "bun_out");
    const msg = rclbun.createMessageObject<any>("test_msgs/msg/Arrays");
    msg.int64_values = [1n, -2n, 3n];
    msg.float32_values = new Float32Array([1.5, 2.5, -3.5]);
    msg.string_values = ["a", "ü", "三"];
    msg.bool_values = [true, false, true];
    msg.basic_types_values[1].uint64_value = 18446744073709551615n;
    const ok = await until(() => {
      if (back === undefined) pub.publish(msg);
      return back !== undefined;
    }, 15000);
    expect(ok).toBe(true);
    expect(back.int64_values).toEqual([1n, -2n, 3n]);
    expect(Array.from(back.float32_values)).toEqual([1.5, 2.5, -3.5]);
    expect(back.string_values).toEqual(["a", "ü", "三"]);
    expect(back.basic_types_values[1].uint64_value).toBe(18446744073709551615n);
    p.kill();
  }, 30000);

  test("rclpy service <-> rclbunjs client, and rclbunjs service <-> rclpy client", async () => {
    const srv = py(`
import rclpy
from example_interfaces.srv import AddTwoInts
rclpy.init(); n = rclpy.create_node('py_srv')
def cb(req, res):
    res.sum = req.a * req.b; return res
n.create_service(AddTwoInts, 'py_mul', cb)
rclpy.spin(n)
`);
    const cli = node.createClient("example_interfaces/srv/AddTwoInts", "py_mul");
    expect(await cli.waitForService(10000)).toBe(true);
    // A request sent right after discovery can go unanswered while the server has not
    // matched the client's response reader yet (any client library), so retry.
    let r: any;
    for (let i = 0; i < 5 && r === undefined; i++) {
      r = await cli.sendRequestAsync({ a: 6n, b: 7n }, { timeout: 2000 }).catch((e) => {
        if (!(e instanceof rclbun.TimeoutError)) throw e;
      });
    }
    expect(r?.sum).toBe(42n);
    srv.kill();

    node.createService("example_interfaces/srv/AddTwoInts", "bun_add", (req: any) => ({ sum: req.a + req.b }));
    const c = py(`
import rclpy
from example_interfaces.srv import AddTwoInts
rclpy.init(); n = rclpy.create_node('py_cli')
c = n.create_client(AddTwoInts, 'bun_add'); c.wait_for_service(10.0)
res = None
for _ in range(5):  # same race as above, from the other side
    f = c.call_async(AddTwoInts.Request(a=40, b=2)); rclpy.spin_until_future_complete(n, f, timeout_sec=2.0)
    if f.done():
        res = f.result(); break
print('SUM', res.sum if res else None)
`);
    const out = await new Response(c.stdout).text();
    expect(out).toContain("SUM 42");
  }, 40000);

  test.skipIf(cycloneShm)("ros2 CLI sees the node and its topics", async () => {
    node.createPublisher("std_msgs/msg/String", "cli_visible");
    // a fresh CLI participant may return before discovery completes: retry
    const poll = async (args: string[], want: string) => {
      let out = "";
      for (let i = 0; i < 10 && !out.includes(want); i++) out = (await Bun.$`ros2 ${args}`.nothrow().quiet()).text();
      return out;
    };
    expect(await poll(["topic", "list", "--no-daemon", "-t"], "/cli_visible")).toContain("/cli_visible [std_msgs/msg/String]");
    expect(await poll(["node", "list", "--no-daemon"], "/interop_test")).toContain("/interop_test");
  }, 120000);
});
