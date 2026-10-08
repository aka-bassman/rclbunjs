import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as rclbun from "../../src/index.ts";

let node: rclbun.Node;
beforeAll(async () => {
  await rclbun.init();
  node = rclbun.createNode("action_test");
  node.spin();
});
afterAll(() => rclbun.shutdown());

const FIB = "example_interfaces/action/Fibonacci";

function fibServer(name: string, opts: { delayMs?: number; cancelable?: boolean } = {}) {
  return new rclbun.ActionServer(
    node,
    FIB,
    name,
    async (gh) => {
      const seq = [0, 1];
      for (let i = 1; i < gh.request.order; i++) {
        if (gh.isCancelRequested) {
          gh.canceled();
          return { sequence: seq };
        }
        seq.push(seq[i]! + seq[i - 1]!);
        gh.publishFeedback({ sequence: seq });
        await Bun.sleep(opts.delayMs ?? 5);
      }
      gh.succeed();
      return { sequence: seq };
    },
    (goal: any) => (goal.order > 100 ? rclbun.GoalResponse.REJECT : rclbun.GoalResponse.ACCEPT),
    undefined,
    () => (opts.cancelable ? rclbun.CancelResponse.ACCEPT : rclbun.CancelResponse.REJECT),
  );
}

describe("actions (bun <-> bun)", () => {
  test("goal with feedback and result", async () => {
    fibServer("fib");
    const client = new rclbun.ActionClient(node, FIB, "fib");
    expect(await client.waitForServer(5000)).toBe(true);
    const feedback: number[][] = [];
    const gh = await client.sendGoal({ order: 6 }, (f: any) => feedback.push(Array.from(f.sequence)));
    expect(gh.accepted).toBe(true);
    const result: any = await gh.getResult();
    expect(Array.from(result.sequence)).toEqual([0, 1, 1, 2, 3, 5, 8]);
    expect(gh.isSucceeded()).toBe(true);
    expect(feedback.length).toBeGreaterThan(0);
  });

  test("rejected goal", async () => {
    const client = new rclbun.ActionClient(node, FIB, "fib");
    await client.waitForServer(5000);
    const gh = await client.sendGoal({ order: 1000 });
    expect(gh.accepted).toBe(false);
  });

  test("cancel", async () => {
    fibServer("fib_slow", { delayMs: 50, cancelable: true });
    const client = new rclbun.ActionClient(node, FIB, "fib_slow");
    await client.waitForServer(5000);
    const gh = await client.sendGoal({ order: 50 });
    await Bun.sleep(120);
    const c = await gh.cancelGoal();
    expect(c.return_code).toBe(0);
    expect(c.goals_canceling.length).toBe(1);
    await gh.getResult();
    expect(gh.isCanceled()).toBe(true);
  });
});

describe("actions interop", () => {
  test("rclpy action server <- bun client", async () => {
    const p = Bun.spawn(["python3", "-c", `
import rclpy
from rclpy.action import ActionServer
from example_interfaces.action import Fibonacci
rclpy.init(); n = rclpy.create_node('py_action_server')
def execute(gh):
    fb = Fibonacci.Feedback(); fb.sequence = [0, 1]
    for i in range(1, gh.request.order):
        fb.sequence.append(fb.sequence[i] + fb.sequence[i-1]); gh.publish_feedback(fb)
    gh.succeed(); r = Fibonacci.Result(); r.sequence = fb.sequence; return r
ActionServer(n, Fibonacci, 'py_fib', execute)
rclpy.spin(n)
`]);
    const client = new rclbun.ActionClient(node, FIB, "py_fib");
    expect(await client.waitForServer(15000)).toBe(true);
    let fb = 0;
    const gh = await client.sendGoal({ order: 5 }, () => fb++);
    const result: any = await gh.getResult();
    expect(Array.from(result.sequence)).toEqual([0, 1, 1, 2, 3, 5]);
    expect(gh.status).toBe(rclbun.GoalStatus.STATUS_SUCCEEDED);
    p.kill();
  }, 30000);

  test("bun action server <- rclpy client and ros2 action CLI", async () => {
    fibServer("bun_fib");
    const out = await new Response(
      Bun.spawn(["python3", "-c", `
import rclpy
from rclpy.action import ActionClient
from example_interfaces.action import Fibonacci
rclpy.init(); n = rclpy.create_node('py_action_client')
c = ActionClient(n, Fibonacci, 'bun_fib'); c.wait_for_server(timeout_sec=10.0)
fbs = []
f = c.send_goal_async(Fibonacci.Goal(order=7), feedback_callback=lambda m: fbs.append(1))
rclpy.spin_until_future_complete(n, f, timeout_sec=10.0)
gh = f.result(); print('ACCEPTED', gh.accepted)
rf = gh.get_result_async(); rclpy.spin_until_future_complete(n, rf, timeout_sec=10.0)
print('RESULT', list(rf.result().result.sequence), 'STATUS', rf.result().status, 'FB', len(fbs) > 0)
`]).stdout,
    ).text();
    expect(out).toContain("ACCEPTED True");
    expect(out).toContain("RESULT [0, 1, 1, 2, 3, 5, 8, 13] STATUS 4 FB True");
    expect(rclbun.getActionNamesAndTypes(node)).toContainEqual({ name: "/bun_fib", types: [FIB] });
    let list = "";
    for (let i = 0; i < 10 && !list.includes("/bun_fib"); i++) {
      list = (await Bun.$`ros2 action list -t`.nothrow().quiet()).text();
    }
    expect(list).toContain("/bun_fib [example_interfaces/action/Fibonacci]");
  }, 60000);
});
