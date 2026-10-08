// bun examples/lifecycle.ts  then: ros2 lifecycle set /managed configure && ros2 lifecycle set /managed activate
import * as rclbun from "rclbunjs";
const { CallbackReturnCode } = rclbun.lifecycle;

await rclbun.init();
const node = rclbun.createLifecycleNode("managed");
const pub = node.createLifecyclePublisher("std_msgs/msg/String", "status");
node.registerOnConfigure(() => (node.getLogger().info("configured"), CallbackReturnCode.SUCCESS));
node.registerOnActivate(() => (node.getLogger().info("activated"), CallbackReturnCode.SUCCESS));
node.createTimer(1_000_000_000n, () => pub.publish({ data: `state=${node.currentState.label}` }));
node.spin();
