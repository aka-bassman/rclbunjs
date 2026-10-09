// Loaned messages vs the CDR path for 1 MiB fixed-size frames, across two processes
// (round trip: publish a frame, the other process reads it and acks). Reports the
// round trip, the publisher's time in publish (incl. filling the frame) and the
// receiver's time from the start of its executor turn (take, decode) to the ack.
// Large reliable samples see occasional ~100 ms retransmission stalls on loopback,
// so compare percentiles rather than averages.
//
//   scripts/docker-test.sh bash -c 'scripts/build-test-msgs.sh && source /tmp/rclbun_test_msgs/install/setup.bash && bun benchmark/loaned.ts'
//
// Modes:
//   cdr        publish({ data }) -> JS encode -> rcl_publish_serialized; the echo decodes (zeroCopy)
//   loan/take  borrowLoanedMessage() -> fill in place -> rcl_publish_loaned_message; the echo reads a
//              view over its own C message (rcl_take copies out of the middleware)
//   loan/loan  same, and the echo also takes a loan (ROS_DISABLE_LOANED_MESSAGES=0)
import { join } from "node:path";
import * as rclbun from "../src/index.ts";

const N = Number(process.env.BENCH_FRAMES ?? 1000);
const FRAME = "rclbun_test_msgs/msg/FixedFrame";
await rclbun.init();
const node = rclbun.createNode("loaned_bench");
node.spin();
const qos = new rclbun.QoS(1, 4, 1, 2);
const frame = new Uint8Array(1048576);
for (let i = 0; i < frame.length; i++) frame[i] = i & 255;

let pending: ((v: { x: number; y: number }) => void) | null = null;
node.createSubscription("geometry_msgs/msg/Vector3", "lb_ack", { qos }, (m: any) => pending?.(m));

async function run(label: string, echoMode: string, echoEnv: Record<string, string>, send: (seq: bigint) => void) {
  const child = Bun.spawn(["bun", join(import.meta.dir, "loaned_echo.ts"), echoMode], { env: { ...process.env, ...echoEnv }, stdout: "pipe", stderr: "inherit" });
  const reader = child.stdout.getReader();
  const first = JSON.parse(new TextDecoder().decode((await reader.read()).value).split("\n")[0]!);
  const pub = node.createPublisher(FRAME, "lb_frame", { qos });
  while (pub.subscriptionCount < 1) await Bun.sleep(10);
  await Bun.sleep(300);
  const rtt: number[] = [];
  const pubUs: number[] = [];
  const subUs: number[] = [];
  let bad = 0;
  for (let i = 1; i <= N; i++) {
    const seq = BigInt(i);
    frame[0] = frame[1048575] = i & 255;
    const s = performance.now();
    const got = await new Promise<{ x: number; y: number }>((resolve) => {
      pending = resolve;
      send.call(pub, seq);
      pubUs.push((performance.now() - s) * 1000);
    });
    rtt.push((performance.now() - s) * 1000);
    subUs.push(got.y);
    if (got.x !== i) bad++;
  }
  child.kill();
  await child.exited;
  const loanPub = pub.canLoanMessages;
  node.destroyPublisher(pub);
  const pct = (a: number[], q: number) => Math.round([...a].sort((x, y) => x - y)[Math.min(N - 1, Math.floor(N * q))]!);
  return {
    mode: label,
    frames: N,
    bad,
    rttP50us: pct(rtt, 0.5),
    rttP90us: pct(rtt, 0.9),
    rttP99us: pct(rtt, 0.99),
    publishP50us: pct(pubUs, 0.5),
    receiveP50us: pct(subUs, 0.5),
    pubLoan: loanPub,
    subLoan: first.subLoan,
  };
}

function sendCdr(this: rclbun.Publisher, seq: bigint) {
  this.publish({ seq, width: 1024, height: 1024, data: frame });
}
function sendLoan(this: rclbun.Publisher, seq: bigint) {
  const loan = this.borrowLoanedMessage();
  const m = loan.message as any;
  m.seq = seq;
  m.width = 1024;
  m.height = 1024;
  m.data.set(frame); // stands in for producing the frame in place
  this.publish(loan);
}

const results = [
  await run("cdr", "cdr", {}, sendCdr),
  await run("loan/take", "view", { ROS_DISABLE_LOANED_MESSAGES: "1" }, sendLoan),
  await run("loan/loan", "view", { ROS_DISABLE_LOANED_MESSAGES: "0" }, sendLoan),
];
console.table(results);
console.log(JSON.stringify({ rmw: rclbun.RMWUtils.getRMWName(), distro: process.env.ROS_DISTRO, results }));
rclbun.shutdown();
process.exit(0);
