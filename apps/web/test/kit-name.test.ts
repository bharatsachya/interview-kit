import { describe, expect, it } from "vitest";
import type { KitSummary } from "../src/lib/api/types";
import { kitName } from "../src/components/workspace/history-sidebar";

const kit = (over: Partial<KitSummary> = {}): KitSummary => ({
  id: "kit_1",
  title: "AI/ML Developer",
  company: "Vaultline",
  days: 5,
  createdAt: 0,
  revision: 1,
  ...over,
});

/**
 * A history row's identity line is never empty.
 *
 * The row that broke was a real kit whose company extraction came back blank: the 15px semibold
 * line rendered nothing, and what was left read as disabled next to the bold failed runs above
 * it. The run rows had guarded this from the start; these had not.
 */
describe("kitName", () => {
  it("uses the company, with the role under it", () => {
    expect(kitName(kit())).toEqual({ primary: "Vaultline", secondary: "AI/ML Developer" });
  });

  it("falls back to the role when no company was extracted", () => {
    expect(kitName(kit({ company: "" }))).toEqual({ primary: "AI/ML Developer", secondary: null });
    expect(kitName(kit({ company: "   " }))).toEqual({ primary: "AI/ML Developer", secondary: null });
  });

  it("never repeats the same words on both lines", () => {
    const name = kitName(kit({ company: "" }));
    expect(name.secondary).not.toBe(name.primary);
  });

  it("says something rather than nothing when both fields are blank", () => {
    expect(kitName(kit({ company: "", title: "" }))).toEqual({ primary: "Untitled kit", secondary: null });
  });

  it("gives a fork's second line to what the rewrite did", () => {
    const fork = kit({ revision: 2, forkedFrom: { fromKitId: "kit_1", section: "questions", category: "technical", at: 0 } });
    expect(kitName(fork)).toEqual({ primary: "Vaultline", secondary: "Rewrote the technical questions" });
  });
});
