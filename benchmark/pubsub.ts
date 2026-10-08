// bun benchmark/pubsub.ts — same-process latency (ping-pong) and throughput.
import * as rclbun from "../src/index.ts";

await rclbun.init();
const node = rclbun.createNode("bench_bun");
node.spin();
const qos = new rclbun.QoS(1, 1000, 1, 2);

async function latency(n: number) {
  const pong = node.createPublisher("std_msgs/msg/String", "b_pong", { qos });
  node.createSubscription("std_msgs/msg/String", "b_ping", { qos }, (m: any) => pong.publish(m));
  const ping = node.createPublisher("std_msgs/msg/String", "b_ping", { qos });
  const samples: number[] = [];
  let resolve!: () => void;
  node.createSubscription("std_msgs/msg/String", "b_pong", { qos }, () => resolve());
  await Bun.sleep(300);
  for (let i = 0; i < n; i++) {
    const t0 = performance.now();
    await new Promise<void>((r) => {
      resolve = r;
      setImmediate(() => ping.publish({ data: "ping" }));
    });
    samples.push((performance.now() - t0) * 1000);
  }
  samples.sort((a, b) => a - b);
  return { p50: samples[n >> 1]!.toFixed(0), p99: samples[Math.floor(n * 0.99)]!.toFixed(0) };
}

async function throughput(type: string, msg: unknown, n: number, topic: string) {
  let got = 0;
  let done!: () => void;
  const fin = new Promise<void>((r) => (done = r));
  node.createSubscription(type, topic, { qos }, () => {
    if (++got === n) done();
  });
  const pub = node.createPublisher(type, topic, { qos });
  await Bun.sleep(300);
  const t0 = performance.now();
  for (let i = 0; i < n; i++) {
    pub.publish(msg);
    if (i % 50 === 49) await Bun.sleep(0);
  }
  await Promise.race([fin, Bun.sleep(20000)]);
  const s = (performance.now() - t0) / 1000;
  return { received: got, msgPerSec: Math.round(got / s) };
}

const lat = await latency(2000);
const small = await throughput("std_msgs/msg/String", { data: "x".repeat(64) }, 20000, "b_small");
const img = { height: 480, width: 640, encoding: "rgb8", step: 1920, data: new Uint8Array(640 * 480 * 3) };
const big = await throughput("sensor_msgs/msg/Image", img, 300, "b_img");
console.log(JSON.stringify({ runtime: `bun ${Bun.version}`, latencyUs: lat, string64: small, image900KB: big }));
rclbun.shutdown();
