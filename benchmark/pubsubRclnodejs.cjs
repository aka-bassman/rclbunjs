// node benchmark/pubsubRclnodejs.cjs (run where rclnodejs is installed) — same scenarios as pubsub.ts
const rclnodejs = require("rclnodejs");
(async () => {
  await rclnodejs.init();
  const node = rclnodejs.createNode("bench_node");
  rclnodejs.spin(node);
  const qos = new rclnodejs.QoS(1, 1000, 1, 2);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  async function latency(n) {
    const pong = node.createPublisher("std_msgs/msg/String", "n_pong", { qos });
    node.createSubscription("std_msgs/msg/String", "n_ping", { qos }, (m) => pong.publish(m));
    const ping = node.createPublisher("std_msgs/msg/String", "n_ping", { qos });
    let resolve; node.createSubscription("std_msgs/msg/String", "n_pong", { qos }, () => resolve());
    await sleep(300);
    const s = [];
    for (let i = 0; i < n; i++) {
      const t0 = performance.now();
      await new Promise((r) => { resolve = r; setImmediate(() => ping.publish({ data: "ping" })); });
      s.push((performance.now() - t0) * 1000);
    }
    s.sort((a, b) => a - b);
    return { p50: s[n >> 1].toFixed(0), p99: s[Math.floor(n * 0.99)].toFixed(0) };
  }
  async function throughput(type, msg, n, topic) {
    let got = 0, done; const fin = new Promise((r) => (done = r));
    node.createSubscription(type, topic, { qos }, () => { if (++got === n) done(); });
    const pub = node.createPublisher(type, topic, { qos });
    await sleep(300);
    const t0 = performance.now();
    for (let i = 0; i < n; i++) { pub.publish(msg); if (i % 50 === 49) await sleep(0); }
    await Promise.race([fin, sleep(20000)]);
    return { received: got, msgPerSec: Math.round(got / ((performance.now() - t0) / 1000)) };
  }
  const lat = await latency(2000);
  const small = await throughput("std_msgs/msg/String", { data: "x".repeat(64) }, 20000, "n_small");
  const img = { height: 480, width: 640, encoding: "rgb8", step: 1920, data: new Uint8Array(640 * 480 * 3) };
  const big = await throughput("sensor_msgs/msg/Image", img, 300, "n_img");
  console.log(JSON.stringify({ runtime: `node ${process.version} + rclnodejs`, latencyUs: lat, string64: small, image900KB: big }));
  rclnodejs.shutdown(); process.exit(0);
})();
