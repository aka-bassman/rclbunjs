// Compile-only checks for the generated typings: `bunx tsc -p test/types`.
import * as rclbun from "rclbunjs";

declare const node: rclbun.Node;

const pub = node.createPublisher("geometry_msgs/msg/Twist", "cmd_vel");
pub.publish({ linear: { x: 1 } }); // partial input is fine
// @ts-expect-error wrong field type
pub.publish({ linear: { x: "fast" } });

node.createSubscription("sensor_msgs/msg/JointState", "joints", (msg) => {
  const name: string[] = msg.name;
  const p: Float64Array | number[] = msg.position;
  const sec: number = msg.header.stamp.sec;
  // @ts-expect-error not a field of JointState
  msg.nope;
  void [name, p, sec];
});

const cli = node.createClient("example_interfaces/srv/AddTwoInts", "add");
const sum: Promise<bigint> = cli.sendRequestAsync({ a: 1n, b: 2n }).then((r) => r.sum);
// @ts-expect-error int64 fields are bigint
cli.sendRequestAsync({ a: "1" });

node.createService("example_interfaces/srv/AddTwoInts", "add", (req) => ({ sum: req.a + req.b }));

const ac = new rclbun.ActionClient(node, "example_interfaces/action/Fibonacci", "fib");
ac.sendGoal({ order: 5 }, (fb) => fb.sequence).then((gh) => gh.getResult()).then((r) => r.sequence);

// unknown names still compile (untyped)
node.createPublisher("my_pkg/msg/NotGenerated", "x").publish({ anything: 1 });
void sum;
