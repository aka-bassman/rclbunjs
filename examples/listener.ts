// bun examples/listener.ts
import * as rclbun from "rclbunjs";

await rclbun.init();
const node = rclbun.createNode("listener");
node.createSubscription("std_msgs/msg/String", "chatter", (msg) => {
  node.getLogger().info(`I heard: ${msg.data}`);
});
node.spin();
