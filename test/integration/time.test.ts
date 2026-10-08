import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as rclbun from "../../src/index.ts";
import { ClockChange, Duration, ROSClock, Time, ClockType } from "../../src/index.ts";

let node: rclbun.Node;
beforeAll(async () => {
  await rclbun.init();
  node = rclbun.createNode("time_test");
  node.spin();
});
afterAll(() => rclbun.shutdown());

const until = async (cond: () => boolean, ms = 5000) => {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await Bun.sleep(5);
  return cond();
};

const rosTime = (ns: bigint) => Time.fromNanoseconds(ns, ClockType.ROS_TIME);

describe("clock jump callbacks", () => {
  test("activation, forward and backward jumps", () => {
    const clock = new ROSClock();
    const events: string[] = [];
    const cb = {
      _pre_callback: () => events.push("pre"),
      _post_callback: (j: rclbun.JumpInfo) => events.push(`post:${j.clock_change}:${j.delta}`),
    };
    clock.addClockCallback(cb, true, 1_000_000_000n, -1_000_000_000n);
    clock.isRosTimeActive = true;
    expect(events).toEqual(["pre", `post:${ClockChange.ROS_TIME_ACTIVATED}:0`]);

    events.length = 0;
    clock.rosTimeOverride = rosTime(5_000_000_000n);
    expect(events).toEqual(["pre", `post:${ClockChange.ROS_TIME_NO_CHANGE}:5000000000`]);

    events.length = 0;
    clock.rosTimeOverride = rosTime(5_500_000_000n); // below both thresholds
    expect(events).toEqual([]);
    clock.rosTimeOverride = rosTime(1_000_000_000n); // 4.5s backwards
    expect(events).toEqual(["pre", `post:${ClockChange.ROS_TIME_NO_CHANGE}:-4500000000`]);

    events.length = 0;
    clock.removeClockCallback(cb);
    clock.isRosTimeActive = false;
    expect(events).toEqual([]);
    expect(() => clock.removeClockCallback(cb)).toThrow();
  });

  test("sleepUntil wakes on ROS time and stops on deactivation", async () => {
    const clock = new ROSClock();
    clock.isRosTimeActive = true;
    clock.rosTimeOverride = rosTime(10_000_000_000n);
    setTimeout(() => (clock.rosTimeOverride = rosTime(10_500_000_000n)), 30);
    setTimeout(() => (clock.rosTimeOverride = rosTime(12_000_000_000n)), 60);
    expect(await clock.sleepFor(new Duration(1n, 0n))).toBe(true);
    expect(clock.now().nanoseconds).toBe(12_000_000_000n);

    setTimeout(() => (clock.isRosTimeActive = false), 30);
    const t0 = Date.now();
    expect(await clock.sleepUntil(rosTime(99_000_000_000n))).toBe(false);
    expect(Date.now() - t0).toBeLessThan(2000);
  });

  test("system clock sleep", async () => {
    const clock = new rclbun.Clock(ClockType.STEADY_TIME);
    const t0 = clock.now().nanoseconds;
    expect(await clock.sleepFor(Duration.fromNanoseconds(50_000_000n))).toBe(true);
    expect(clock.now().nanoseconds - t0).toBeGreaterThanOrEqual(50_000_000n);
  });
});

describe("timer", () => {
  test("TimerInfo carries expected and actual call times", async () => {
    const infos: rclbun.TimerInfo[] = [];
    const timer = node.createTimer(20_000_000n, (info) => infos.push(info!));
    expect(await until(() => infos.length >= 3)).toBe(true);
    node.destroyTimer(timer);
    for (const i of infos) {
      expect(typeof i.expectedCallTime).toBe("bigint");
      expect(i.actualCallTime).toBeGreaterThanOrEqual(i.expectedCallTime);
    }
    // expected call times advance by exactly one period
    expect(infos[2]!.expectedCallTime - infos[1]!.expectedCallTime).toBe(20_000_000n);
  });

  test("on-reset callback reports pending and new resets", () => {
    const timer = node.createTimer(1_000_000_000n, () => {});
    timer.reset();
    timer.reset();
    const counts: number[] = [];
    timer.setOnResetCallback((n) => counts.push(n));
    expect(counts).toEqual([2]);
    timer.reset();
    expect(counts).toEqual([2, 1]);
    timer.clearOnResetCallback();
    timer.reset();
    expect(counts).toEqual([2, 1]);
    node.destroyTimer(timer);
  });
});
