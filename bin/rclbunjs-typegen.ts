#!/usr/bin/env bun
// Generates TypeScript declarations for installed ROS 2 interfaces.
//   bunx rclbunjs-typegen [--out rclbunjs-interfaces.d.ts] [--packages a,b] [--module rclbunjs]
import { writeFileSync } from "node:fs";
import { generateDeclarations } from "../src/interfaces/typegen.ts";

const args = process.argv.slice(2);
const opt = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const out = opt("--out") ?? "rclbunjs-interfaces.d.ts";
const packages = opt("--packages")?.split(",").filter(Boolean);
const moduleName = opt("--module") ?? "rclbunjs";
const { text, counts, errors } = generateDeclarations({ packages, moduleName });
writeFileSync(out, text);
console.log(`wrote ${out}: ${counts.messages} messages, ${counts.services} services, ${counts.actions} actions`);
for (const e of errors) console.warn(`skipped ${e}`);
