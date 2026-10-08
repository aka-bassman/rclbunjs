// RSS growth per kind of entity churn (create + destroy), to compare RMWs and
// client libraries; see churn_rss.py for the same with rclpy.
//   RMW_IMPLEMENTATION=rmw_cyclonedds_cpp scripts/docker-test.sh bun test/soak/churn_rss.ts
//   KINDS=client,node scripts/docker-test.sh bun test/soak/churn_rss.ts
import * as rclbun from "../../src/index.ts";
await rclbun.init();
const node = rclbun.createNode("churn");
node.spin();
const mb = () => process.memoryUsage().rss / 1048576;
async function kind(name: string, n: number, fn: (i: number) => Promise<void> | void) {
  for (let i = 0; i < 100; i++) await fn(i);
  const out: string[] = [];
  for (let round = 0; round < 3; round++) {
    Bun.gc(true);
    await Bun.sleep(500);
    const r0 = mb();
    for (let i = 0; i < n; i++) await fn(i);
    Bun.gc(true);
    await Bun.sleep(1500);
    out.push(`${(mb() - r0).toFixed(1)}`);
  }
  console.log(`${name.padEnd(16)} x${n} per round, rss MB: ${out.join(" / ")}`);
}
const only = process.env.KINDS?.split(",");
const want = (k: string) => !only || only.includes(k);
if (want("pubsub")) await kind("pub+sub", 1000, (i) => {
  const s = node.createSubscription("std_msgs/msg/String", `c/t${i % 7}`, () => {});
  const p = node.createPublisher("std_msgs/msg/String", `c/t${i % 7}`);
  node.destroyPublisher(p);
  node.destroySubscription(s);
});
if (want("pub")) await kind("pub", 1000, (i) => node.destroyPublisher(node.createPublisher("std_msgs/msg/String", `c/p${i % 7}`)));
if (want("sub")) await kind("sub", 1000, (i) => node.destroySubscription(node.createSubscription("std_msgs/msg/String", `c/s${i % 7}`, () => {})));
if (want("client")) await kind("client", 1000, (i) => node.destroyClient(node.createClient("std_srvs/srv/Trigger", `c/c${i % 5}`)));
if (want("service")) await kind("service", 1000, (i) => node.destroyService(node.createService("std_srvs/srv/Trigger", `c/v${i % 5}`, () => ({}))));
if (want("timer")) await kind("timer", 1000, () => node.destroyTimer(node.createTimer(1_000_000n, () => {})));
if (want("node")) await kind("node", 150, async (i) => {
  const n = rclbun.createNode(`c_tmp_${i % 3}`);
  n.spin();
  await Bun.sleep(1);
  n.destroy();
});
rclbun.shutdown();
process.exit(0);
