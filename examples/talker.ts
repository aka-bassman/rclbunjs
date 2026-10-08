// bun examples/talker.ts
import * as rclbun from "rclbunjs";

await rclbun.init();
const node = rclbun.createNode("talker");
const pub = node.createPublisher("std_msgs/msg/String", "chatter");
let i = 0;
node.createTimer(500_000_000n, () => {
  const data = `Hello ROS 2 from Bun #${i++}`;
  node.getLogger().info(`Publishing: ${data}`);
  pub.publish({ data });
});
node.spin();
