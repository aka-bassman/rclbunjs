// Long-running stability test. Exercises every entity kind continuously and
// samples memory, so leaks show up as a growing RSS / heap trend.
//
//   scripts/docker-test.sh bun test/soak/soak.ts            # SOAK_MINUTES=60 by default
//   SOAK_MINUTES=180 SOAK_SAMPLE_SEC=60 scripts/docker-test.sh bun test/soak/soak.ts
//
// Prints one JSON line per sample and a summary with the memory slope over
// the second half of the run; exits 1 on errors or when the slope exceeds
// SOAK_MAX_MB_PER_HOUR (default 5).
import * as rclbun from "../../src/index.ts";

const MINUTES = Number(process.env.SOAK_MINUTES ?? 60);
const SAMPLE_SEC = Number(process.env.SOAK_SAMPLE_SEC ?? 30);
const MAX_SLOPE = Number(process.env.SOAK_MAX_MB_PER_HOUR ?? 5);
const FIB = "example_interfaces/action/Fibonacci";

await rclbun.init();
const node = rclbun.createNode("soak", "", undefined, { enableLoggerService: rclbun.features.loggerService });
const peer = rclbun.createNode("soak_peer");
node.spin();
peer.spin();

const stats = {
  published: 0,
  received: 0,
  bigReceived: 0,
  calls: 0,
  unanswered: 0,
  goals: 0,
  canceled: 0,
  paramSets: 0,
  timerTicks: 0,
  churn: 0,
  jumps: 0,
  errors: 0,
};
const errors: string[] = [];
const fail = (where: string) => (e: unknown) => {
  stats.errors++;
  if (errors.length < 20) errors.push(`${where}: ${String((e as Error)?.stack ?? e)}`);
};

// --- topics: small high-rate messages and large arrays (copy and zero-copy)
const qos = new rclbun.QoS(rclbun.HistoryPolicy.RMW_QOS_POLICY_HISTORY_KEEP_LAST, 100, rclbun.ReliabilityPolicy.RMW_QOS_POLICY_RELIABILITY_RELIABLE);
const jsPub = node.createPublisher("sensor_msgs/msg/JointState", "soak/joints", { qos });
peer.createSubscription("sensor_msgs/msg/JointState", "soak/joints", { qos }, (_m: any, info?: rclbun.MessageInfo) => {
  stats.received++;
  void info;
});
const imgPub = node.createPublisher("sensor_msgs/msg/Image", "soak/image", { qos });
peer.createSubscription("sensor_msgs/msg/Image", "soak/image", { qos, zeroCopy: true }, () => stats.bigReceived++);
peer.createSubscription("sensor_msgs/msg/Image", "soak/image", { qos }, () => stats.bigReceived++);
const joints = { name: ["a", "b", "c", "d", "e", "f"], position: new Float64Array(6), velocity: new Float64Array(6), effort: new Float64Array(6) };
const image = { height: 240, width: 320, encoding: "rgb8", step: 960, data: new Uint8Array(320 * 240 * 3) };

node.createTimer(2_000_000n, () => {
  stats.timerTicks++;
  joints.position[0] = stats.published;
  jsPub.publish(joints);
  stats.published++;
});
node.createTimer(50_000_000n, () => imgPub.publish(image));

// --- services: answered (sync and async) and deliberately unanswered requests
peer.createService("example_interfaces/srv/AddTwoInts", "soak/add", (req: any) => ({ sum: req.a + req.b }));
peer.createService("example_interfaces/srv/AddTwoInts", "soak/add_async", async (req: any, res) => {
  await Bun.sleep(1);
  res.send({ sum: req.a * req.b });
});
peer.createService("std_srvs/srv/Trigger", "soak/ignore", () => undefined); // never responds
const add = node.createClient("example_interfaces/srv/AddTwoInts", "soak/add");
const addAsync = node.createClient("example_interfaces/srv/AddTwoInts", "soak/add_async");
const ignore = node.createClient("std_srvs/srv/Trigger", "soak/ignore");

// --- actions
new rclbun.ActionServer(
  peer,
  FIB,
  "soak/fib",
  async (gh: any) => {
    const seq = [0, 1];
    for (let i = 1; i < gh.request.order; i++) {
      if (gh.isCancelRequested) {
        gh.canceled();
        return { sequence: seq };
      }
      seq.push(seq[i]! + seq[i - 1]!);
      gh.publishFeedback({ sequence: seq });
      await Bun.sleep(2);
    }
    gh.succeed();
    return { sequence: seq };
  },
  undefined,
  undefined,
  () => rclbun.CancelResponse.ACCEPT,
);
const fib = new rclbun.ActionClient(node, FIB, "soak/fib");

// --- parameters over the parameter services
peer.declareParameter(new rclbun.Parameter("gain", rclbun.ParameterType.PARAMETER_DOUBLE, 1.0));
const params = node.createParameterClient("soak_peer");

// --- clock jump callbacks
const clock = new rclbun.ROSClock();
clock.addClockCallback({ _post_callback: () => stats.jumps++ }, true, 1n, -1n);
clock.isRosTimeActive = true;

