import { describe, expect, it } from "vitest";
import { RandomIdGenerator, ScriptedIdGenerator, SequentialIdGenerator } from "../src/index";

describe("SequentialIdGenerator", () => {
  it("counts per prefix", () => {
    const ids = new SequentialIdGenerator();
    expect([ids.next("r"), ids.next("r"), ids.next("q"), ids.next("r"), ids.next("q")]).toEqual([
      "r1",
      "r2",
      "q1",
      "r3",
      "q2",
    ]);
  });

  it("is deterministic across instances, so kit snapshots match", () => {
    const a = new SequentialIdGenerator();
    const b = new SequentialIdGenerator();
    expect([a.next("r"), a.next("r")]).toEqual([b.next("r"), b.next("r")]);
  });
});

describe("RandomIdGenerator", () => {
  it("does not repeat", () => {
    const ids = new RandomIdGenerator();
    const generated = new Set(Array.from({ length: 500 }, () => ids.next("kit_")));
    expect(generated.size).toBe(500);
  });

  it("keeps the prefix readable", () => {
    expect(new RandomIdGenerator().next("kit_")).toMatch(/^kit_[0-9a-f]{32}$/);
  });
});

describe("ScriptedIdGenerator", () => {
  it("returns the given ids in order, then wraps", () => {
    const ids = new ScriptedIdGenerator(["a", "b"]);
    expect([ids.next("x"), ids.next("x"), ids.next("x")]).toEqual(["a", "b", "a"]);
  });

  it("refuses an empty script rather than returning undefined later", () => {
    expect(() => new ScriptedIdGenerator([])).toThrow();
  });
});
