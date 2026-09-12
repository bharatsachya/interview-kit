import { describe, expect, it } from "vitest";
import type { JobRecord, KitRecord } from "@trao/contracts";
import type { InternalKit } from "@trao/kit";
import { askOf, buildSessions } from "../src/sessions";

const job = (over: Partial<JobRecord> = {}): JobRecord => ({
  id: "job_1",
  userId: "alice",
  sessionId: "sess_1",
  kitId: "kit_1",
  label: "Senior Backend Engineer",
  status: "done",
  progress: null,
  error: null,
  request: { kind: "posting", jd: "Senior Backend Engineer\nVaultline", companyUrl: "https://vaultline.test", days: 5 },
  createdAt: 100,
  updatedAt: 100,
  ...over,
});

const kit = (over: Partial<KitRecord<InternalKit>> = {}, inner: Partial<InternalKit> = {}): KitRecord<InternalKit> => ({
  id: "kit_1",
  userId: "alice",
  sessionId: "sess_1",
  hash: "h1",
  createdAt: 100,
  updatedAt: 100,
  kit: {
    id: "kit_1",
    createdAt: 100,
    version: 1,
    role: { title: "Senior Backend Engineer", company: "Vaultline", location: "", summary: "", responsibilities: [] },
    companyBrief: { summary: "", whatTheyDo: "", hiringProcess: "", sources: [], pagesUsed: [], gaps: [], origin: "generated", edited: false },
    requirements: [],
    questions: [],
    flashcards: [],
    schedule: { daysAvailable: 5, days: [] },
    coverage: { passes: 1, uncoveredRequirementIds: [] },
    ...inner,
  } as InternalKit,
  ...over,
});

/**
 * Sessions are a grouping, not a collection.
 *
 * Which means the only thing that can be wrong is the grouping, and these are the cases where a
 * naive `GROUP BY` gets it wrong: records that predate the field, a fork that must land in its
 * parent's conversation rather than its own, and ordering that has to run in opposite directions
 * for the transcript and for the rail.
 */
