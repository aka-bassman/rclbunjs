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

// observable subscriptions and waitForMessage are typed from the type name
const obs = node.createObservableSubscription("std_msgs/msg/String", "chatter");
obs.observable.subscribe((m) => m.data.toUpperCase());
(async () => {
  for await (const m of obs) {
    const s: string = m.data;
    void s;
  }
  const scan = await rclbun.waitForMessage("sensor_msgs/msg/LaserScan", node, "scan", { timeout: 1000, subscriptionOptions: { zeroCopy: true } });
  const r: Float32Array | number[] = scan.ranges;
  void r;
})();

// validation, introspection and QoS overriding
const result: rclbun.MessageValidationResult = rclbun.validateMessage({ linear: { x: 1 } }, "geometry_msgs/msg/Twist");
void result.valid;
const srv = node.createService("example_interfaces/srv/AddTwoInts", "add2", (req) => ({ sum: req.a }));
srv.configureIntrospection(node.getClock(), rclbun.QoS.profileSystemDefault, rclbun.ServiceIntrospectionStates.CONTENTS);
node.createPublisher("std_msgs/msg/String", "t", { qosOverridingOptions: rclbun.QoSOverridingOptions.withDefaultPolicies() });
node.getClock().addClockCallback({ _post_callback: (j) => j.delta + 1n }, true, 1n, 0n);

// default export carries the API
import rclbunDefault from "rclbunjs";
rclbunDefault.createNode("n").createPublisher("std_msgs/msg/String", "t").publish({ data: "x" });
// @ts-expect-error data must be a string
rclbunDefault.createNode("n").createPublisher("std_msgs/msg/String", "t").publish({ data: 1 });

// rclnodejs shorthand: a bare value for single-`data` messages
node.createPublisher("std_msgs/msg/String", "s").publish("hello");
node.createPublisher("std_msgs/msg/Float64", "f").publish(3.14, { validate: true });
// @ts-expect-error Twist has no data field
node.createPublisher("geometry_msgs/msg/Twist", "t2").publish("hello");
// @ts-expect-error data is a string
node.createPublisher("std_msgs/msg/String", "s").publish(1);
