// maxHz gate of subscriptions, with synthetic timestamps.
import { describe, expect, test } from "bun:test";
import { RateGate } from "../../src/core/subscription.ts";

/** Messages the gate lets through from a source at `sourceHz` over `seconds`. */
function passed(maxHz: number, sourceHz: number, seconds: number, jitterMs = 0): number {
  const gate = new RateGate(maxHz);
  let n = 0;
  for (let i = 0; i < sourceHz * seconds; i++) {
    const t = 1000 + (i * 1000) / sourceHz + (jitterMs ? ((i * 7919) % 100) / 100 * jitterMs : 0);
    if (gate.due(t)) n++;
  }
  return n;
}

describe("RateGate", () => {
  test("keeps the requested rate when it does not divide the source rate", () => {
    // restarting the period at each delivery would give 25 Hz (every 4th message of 100 Hz)
    expect(passed(30, 100, 10)).toBeGreaterThanOrEqual(299);
    expect(passed(30, 100, 10)).toBeLessThanOrEqual(301);
    expect(passed(60, 250, 10)).toBeGreaterThanOrEqual(599);
    expect(passed(60, 250, 10)).toBeLessThanOrEqual(601);
    expect(passed(30, 100, 10, 3)).toBeLessThanOrEqual(301);
    expect(passed(30, 100, 10, 3)).toBeGreaterThanOrEqual(290);
  });

  test("passes everything from a source slower than the limit", () => {
    expect(passed(50, 20, 5)).toBe(100);
  });

  test("first message passes; after a pause the period restarts instead of bursting", () => {
    const gate = new RateGate(10); // 100 ms
    expect(gate.due(5000)).toBe(true);
    expect(gate.due(5050)).toBe(false);
    expect(gate.due(5100)).toBe(true);
    // 2 s of silence, then a burst: one message, then the normal period again
    expect(gate.due(7100)).toBe(true);
    expect(gate.due(7101)).toBe(false);
    expect(gate.due(7150)).toBe(false);
    expect(gate.due(7200)).toBe(true);
  });
});
