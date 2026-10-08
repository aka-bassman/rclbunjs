// bun benchmark/codec.ts — CDR encode/decode throughput (no ROS needed: uses
// the interface fixtures under test/fixtures/ament).
import { join } from "node:path";

process.env.AMENT_PREFIX_PATH = join(import.meta.dir, "..", "test", "fixtures", "ament");
const { getMessageType } = await import("../src/interfaces/registry.ts");

const header = { stamp: { sec: 1, nanosec: 2 }, frame_id: "base_link" };
const cases: [string, unknown][] = [
  ["std_msgs/msg/String", { data: "hello world" }],
  ["geometry_msgs/msg/Twist", { linear: { x: 1, y: 2, z: 3 }, angular: { x: 4, y: 5, z: 6 } }],
  ["sensor_msgs/msg/Imu", { header, orientation: { w: 1 }, orientation_covariance: new Float64Array(9) }],
  [
    "sensor_msgs/msg/JointState",
    { header, name: ["a", "b", "c", "d", "e", "f"], position: new Float64Array(6), velocity: new Float64Array(6), effort: new Float64Array(6) },
  ],
  [
    "sensor_msgs/msg/LaserScan",
    { header, angle_min: -1, angle_max: 1, ranges: new Float32Array(720), intensities: new Float32Array(720) },
  ],
  ["sensor_msgs/msg/Image", { header, height: 480, width: 640, encoding: "rgb8", step: 1920, data: new Uint8Array(640 * 480 * 3) }],
  [
    "test_msgs/msg/MultiNested",
    getMessageType("test_msgs/msg/MultiNested").create(),
  ],
];

function bench(fn: () => void, minMs = 300): number {
  for (let i = 0; i < 200; i++) fn();
  let n = 0;
  const t0 = performance.now();
  let t = t0;
  while (t - t0 < minMs) {
    for (let i = 0; i < 100; i++) fn();
    n += 100;
    t = performance.now();
  }
  return (n * 1000) / (t - t0);
}

const fmt = (x: number) => (x >= 1e6 ? `${(x / 1e6).toFixed(2)}M` : x >= 1e3 ? `${(x / 1e3).toFixed(1)}k` : x.toFixed(0));
console.log(`${"type".padEnd(30)} ${"bytes".padStart(8)} ${"encode/s".padStart(10)} ${"decode/s".padStart(10)} ${"zero-copy".padStart(10)}`);
for (const [type, msg] of cases) {
  const mt = getMessageType(type);
  const bytes = mt.encode(msg);
  const enc = bench(() => mt.encode(msg));
  const dec = bench(() => mt.decode(bytes));
  const zc = bench(() => mt.decode(bytes, { zeroCopy: true }));
  console.log(`${type.padEnd(30)} ${String(bytes.length).padStart(8)} ${fmt(enc).padStart(10)} ${fmt(dec).padStart(10)} ${fmt(zc).padStart(10)}`);
}
