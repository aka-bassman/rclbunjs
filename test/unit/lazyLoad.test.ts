// Importing rclbunjs without a ROS 2 installation: the native shim loads on first use.
import { expect, test } from "bun:test";
import { join } from "node:path";

const index = join(import.meta.dir, "..", "..", "src", "index.ts");

function runWithoutRos(script: string): any {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && k !== "AMENT_PREFIX_PATH" && k !== "ROS_DISTRO" && k !== "RCLBUN_FORCE_CC") env[k] = v;
  }
  env.RCLBUN_SHIM = "/nonexistent/librclbunjs_shim.so";
  const r = Bun.spawnSync([process.execPath, "-e", script], { env, stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`exit ${r.exitCode}: ${r.stderr.toString()}`);
  return JSON.parse(r.stdout.toString());
}

test("imports without ROS 2; isAvailable/loadError report why, init throws", () => {
  const out = runWithoutRos(`
    const r = await import(${JSON.stringify(index)});
    const out = { sigint: process.listenerCount("SIGINT"), available: r.isAvailable(), error: r.loadError()?.message ?? null };
    out.qos = r.QoS.from(r.QoS.profileSensorData).depth;
    out.args = r.removeROSArgs(["a", "--ros-args", "-r", "x:=y", "--", "b"]);
    try { await r.init(); } catch (e) { out.initError = e.message; }
    try { void r.features.loggerService; } catch (e) { out.featuresError = e.message; }
    out.availableAgain = r.isAvailable();
    console.log(JSON.stringify(out));
  `);
  expect(out.sigint).toBe(0);
  expect(out.available).toBe(false);
  expect(out.error).toContain("could not find a ROS 2 installation");
  expect(out.qos).toBe(5);
  expect(out.args).toEqual(["a", "b"]);
  expect(out.initError).toBe(out.error);
  expect(out.featuresError).toBe(out.error);
  expect(out.availableAgain).toBe(false);
});

test("no SIGINT handler on import; installSignalHandlers/removeSignalHandlers", () => {
  const out = runWithoutRos(`
    const r = await import(${JSON.stringify(index)});
    const counts = [process.listenerCount("SIGINT")];
    r.installSignalHandlers();
    r.installSignalHandlers();
    counts.push(process.listenerCount("SIGINT"));
    r.removeSignalHandlers();
    r.removeSignalHandlers();
    counts.push(process.listenerCount("SIGINT"));
    console.log(JSON.stringify(counts));
  `);
  expect(out).toEqual([0, 1, 0]);
});
