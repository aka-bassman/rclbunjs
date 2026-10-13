// Errors caught by the executor (NodeOptions.onError), subscription maxHz, init({ handleSignals }).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import * as rclbun from "../../src/index.ts";

const errors: [unknown, rclbun.NodeErrorContext][] = [];
let node: rclbun.Node;
beforeAll(async () => {
  await rclbun.init();
  node = rclbun.createNode("executor_test", "", undefined, { onError: (e, c) => errors.push([e, c]) });
  node.spin();
});
afterAll(() => rclbun.shutdown());

const until = async (cond: () => boolean, ms = 5000) => {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await Bun.sleep(5);
  return cond();
};
const message = (e: unknown) => (e as Error).message;

describe("onError", () => {
  test("subscription callback exceptions, with the topic; later messages still arrive", async () => {
    errors.length = 0;
    const got: string[] = [];
    const sub = node.createSubscription("std_msgs/msg/String", "err_chatter", (m: any) => {
      if (m.data === "bad") throw new Error("callback failed");
      got.push(m.data);
    });
    const pub = node.createPublisher("std_msgs/msg/String", "err_chatter");
    expect(await until(() => pub.subscriptionCount > 0)).toBe(true);
    pub.publish("bad");
    expect(await until(() => errors.length === 1)).toBe(true);
    pub.publish("good");
    expect(await until(() => got.length === 1)).toBe(true);
    expect(got).toEqual(["good"]);
    expect(message(errors[0]![0])).toBe("callback failed");
    expect(errors[0]![1]).toEqual({ kind: "subscription", name: "/err_chatter" });
    node.destroySubscription(sub);
    node.destroyPublisher(pub);
  });

  test("timer and guard condition callbacks", async () => {
    errors.length = 0;
    const timer = node.createTimer(10_000_000n, () => {
      timer.cancel();
      throw new Error("timer failed");
    });
    expect(await until(() => errors.length === 1)).toBe(true);
    expect(errors[0]![1]).toEqual({ kind: "timer" });
    node.destroyTimer(timer);
    const guard = node.createGuardCondition(() => {
      throw new Error("guard failed");
    });
    guard.trigger();
    expect(await until(() => errors.length === 2)).toBe(true);
    expect(message(errors[1]![0])).toBe("guard failed");
    expect(errors[1]![1]).toEqual({ kind: "guard" });
    node.destroyGuardCondition(guard);
  });

  test("sendRequest callbacks, with the service name", async () => {
    errors.length = 0;
    const service = node.createService("example_interfaces/srv/AddTwoInts", "err_add", (req: any) => ({ sum: req.a + req.b }));
    const client = node.createClient("example_interfaces/srv/AddTwoInts", "err_add");
    expect(await client.waitForService(5000)).toBe(true);
    client.sendRequest({ a: 1n, b: 2n }, () => {
      throw new Error("response callback failed");
    });
    expect(await until(() => errors.length === 1)).toBe(true);
    expect(message(errors[0]![0])).toBe("response callback failed");
    expect(errors[0]![1]).toEqual({ kind: "client", name: "/err_add" });
    node.destroyClient(client);
    node.destroyService(service);
  });

  test.skipIf(!rclbun.features.matchedEvents)("QoS event callbacks, with the topic", async () => {
    errors.length = 0;
    const pub = node.createPublisher("std_msgs/msg/String", "err_events", undefined, {
      matched: () => {
        throw new Error("event callback failed");
      },
    });
    const sub = node.createSubscription("std_msgs/msg/String", "err_events", () => {});
    expect(await until(() => errors.length >= 1)).toBe(true);
    expect(errors[0]![1]).toEqual({ kind: "event", name: "/err_events" });
    node.destroySubscription(sub);
    node.destroyPublisher(pub);
  });

  test("spinOnce hands errors to the handler instead of throwing; the handler can be set later", async () => {
    const other = rclbun.createNode("executor_test_once");
    try {
      other.createGuardCondition(() => {
        throw new Error("once");
      }).trigger();
      expect(() => other.spinOnce(1000)).toThrow("once");
      const seen: rclbun.NodeErrorContext[] = [];
      other.options.onError = (_e, c) => seen.push(c);
      other.createGuardCondition(() => {
        throw new Error("once again");
      }).trigger();
      other.spinOnce(1000);
      expect(seen).toEqual([{ kind: "guard" }]);
    } finally {
      other.destroy();
    }
  });

  test("without a handler, errors stay uncaught exceptions", () => {
    const script = `
      const rclbun = await import(${JSON.stringify(join(import.meta.dir, "..", "..", "src", "index.ts"))});
      await rclbun.init();
      const node = rclbun.createNode("executor_test_uncaught");
      node.createGuardCondition(() => { throw new Error("nobody catches this"); }).trigger();
      node.spin();
      setTimeout(() => process.exit(0), 3000);
    `;
    const r = Bun.spawnSync([process.execPath, "-e", script], { stderr: "pipe", env: process.env });
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr.toString()).toContain("nobody catches this");
  });
});

