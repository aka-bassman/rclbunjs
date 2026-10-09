// Child of benchmark/loaned.ts: receives 1 MiB frames and acks each one with
// { x: seq (0 if the bytes are wrong), y: callback time in µs }.
// argv[2]: "cdr" (decoded, zeroCopy) or "view" (loanedMessages).
import * as rclbun from "../src/index.ts";

const mode = process.argv[2];
await rclbun.init();
const node = rclbun.createNode(`loaned_echo_${mode}`);
const qos = new rclbun.QoS(1, 4, 1, 2);
const ack = node.createPublisher("geometry_msgs/msg/Vector3", "lb_ack", { qos });
const LAST = 1048575;
// the publisher writes seq into the first and last pixel
const check = (seq: bigint, data: Uint8Array) => (data[0] === Number(seq & 255n) && data[LAST] === Number(seq & 255n) ? Number(seq) : 0);
// the take and decode happen before the callback, so time from the start of the executor turn
let turn = 0;
const reply = (x: number) => ack.publish({ x, y: (performance.now() - turn) * 1000 });
const onView = (m: any) => reply(check(m.seq, m.data));
const sub =
  mode === "view"
    ? node.createSubscription("rclbun_test_msgs/msg/FixedFrame", "lb_frame", { qos, loanedMessages: true }, onView)
    : node.createSubscription("rclbun_test_msgs/msg/FixedFrame", "lb_frame", { qos, zeroCopy: true }, onView);
const execute = sub.execute.bind(sub);
sub.execute = () => {
  turn = performance.now();
  execute();
};
node.spin();
console.log(JSON.stringify({ ready: true, subLoan: sub.canLoanMessages }));
await new Promise(() => {});
