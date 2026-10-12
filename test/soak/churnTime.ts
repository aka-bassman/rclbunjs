// Time per churn cycle (create + destroy a publisher, subscription, client and
// service; a temporary node every 20th cycle) as cycles accumulate. A rising
// ms/cycle means the middleware keeps state from destroyed entities; see
// churnTime.py for the same with rclpy.
//   RMW_IMPLEMENTATION=rmw_zenoh_cpp scripts/docker-test.sh bun test/soak/churnTime.ts
//   SOAK_CYCLES=3000 ... (default 6000)
import * as rclbun from "../../src/index.ts";
await rclbun.init();
const node = rclbun.createNode("churn_time");
node.spin();
const N = Number(process.env.SOAK_CYCLES ?? 6000);
let t = performance.now();
for (let i = 1; i <= N; i++) {
  const s = node.createSubscription("std_msgs/msg/String", `ct/t${i % 7}`, () => {});
  const p = node.createPublisher("std_msgs/msg/String", `ct/t${i % 7}`);
  const c = node.createClient("std_srvs/srv/Trigger", `ct/s${i % 5}`);
  const v = node.createService("std_srvs/srv/Trigger", `ct/s${i % 5}`, () => ({ success: true }));
  node.destroyService(v); node.destroyClient(c); node.destroyPublisher(p); node.destroySubscription(s);
  if (i % 20 === 0) { const n = rclbun.createNode(`ct_tmp_${i % 3}`); n.createSubscription("std_msgs/msg/String", "ct/tmp", () => {}); n.destroy(); }
  if (i % 500 === 0) {
    await Bun.sleep(1);
    const now = performance.now();
    console.log(`bun cycles=${i} ms/cycle=${((now - t) / 500).toFixed(2)} rssMB=${(process.memoryUsage().rss / 1048576).toFixed(0)}`);
    t = performance.now();
  }
}
rclbun.shutdown();