describe("buildSessions", () => {
  it("puts a posting and the kit it produced in one conversation", () => {
    const sessions = buildSessions([job()], [kit()]);

    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.id).toBe("sess_1");
    expect(sessions[0]?.turns.map((t) => t.jobId)).toEqual(["job_1"]);
    expect(sessions[0]?.kits.map((k) => k.id)).toEqual(["kit_1"]);
  });

  it("collapses a kit and its rewrites into one row rather than three", () => {
    const sessions = buildSessions(
      [job(), job({ id: "job_2", kitId: "kit_2", createdAt: 200, updatedAt: 200 })],
      [
        kit(),
        kit(
          { id: "kit_2", createdAt: 200, updatedAt: 200 },
          { id: "kit_2", revision: 2, forkedFrom: { fromKitId: "kit_1", section: "questions", category: "technical", at: 200 } },
        ),
      ],
    );

    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.kits.map((k) => `v${k.revision}`)).toEqual(["v2", "v1"]);
    // The nested row says what the rewrite did, not the role title it shares with every revision.
    expect(sessions[0]?.kits[0]?.changed).toBe("Rewrote the technical questions");
    expect(sessions[0]?.kits[1]?.changed).toBeUndefined();
  });

  it("reads the transcript downwards and the kit list newest first", () => {
    const sessions = buildSessions(
      [job({ id: "job_2", createdAt: 200, updatedAt: 200, kitId: "kit_2" }), job()],
      [kit({ id: "kit_2", createdAt: 200, updatedAt: 200 }), kit()],
    );

    // Turns oldest first — the one that opened the conversation is the one that names it.
    expect(sessions[0]?.turns.map((t) => t.createdAt)).toEqual([100, 200]);
    // Kits newest first — the rail's first nested row is what opening the session shows.
    expect(sessions[0]?.kits.map((k) => k.createdAt)).toEqual([200, 100]);
  });

  it("sorts conversations by their newest activity, not by when they started", () => {
    const sessions = buildSessions(
      [
        job({ id: "job_old", sessionId: "sess_old", kitId: "kit_old", createdAt: 1, updatedAt: 1 }),
        job({ id: "job_new", sessionId: "sess_new", kitId: "kit_new", createdAt: 2, updatedAt: 2 }),
        // A rewrite of the OLD session, sent just now.
        job({ id: "job_rw", sessionId: "sess_old", kitId: "kit_rw", createdAt: 900, updatedAt: 900 }),
      ],
      [],
    );

    expect(sessions.map((s) => s.id)).toEqual(["sess_old", "sess_new"]);
  });

  it("names a conversation after the kit, so it stays right as the session grows", () => {
    expect(buildSessions([job()], [kit()])[0]?.title).toBe("Vaultline — Senior Backend Engineer");
  });

  it("never names a conversation after a field that came back blank", () => {
    // A posting that does not name the employer. The rail used to render this straight into its
    // loudest line, so the one kit that had worked showed a blank title and read as disabled
    // next to the bold failed runs above it.
    const noCompany = kit({}, { role: { title: "AI/ML Developer", company: "", location: "", summary: "", responsibilities: [] } });
    expect(buildSessions([job()], [noCompany])[0]?.title).toBe("AI/ML Developer");

    const neither = kit({}, { role: { title: "", company: "", location: "", summary: "", responsibilities: [] } });
    expect(buildSessions([job({ request: null })], [neither])[0]?.title).toBe("Untitled session");
  });

  it("falls back to the posting's first line when no kit was ever produced", () => {
    const failed = job({ kitId: null, status: "failed", error: { code: "TIMEOUT", message: "timed out" } });
    expect(buildSessions([failed], [])[0]?.title).toBe("Senior Backend Engineer");
  });

  it("is running while any turn is, and not once they have all settled", () => {
    expect(buildSessions([job({ status: "running" })], [])[0]?.running).toBe(true);
    expect(buildSessions([job({ status: "queued" })], [])[0]?.running).toBe(true);
    expect(buildSessions([job()], [])[0]?.running).toBe(false);
    expect(buildSessions([job({ status: "failed" })], [])[0]?.running).toBe(false);
  });

  describe("records written before sessions existed", () => {
    it("groups a legacy kit with the legacy run that produced it", () => {
      const sessions = buildSessions([job({ sessionId: null })], [kit({ sessionId: null })]);

      // One conversation, not two — the synthetic id is derived from the kit both sides name.
      expect(sessions).toHaveLength(1);
      expect(sessions[0]?.id).toBe("kit:kit_1");
      expect(sessions[0]?.turns).toHaveLength(1);
      expect(sessions[0]?.kits).toHaveLength(1);
    });

    it("gives a legacy failed run, which has no kit, a conversation of its own", () => {
      const sessions = buildSessions([job({ sessionId: null, kitId: null, status: "failed" })], []);
      expect(sessions[0]?.id).toBe("job:job_1");
    });

    it("keeps a synthetic id out of the way of a minted one", () => {
      const sessions = buildSessions([job({ sessionId: null }), job({ id: "job_2" })], []);
      expect(sessions.map((s) => s.id).sort()).toEqual(["kit:kit_1", "sess_1"]);
    });
  });
});

describe("askOf", () => {
  it("reads a posting stored before the field was discriminated", () => {
    // No `kind` — what every job record written before sessions holds.
    const legacy = { jd: "Senior Backend Engineer", companyUrl: "https://vaultline.test", days: 5 };
    expect(askOf(legacy as never)).toEqual({
      kind: "posting",
      jd: "Senior Backend Engineer",
      companyUrl: "https://vaultline.test",
      days: 5,
    });
  });

  it("passes a discriminated ask through untouched", () => {
    const rewrite = { kind: "rewrite" as const, section: "questions", category: "technical", prompt: "Harder." };
    expect(askOf(rewrite)).toEqual(rewrite);
  });

  it("is null for a run that stored nothing, however it stored it", () => {
    expect(askOf(null)).toBeNull();
    expect(askOf(undefined as never)).toBeNull();
    expect(askOf({} as never)).toBeNull();
  });
});
