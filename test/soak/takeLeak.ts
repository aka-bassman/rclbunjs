// Regression probe for native leaks on service takes: rmw_cyclonedds leaked
// the strings/sequences left in a reused C message by the previous take.
// Measures glibc main-arena bytes per call (allocations on the JS thread) and
// exits 1 if any call type retains more than 16 bytes per call.
//   RMW_IMPLEMENTATION=rmw_cyclonedds_cpp scripts/docker-test.sh bun test/soak/takeLeak.ts
import { cc } from "bun:ffi";
import { join } from "node:path";
import * as rclbun from "../../src/index.ts";

const malloc = cc({ source: join(import.meta.dir, "mallinfo.c"), symbols: { native_in_use: { returns: "u64", args: [] } } }).symbols;
const bytes = () => Number(malloc.native_in_use());

await rclbun.init();
const node = rclbun.createNode("take_leak");
const peer = rclbun.createNode("take_leak_peer");
node.spin();
peer.spin();
peer.declareParameter(new rclbun.Parameter("gain", rclbun.ParameterType.PARAMETER_DOUBLE, 1.0));
const list = node.createClient("rcl_interfaces/srv/ListParameters", "/take_leak_peer/list_parameters");
const get = node.createClient("rcl_interfaces/srv/GetParameters", "/take_leak_peer/get_parameters");
const set = node.createClient("rcl_interfaces/srv/SetParameters", "/take_leak_peer/set_parameters");
await list.waitForService(5000);

let worst = 0;
async function probe(name: string, n: number, call: (i: number) => Promise<unknown>) {
  for (let i = 0; i < 200; i++) await call(i);
  Bun.gc(true);
  const b0 = bytes();
  for (let i = 0; i < n; i++) await call(i);
  Bun.gc(true);
  await Bun.sleep(300);
  const perCall = (bytes() - b0) / n;
  worst = Math.max(worst, perCall);
  console.log(`${name.padEnd(16)} ${perCall.toFixed(1)} bytes/call`);
}
await probe("ListParameters", 3000, () => list.sendRequestAsync({ prefixes: [], depth: 0 }, { timeout: 5000 }));
await probe("GetParameters", 3000, () => get.sendRequestAsync({ names: ["gain"] }, { timeout: 5000 }));
await probe("SetParameters", 3000, (i) => set.sendRequestAsync({ parameters: [{ name: "gain", value: { type: 3, double_value: i } }] }, { timeout: 5000 }));
rclbun.shutdown();
console.log(`${node.getRMWImplementationIdentifier?.() ?? ""} worst ${worst.toFixed(1)} bytes/call`);
process.exit(worst > 16 ? 1 : 0);