describe("maxHz", () => {
  // a 200 Hz source for 1.5 s through a 20 Hz gate
  async function rate(options: rclbun.EntityOptions, type = "std_msgs/msg/Int32", make = (i: number): any => ({ data: i })) {
    let n = 0;
    const qos = new rclbun.QoS(rclbun.HistoryPolicy.RMW_QOS_POLICY_HISTORY_KEEP_LAST, 50, rclbun.ReliabilityPolicy.RMW_QOS_POLICY_RELIABILITY_RELIABLE);
    const sub = node.createSubscription(type, "max_hz", { qos, ...options }, () => n++);
    const pub = node.createPublisher(type, "max_hz", { qos });
    expect(await until(() => pub.subscriptionCount > 0)).toBe(true);
    let i = 0;
    const timer = node.createTimer(5_000_000n, () => pub.publish(make(i++)));
    await Bun.sleep(1500);
    node.destroyTimer(timer);
    await Bun.sleep(100);
    node.destroySubscription(sub);
    node.destroyPublisher(pub);
    return { delivered: n, published: i };
  }

  test("drops messages that come too soon", async () => {
    const { delivered, published } = await rate({ maxHz: 20 });
    expect(published).toBeGreaterThan(100);
    // 1.5 s at 20 Hz: 30 (+1 for the first message)
    expect(delivered).toBeLessThanOrEqual(32);
    expect(delivered).toBeGreaterThanOrEqual(20);
  });

  test("also with loanedMessages (the loan or C message is given back)", async () => {
    const { delivered } = await rate({ maxHz: 20, loanedMessages: true }, "geometry_msgs/msg/Point", (i) => ({ x: i, y: 0, z: 0 }));
    expect(delivered).toBeLessThanOrEqual(32);
    expect(delivered).toBeGreaterThanOrEqual(20);
  });

  test("rejects values that are not positive numbers", () => {
    for (const maxHz of [0, -1, Number.NaN, "10"]) {
      expect(() => node.createSubscription("std_msgs/msg/Int32", "max_hz_bad", { maxHz: maxHz as number }, () => {})).toThrow(rclbun.RangeValidationError);
    }
  });
});

test("init({ handleSignals: true }): SIGINT shuts down every context", () => {
  const script = `
    const rclbun = await import(${JSON.stringify(join(import.meta.dir, "..", "..", "src", "index.ts"))});
    const before = process.listenerCount("SIGINT");
    await rclbun.init(undefined, undefined, { handleSignals: true });
    const node = rclbun.createNode("executor_test_signals");
    node.spin();
    const after = process.listenerCount("SIGINT");
    process.kill(process.pid, "SIGINT");
    await Bun.sleep(200);
    console.log(JSON.stringify({ before, after, shutdown: rclbun.isShutdown(), destroyed: node.isDestroyed() }));
  `;
  const r = Bun.spawnSync([process.execPath, "-e", script], { stderr: "pipe", env: process.env });
  expect(r.stderr.toString()).toBe("");
  expect(JSON.parse(r.stdout.toString())).toEqual({ before: 0, after: 1, shutdown: true, destroyed: true });
});
