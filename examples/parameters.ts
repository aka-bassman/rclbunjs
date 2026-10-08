// bun examples/parameters.ts --ros-args -p speed:=2.5
import * as rclbun from "rclbunjs";
const { Parameter, ParameterType, ParameterDescriptor, FloatingPointRange } = rclbun;

await rclbun.init();
const node = rclbun.createNode("param_demo");
const d = new ParameterDescriptor("speed", ParameterType.PARAMETER_DOUBLE, "max speed (m/s)");
d.rangeConstraint = new FloatingPointRange(0, 5);
node.declareParameter(new Parameter("speed", ParameterType.PARAMETER_DOUBLE, 1.0), d);
node.addPostSetParametersCallback((ps) => ps.forEach((p) => node.getLogger().info(`${p.name} -> ${p.value}`)));
node.getLogger().info(`speed = ${node.getParameter("speed").value}  (try: ros2 param set /param_demo speed 3.0)`);
node.spin();
