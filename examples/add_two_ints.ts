// bun examples/add_two_ints.ts — service server and client in one process
import * as rclbun from "rclbunjs";

await rclbun.init();
const node = rclbun.createNode("add_two_ints");
node.createService("example_interfaces/srv/AddTwoInts", "add_two_ints", (req) => ({ sum: req.a + req.b }));
node.spin();

const client = node.createClient("example_interfaces/srv/AddTwoInts", "add_two_ints");
await client.waitForService(5000);
const res = await client.sendRequestAsync({ a: 2n, b: 40n }, { timeout: 5000 });
console.log(`2 + 40 = ${res.sum}`);
rclbun.shutdown();
