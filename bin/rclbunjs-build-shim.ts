#!/usr/bin/env bun
// Compiles the native shim with the system C compiler, so that processes load
// it instead of compiling src/native/shim.c with TinyCC at startup (e.g. once
// while building a Docker image). Needs a C compiler and a sourced ROS 2.
//   bunx rclbunjs-build-shim [--out <path>]
// The default output is where rclbunjs looks for it (<package>/build/librclbunjs_shim.so);
// point RCLBUN_SHIM at any other path. CC and ROS_PREFIX override the compiler and ROS 2 prefix.
import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { distroDefine, LIBS, rosRoot, shimIncludeDirs } from "../src/native/loader.ts";

const args = process.argv.slice(2);
let out = join(import.meta.dir, "..", "build", "librclbunjs_shim.so");
for (let i = 0; i < args.length; i++) {
  const a = args[i]!;
  if (a === "--out" && args[i + 1]) out = resolve(args[++i]!);
  else if (a.startsWith("--out=")) out = resolve(a.slice("--out=".length));
  else {
    console.error("usage: rclbunjs-build-shim [--out <path>]");
    process.exit(a === "--help" || a === "-h" ? 0 : 2);
  }
}

const root = process.env.ROS_PREFIX || rosRoot();
const lib = join(root, "lib");
const define = distroDefine();
mkdirSync(dirname(out), { recursive: true });
// Teardown calls ignore rcl return codes on purpose, hence -Wno-unused-result.
const cmd = [
  process.env.CC || "cc",
  "-O2", "-fPIC", "-shared",
  ...(define ? [`-D${define}`] : []),
  "-Wall", "-Wno-unused-function", "-Wno-unused-result",
  "-o", out,
  join(import.meta.dir, "..", "src", "native", "shim.c"),
  ...shimIncludeDirs(root).map((d) => `-I${d}`),
  `-L${lib}`, `-Wl,-rpath,${lib}`,
  ...LIBS.map((l) => `-l${l}`),
  "-lpthread",
];
const r = Bun.spawnSync(cmd, { stdout: "inherit", stderr: "inherit" });
if (r.exitCode !== 0) {
  console.error(`rclbunjs-build-shim: ${cmd[0]} failed (exit ${r.exitCode ?? "signal"})`);
  process.exit(1);
}
console.log(`built ${out}`);
