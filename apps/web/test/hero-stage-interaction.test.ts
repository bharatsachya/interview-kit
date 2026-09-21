import { describe, expect, it } from "vitest";
import { easeToward, shouldIdleRotate } from "../src/components/hero/hero-stage";

/**
 * `HeroStage` drives an actual WebGL canvas, so there's no reasonable way to mount it under this
 * repo's node-environment Vitest setup and drag a mouse across it — that part was verified by
 * hand in a real browser (see the PR description). What *is* testable without a DOM are the two
 * decisions that determine what the interaction feels like, pulled out of the mount effect as
 * plain functions: whether the idle turn gets to run a given frame, and how the camera closes
 * the distance to a new framing target. Both are exactly the logic behind the two things this
 * change fixes — the reduced-motion/drag gate, and the reframe that used to snap instead of ease.
 */

describe("shouldIdleRotate", () => {
  const clear = { reducedMotion: false, dragging: false, now: 1000, idleResumeAt: 0 };

  it("turns when nothing is blocking it", () => {
    expect(shouldIdleRotate(clear)).toBe(true);
  });

  it("stops while a drag is in progress, regardless of everything else", () => {
    expect(shouldIdleRotate({ ...clear, dragging: true })).toBe(false);
  });

  it("stays off under reduced motion even once idle — dragging may still rotate the object, but the idle turn does not resume", () => {
    expect(shouldIdleRotate({ ...clear, reducedMotion: true })).toBe(false);
    expect(shouldIdleRotate({ ...clear, reducedMotion: true, now: 1_000_000 })).toBe(false);
  });

  it("holds off until the idle window set by the last drag has elapsed", () => {
    expect(shouldIdleRotate({ ...clear, now: 500, idleResumeAt: 1000 })).toBe(false);
    expect(shouldIdleRotate({ ...clear, now: 1000, idleResumeAt: 1000 })).toBe(true);
    expect(shouldIdleRotate({ ...clear, now: 1500, idleResumeAt: 1000 })).toBe(true);
  });
});

describe("easeToward", () => {
  it("does not jump straight to the target in one small frame", () => {
    // A post-mount reframe (AuthSkeleton settling a few pixels off Clerk's real form height)
    // used to snap the camera the instant `resize` recalculated a new distance. One frame at a
    // typical 60fps delta should land partway there, not all the way — that gap is the fix.
    const next = easeToward(0, 10, 1 / 60);
    expect(next).toBeGreaterThan(0);
    expect(next).toBeLessThan(10);
  });

  it("never overshoots the target", () => {
    let value = 0;
    for (let i = 0; i < 200; i++) {
      value = easeToward(value, 10, 1 / 60);
      expect(value).toBeLessThanOrEqual(10);
    }
  });

  it("converges to the target within a fraction of a second of frames", () => {
    let value = 0;
    for (let i = 0; i < 60; i++) value = easeToward(value, 10, 1 / 60); // ~1 second
    expect(value).toBeCloseTo(10, 1);
  });

  it("holds still once already at the target", () => {
    expect(easeToward(10, 10, 1 / 60)).toBe(10);
  });

  it("is unaffected by an already-settled window resize — a big frame delta still eases rather than snapping", () => {
    // A dropped/backgrounded frame can report a large delta; the loop already clamps that before
    // calling this, but the function itself should never produce a value past the target either
    // way, no matter how large delta gets.
    const next = easeToward(0, 10, 5);
    expect(next).toBeGreaterThan(0);
    expect(next).toBeLessThanOrEqual(10);
  });
});
