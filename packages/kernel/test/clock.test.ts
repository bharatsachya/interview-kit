import { describe, expect, it } from "vitest";
import { FixedClock, SystemClock } from "../src/index";

describe("FixedClock", () => {
  it("starts where it was told to and does not move on its own", () => {
    const clock = new FixedClock(1_700_000_000_000);
    expect(clock.now()).toBe(1_700_000_000_000);
    expect(clock.now()).toBe(1_700_000_000_000);
  });

  it("advances virtual time on sleep without waiting", async () => {
    const clock = new FixedClock(0);
    const startedReal = Date.now();

    await clock.sleep(60_000);

    expect(clock.now()).toBe(60_000);
    // A minute of virtual time, near-zero real time. This is what keeps the H4 rate-limiter
    // tests fast enough to run on every save.
    expect(Date.now() - startedReal).toBeLessThan(1_000);
  });

  it("wakes sleepers in wake-time order, not call order", async () => {
    const clock = new FixedClock(0);
    const woke: string[] = [];

    await Promise.all([
      clock.sleep(5_000).then(() => void woke.push("long")),
      clock.sleep(1_000).then(() => void woke.push("short")),
    ]);

    expect(woke).toEqual(["short", "long"]);
  });

  it("resolves a zero or negative sleep immediately without moving time", async () => {
    const clock = new FixedClock(500);
    await clock.sleep(0);
    await clock.sleep(-10);
    expect(clock.now()).toBe(500);
  });

  it("never moves backwards", () => {
    const clock = new FixedClock(1_000);
    clock.advanceTo(500);
    expect(clock.now()).toBe(1_000);
  });
});

describe("SystemClock", () => {
  it("reports wall-clock time", () => {
    const before = Date.now();
    const now = new SystemClock().now();
    expect(now).toBeGreaterThanOrEqual(before);
  });

  it("actually waits", async () => {
    const started = Date.now();
    await new SystemClock().sleep(20);
    expect(Date.now() - started).toBeGreaterThanOrEqual(15);
  });
});
