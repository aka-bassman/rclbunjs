import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as rclbun from "../../src/index.ts";
const { lifecycle } = rclbun;

let node: rclbun.lifecycle.LifecycleNode;
beforeAll(async () => {
  await rclbun.init();
  node = rclbun.createLifecycleNode("lc_node");
  node.spin();
});
afterAll(() => rclbun.shutdown());

describe("lifecycle", () => {
  test("transitions, callbacks and managed publishers", async () => {
    const calls: string[] = [];
    node.registerOnConfigure((prev) => {
      calls.push(`configure from ${prev.label}`);
      return lifecycle.CallbackReturnCode.SUCCESS;
    });
    node.registerOnActivate(() => {
      calls.push("activate");
      return lifecycle.CallbackReturnCode.SUCCESS;
    });
    const pub = node.createLifecyclePublisher("std_msgs/msg/String", "lc_chatter");
    let got = 0;
    node.createSubscription("std_msgs/msg/String", "lc_chatter", () => got++);
    expect(node.currentState.label).toBe("unconfigured");
    expect(node.configure().label).toBe("inactive");
    pub.publish({ data: "dropped" });
    expect(pub.isActivated()).toBe(false);
    expect(node.activate().label).toBe("active");
    expect(pub.isActivated()).toBe(true);
    await Bun.sleep(100);
    pub.publish({ data: "sent" });
    await Bun.sleep(200);
    expect(got).toBe(1);
    expect(calls).toEqual(["configure from unconfigured", "activate"]);
    expect(node.deactivate().label).toBe("inactive");
    expect(node.cleanup().label).toBe("unconfigured");
  });

  test("failure and error handling", () => {
    node.registerOnConfigure(() => lifecycle.CallbackReturnCode.FAILURE);
    expect(node.configure().label).toBe("unconfigured");
    node.registerOnConfigure(() => {
      throw new Error("boom");
    });
    node.registerOnError(() => lifecycle.CallbackReturnCode.SUCCESS);
    expect(node.configure().label).toBe("unconfigured");
    expect(() => node.activate()).toThrow();
    node.registerOnConfigure(() => lifecycle.CallbackReturnCode.SUCCESS);
  });

  test("ros2 lifecycle CLI drives the bun node", async () => {
    const run = async (args: string) => (await Bun.$`ros2 lifecycle ${{ raw: args }}`.nothrow().quiet()).text();
    let nodes = "";
    for (const end = Date.now() + 20000; !nodes.includes("/lc_node") && Date.now() < end; await Bun.sleep(250)) nodes = await run("nodes");
    expect(nodes).toContain("/lc_node");
    expect(await run("get /lc_node")).toContain("unconfigured [1]");
    expect(await run("set /lc_node configure")).toContain("Transitioning successful");
    expect(node.currentState.label).toBe("inactive");
    const list = await run("list /lc_node");
    expect(list).toContain("activate [3]");
    expect(list).toContain("cleanup [2]");
    expect(await run("set /lc_node activate")).toContain("Transitioning successful");
    expect(await run("get /lc_node")).toContain("active [3]");
  }, 90000);
});
