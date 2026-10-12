// bun examples/fibonacciAction.ts — action server and client
import * as rclbun from "rclbunjs";

await rclbun.init();
const node = rclbun.createNode("fibonacci");
node.spin();

new rclbun.ActionServer(node, "example_interfaces/action/Fibonacci", "fibonacci", async (goal) => {
  const sequence = [0, 1];
  for (let i = 1; i < goal.request.order; i++) {
    sequence.push(sequence[i]! + sequence[i - 1]!);
    goal.publishFeedback({ sequence });
    await Bun.sleep(100);
  }
  goal.succeed();
  return { sequence };
});

const client = new rclbun.ActionClient(node, "example_interfaces/action/Fibonacci", "fibonacci");
await client.waitForServer(5000);
const handle = await client.sendGoal({ order: 8 }, (fb) => console.log("feedback", Array.from(fb.sequence)));
console.log("result", Array.from((await handle.getResult()).sequence));
rclbun.shutdown();
