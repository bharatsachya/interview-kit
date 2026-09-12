import { describe, expect, it } from "vitest";
import type { SessionKitView, SessionSummary, SessionTurnView } from "../src/lib/api/types";
import { kitCount, kitRowLabel, kitsOf, sessionLabel, sessionOfKit, settledLine } from "../src/lib/history";

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

const turn = (over: Partial<SessionTurnView> = {}): SessionTurnView => ({
  job_id: "job_1",
  ask: { kind: "posting", jd: "Senior Backend Engineer", companyUrl: "https://acme.test", days: 5 },
  label: "Senior Backend Engineer",
  status: "done",
  kit_id: "kit_1",
  error: null,
  progress: null,
  created_at: 0,
  ...over,
});

/**
 * What a turn that finished before this page was open says it did.
 *
 * The bug this is written against: five regenerations run on one kit before asks were stored
 * rendered as **five more kits built**. Those job records carry `request: null`, so `ask` is
 * null, and the first version answered "cannot tell" with "Built your kit" — the one claim it
 * had no evidence for. One posting and five rewrites came out as six identical lines.
 */
describe("settledLine", () => {
  it("reports a build only when the ask says a posting was sent", () => {
    expect(settledLine(turn(), 6)).toBe("Built your kit — 6 outputs.");
  });

  it("does not claim a build for a turn whose ask was never stored", () => {
    const legacy = turn({ ask: null, label: "Regenerating the company brief" });
    expect(settledLine(legacy, 6)).not.toContain("Built your kit");
    // The label is what the server recorded when it accepted the run. Repeating it back is
    // honest where guessing was not.
    expect(settledLine(legacy, 6)).toBe("Regenerating the company brief.");
  });

  it("says something rather than nothing when there is no ask and no label either", () => {
    expect(settledLine(turn({ ask: null, label: "" }), 6)).toBe("This run finished.");
  });

  it("names the section a rewrite replaced, not the kit", () => {
    const rewrite = turn({ ask: { kind: "rewrite", section: "questions", category: "technical", prompt: "Harder." } });
    expect(settledLine(rewrite, 6)).toBe("Rewrote the technical questions, into a new kit.");
    const brief = turn({ ask: { kind: "rewrite", section: "company_brief", prompt: "More detail." } });
    expect(settledLine(brief, 6)).toBe("Rewrote the brief, into a new kit.");
  });

  it("gives a failure its reason rather than a build it never did", () => {
    const failed = turn({ status: "failed", kit_id: null, error: { code: "TIMEOUT", message: "The run timed out." } });
    expect(settledLine(failed, 6)).toBe("The run timed out.");
  });
});
