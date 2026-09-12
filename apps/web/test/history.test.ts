import { describe, expect, it } from "vitest";
import type { SessionKitView, SessionSummary } from "../src/lib/api/types";
import { kitCount, kitRowLabel, kitsOf, sessionLabel, sessionOfKit } from "../src/lib/history";

const kit = (id: string, over: Partial<SessionKitView> = {}): SessionKitView => ({
  id,
  title: "Senior Backend Engineer",
  company: "Acme",
  days: 5,
  created_at: 100,
  revision: 1,
  ...over,
});

const session = (id: string, over: Partial<SessionSummary> = {}): SessionSummary => ({
  id,
  title: "Acme — Senior Backend Engineer",
  created_at: 100,
  updated_at: 100,
  kits: [kit("kit_1")],
  running: false,
  status: "done",
  ...over,
});

/**
 * The rail lists conversations.
 *
 * It listed kits, then kits merged with runs, and forking made that worse: one piece of work can
 * hold four kits alike in every field a row shows. The grouping moved to the API; what is left
 * here is what the rail says about a group it is handed.
 */
describe("kitCount", () => {
  it("counts kits across conversations, not conversations", () => {
    expect(kitCount([session("s1", { kits: [kit("k1"), kit("k2")] }), session("s2")])).toBe(3);
  });

  it("does not count a conversation whose only run failed", () => {
    // The compare control appears at two kits. A failure making it appear at one would offer a
    // comparison with nothing on the other side.
    expect(kitCount([session("s1"), session("s2", { kits: [], status: "failed" })])).toBe(1);
  });
});

describe("kitsOf", () => {
  it("flattens every kit, newest first, whichever conversation it came from", () => {
    const sessions = [
      session("s1", { kits: [kit("k2", { created_at: 300 }), kit("k1", { created_at: 100 })] }),
      session("s2", { kits: [kit("k3", { created_at: 200 })] }),
    ];
    expect(kitsOf(sessions).map((k) => k.id)).toEqual(["k2", "k3", "k1"]);
  });

  it("keeps the conversation each kit came from, so compare can open it", () => {
    expect(kitsOf([session("s1")])[0]?.sessionId).toBe("s1");
  });
});

describe("sessionOfKit", () => {
  it("finds the conversation holding a kit, for a link written before sessions existed", () => {
    const sessions = [session("s1", { kits: [kit("k1")] }), session("s2", { kits: [kit("k2")] })];
    expect(sessionOfKit(sessions, "k2")).toBe("s2");
    expect(sessionOfKit(sessions, "gone")).toBeNull();
  });
});

describe("sessionLabel", () => {
  it("offers the count of what expanding would show", () => {
    expect(sessionLabel(session("s1"))).toBe("1 kit");
    expect(sessionLabel(session("s1", { kits: [kit("a"), kit("b")] }))).toBe("2 kits");
  });

  it("says what happened when there is no kit to count", () => {
    expect(sessionLabel(session("s1", { kits: [], status: "failed" }))).toBe("Failed");
    expect(sessionLabel(session("s1", { kits: [], status: "queued" }))).toBe("Queued");
  });

  it("says running while anything in it is, whatever the newest turn's status says", () => {
    // A conversation with two finished kits and a rewrite in flight is running, and the row has
    // to say so — it is the one state where the rail is telling you to wait.
    expect(sessionLabel(session("s1", { running: true, status: "done" }))).toBe("Running");
  });
});

describe("kitRowLabel", () => {
  it("says what the rewrite did, not the role title every revision shares", () => {
    expect(kitRowLabel(kit("k2", { changed: "Rewrote the brief" }))).toBe("Rewrote the brief");
  });

  it("names an original by its role, because a batch holds several of them", () => {
    // "Built from the posting" is true of every kit a batch produced, so six rows would all say
    // the same sentence under a session titled after the first of them.
    expect(kitRowLabel(kit("k1"))).toBe("Acme — Senior Backend Engineer");
  });

  it("falls back only when there is genuinely nothing to say", () => {
    expect(kitRowLabel(kit("k1", { company: "", title: "" }))).toBe("Built from the posting");
    expect(kitRowLabel(kit("k1", { company: "" }))).toBe("Senior Backend Engineer");
  });
});