async function rpcLoop() {
  await add.waitForService(10000);
  await fib.waitForServer(10000);
  let i = 0;
  while (running) {
    i++;
    try {
      const r: any = await add.sendRequestAsync({ a: BigInt(i), b: 1n }, { timeout: 5000 });
      if (r.sum !== BigInt(i) + 1n) throw new Error(`bad sum ${r.sum}`);
      await addAsync.sendRequestAsync({ a: 3n, b: 4n }, { timeout: 5000 });
      stats.calls += 2;
      if (i % 10 === 0) {
        await ignore.sendRequestAsync({}, { timeout: 20 }).catch((e) => {
          if (!(e instanceof rclbun.TimeoutError)) throw e;
          stats.unanswered++;
        });
      }
      if (i % 5 === 0) {
        const gh = await fib.sendGoal({ order: 8 }, () => {});
        if (i % 15 === 0) {
          await gh.cancelGoal();
          stats.canceled++;
        }
        await gh.getResult();
        stats.goals++;
      }
      if (i % 7 === 0) {
        await params.setParameter("gain", i * 0.5, { timeout: 5000 });
        const p = await params.getParameter("gain", { timeout: 5000 });
        if (p.value !== i * 0.5) throw new Error(`param mismatch ${p.value}`);
        stats.paramSets++;
      }
      if (i % 3 === 0) clock.rosTimeOverride = rclbun.Time.fromNanoseconds(BigInt(i) * 1_000_000_000n, rclbun.ClockType.ROS_TIME);
      if (i % 50 === 0) node.getLogger().info(`soak iteration ${i}`);
    } catch (e) {
      fail("rpc")(e);
      await Bun.sleep(100);
    }
  }
}

// --- entity churn on a spinning node, and whole short-lived nodes
async function churnLoop() {
  let i = 0;
  while (running) {
    i++;
    try {
      const s = node.createSubscription("std_msgs/msg/String", `soak/churn_${i % 7}`, () => {});
      const p = node.createPublisher("std_msgs/msg/String", `soak/churn_${i % 7}`);
      p.publish({ data: "x" });
      const c = node.createClient("std_srvs/srv/Trigger", `soak/churn_srv_${i % 5}`);
      const sv = node.createService("std_srvs/srv/Trigger", `soak/churn_srv_${i % 5}`, () => ({ success: true }));
      const t = node.createTimer(1_000_000n, () => {});
      await Bun.sleep(5);
      node.destroyTimer(t);
      node.destroyService(sv);
      node.destroyClient(c);
      node.destroyPublisher(p);
      node.destroySubscription(s);
      if (i % 20 === 0) {
        const n = rclbun.createNode(`soak_tmp_${i % 3}`);
        n.spin();
        n.createSubscription("std_msgs/msg/String", "soak/tmp", () => {});
        await Bun.sleep(10);
        n.destroy();
      }
      stats.churn++;
    } catch (e) {
      fail("churn")(e);
      await Bun.sleep(100);
    }
    await Bun.sleep(5);
  }
}

let running = true;
const loops = [rpcLoop(), churnLoop()];
const t0 = performance.now();
const samples: { t: number; rss: number; heap: number }[] = [];
const mb = (b: number) => Math.round((b / 1048576) * 10) / 10;

while ((performance.now() - t0) / 60000 < MINUTES) {
  await Bun.sleep(SAMPLE_SEC * 1000);
  Bun.gc(true);
  const m = process.memoryUsage();
  const t = (performance.now() - t0) / 3600000;
  samples.push({ t, rss: mb(m.rss), heap: mb(m.heapUsed) });
  console.log(JSON.stringify({ minutes: Math.round(t * 600) / 10, rssMB: mb(m.rss), heapMB: mb(m.heapUsed), ...stats }));
}
running = false;
await Promise.all(loops);

// least-squares slope (MB/hour) over the second half of the run
function slope(key: "rss" | "heap"): number {
  const xs = samples.slice(Math.floor(samples.length / 2));
  if (xs.length < 2) return 0;
  const mx = xs.reduce((a, s) => a + s.t, 0) / xs.length;
  const my = xs.reduce((a, s) => a + s[key], 0) / xs.length;
  const num = xs.reduce((a, s) => a + (s.t - mx) * (s[key] - my), 0);
  const den = xs.reduce((a, s) => a + (s.t - mx) ** 2, 0);
  return den === 0 ? 0 : Math.round((num / den) * 100) / 100;
}
const summary = {
  minutes: MINUTES,
  rmw: node.getRMWImplementationIdentifier(),
  distro: process.env.ROS_DISTRO,
  rssMB: { first: samples[0]?.rss, last: samples.at(-1)?.rss, slopePerHour: slope("rss") },
  heapMB: { first: samples[0]?.heap, last: samples.at(-1)?.heap, slopePerHour: slope("heap") },
  ...stats,
  errorSamples: errors,
};
console.log(`SUMMARY ${JSON.stringify(summary)}`);
rclbun.shutdown();
const ok = stats.errors === 0 && summary.rssMB.slopePerHour <= MAX_SLOPE && stats.received > 0 && stats.goals > 0;
process.exit(ok ? 0 : 1);
