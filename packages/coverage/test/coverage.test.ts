import { describe, expect, it, vi } from "vitest";
import type { IdGenerator } from "@trao/contracts";
import type { InternalQuestion, Requirement } from "@trao/kit";
import { clusterRequirements, MAX_CLUSTER_SIZE } from "../src/cluster";
import { detectGaps } from "../src/detect";
import { FALLBACK_TEMPLATES, fallbackQuestion } from "../src/fallback";
import {
  MAX_REQUIREMENT_IDS_PER_QUESTION,
  acceptGapFill,
  coversRequirement,
  gateQuestionTags,
} from "../src/gates";
import { allTokens } from "../src/text";
import { runCoverage, type GapFillDraft, type GapFillWriter } from "../src/run";

function ids(): IdGenerator {
  let n = 0;
  return { next: (prefix) => `${prefix}${(n += 1)}` };
}

function requirement(id: string, overrides: Partial<Requirement> = {}): Requirement {
  return { id, text: `Requirement ${id}`, kind: "technical", priority: "must", ...overrides };
}

function question(overrides: Partial<InternalQuestion> = {}): InternalQuestion {
  return {
    id: "q0",
    category: "technical",
    prompt: "Tell me about something.",
    answerOutline: "",
    difficulty: 2,
    requirementIds: [],
    origin: "generated",
    pinned: false,
    active: true,
    order: 0,
    ...overrides,
  };
}

function writerReturning(draft: Partial<GapFillDraft>): GapFillWriter {
  const write: GapFillWriter = async (request) => ({
    prompt: `Tell me about ${request.requirements.map((r) => r.text).join(" and ")} in practice.`,
    answerOutline: "Outline.",
    difficulty: 2,
    ...draft,
  });
  return vi.fn(write);
}

/** Mandatory test area: coverage checking. */
describe("detectGaps", () => {
  it("returns exactly the must-haves nothing asks about", () => {
    const requirements = Array.from({ length: 7 }, (_, i) => requirement(`r${i + 1}`));
    const questions = [
      question({ id: "q1", requirementIds: ["r1", "r2"] }),
      question({ id: "q2", requirementIds: ["r3"] }),
      question({ id: "q3", requirementIds: ["r5", "r7"] }),
    ];

    expect(detectGaps(requirements, questions).uncoveredMustIds).toEqual(["r4", "r6"]);
  });

  it("reports nice-to-haves separately, so they never block", () => {
    const requirements = [
      requirement("r1", { priority: "must" }),
      requirement("r2", { priority: "nice" }),
      requirement("r3", { priority: "nice" }),
    ];
    const gaps = detectGaps(requirements, [question({ requirementIds: ["r1"] })]);

    expect(gaps.uncoveredMustIds).toEqual([]);
    expect(gaps.uncoveredNiceIds).toEqual(["r2", "r3"]);
  });

  it("does not count an archived question as covering anything", () => {
    const gaps = detectGaps([requirement("r1")], [question({ requirementIds: ["r1"], active: false })]);
    expect(gaps.uncoveredMustIds).toEqual(["r1"]);
  });
});

describe("acceptance gates", () => {
  const cluster = [requirement("r1", { text: "Kubernetes and container orchestration" })];
  const existing = [question({ prompt: "How would you debug a failing Kubernetes rollout?" })];

  it("accepts a valid question", () => {
    const result = acceptGapFill({
      prompt: "Walk me through how you would size a Kubernetes cluster for a bursty workload.",
      cluster,
      existingQuestions: existing,
    });

    expect(result).toEqual({ accepted: true });
  });

  it("rejects a hallucinated requirement id", () => {
    const result = acceptGapFill({
      prompt: "Walk me through sizing a Kubernetes cluster for a bursty workload.",
      claimedRequirementIds: ["r1", "r99"],
      cluster,
      existingQuestions: [],
    });

    expect(result).toEqual({ accepted: false, reason: "unsolicited_requirement_id" });
  });

  it("rejects a near-duplicate of a question we already have", () => {
    const result = acceptGapFill({
      prompt: "How would you debug a Kubernetes rollout that is failing?",
      cluster,
      existingQuestions: existing,
    });

    expect(result).toEqual({ accepted: false, reason: "duplicate" });
  });

  it("rejects a question with no overlap with the requirement", () => {
    const result = acceptGapFill({
      prompt: "Describe a time you resolved a disagreement with a colleague.",
      cluster,
      existingQuestions: [],
    });

    expect(result).toEqual({ accepted: false, reason: "no_overlap" });
  });

  it.each(["", "   ", "\n"])("rejects empty output %j", (prompt) => {
    expect(acceptGapFill({ prompt, cluster, existingQuestions: [] })).toEqual({
      accepted: false,
      reason: "empty",
    });
  });

  it("rejects a stub", () => {
    expect(acceptGapFill({ prompt: "Kubernetes?", cluster, existingQuestions: [] })).toEqual({
      accepted: false,
      reason: "stub",
    });
  });

  it("ignores an archived question when checking for duplicates", () => {
    const result = acceptGapFill({
      prompt: "How would you debug a failing Kubernetes rollout?",
      cluster,
      existingQuestions: [question({ prompt: "How would you debug a failing Kubernetes rollout?", active: false })],
    });

    expect(result.accepted).toBe(true);
  });
});

describe("clusterRequirements", () => {
  it("never groups more than three", () => {
    const requirements = Array.from({ length: 9 }, (_, i) =>
      requirement(`r${i + 1}`, { text: `Python service ${i + 1}` }),
    );

    for (const cluster of clusterRequirements(requirements)) {
      expect(cluster.length).toBeLessThanOrEqual(MAX_CLUSTER_SIZE);
    }
  });

  it("never groups across kind, however much vocabulary they share", () => {
    const requirements = [
      requirement("r1", { text: "Mentoring Python engineers", kind: "behavioural" }),
      requirement("r2", { text: "Mentoring Python juniors", kind: "technical" }),
      requirement("r3", { text: "Mentoring Python teams", kind: "domain" }),
    ];

    for (const cluster of clusterRequirements(requirements)) {
      expect(new Set(cluster.map((r) => r.kind)).size).toBe(1);
    }
  });

  it("groups requirements that share vocabulary", () => {
    const requirements = [
      requirement("r1", { text: "Kubernetes cluster operations" }),
      requirement("r2", { text: "Kubernetes networking" }),
      requirement("r3", { text: "Written communication", kind: "behavioural" }),
    ];

    const clusters = clusterRequirements(requirements);
    const together = clusters.find((c) => c.some((r) => r.id === "r1"));

    expect(together?.map((r) => r.id).sort()).toEqual(["r1", "r2"]);
  });

  it("gives an orphan its own question rather than sweeping it into an unrelated bundle", () => {
    const requirements = [
      requirement("r1", { text: "Kubernetes cluster operations" }),
      requirement("r2", { text: "Kubernetes networking" }),
      requirement("r3", { text: "PostgreSQL replication" }),
    ];

    const orphan = clusterRequirements(requirements).find((c) => c.some((r) => r.id === "r3"));
    expect(orphan?.map((r) => r.id)).toEqual(["r3"]);
  });

  it("covers every requirement exactly once", () => {
    const requirements = [
      requirement("r1", { text: "Kubernetes operations" }),
      requirement("r2", { text: "Kubernetes networking" }),
      requirement("r3", { text: "Mentoring juniors", kind: "behavioural" }),
      requirement("r4", { text: "Payments", kind: "domain" }),
    ];

    const flattened = clusterRequirements(requirements).flat().map((r) => r.id);
    expect(flattened.sort()).toEqual(["r1", "r2", "r3", "r4"]);
  });
});

describe("deterministic fallback", () => {
  it("invents no content — every token comes from the requirement, the title or the template", () => {
    const cases: Requirement[] = [
      requirement("r1", { text: "Five years of React", kind: "technical" }),
      requirement("r2", { text: "Mentoring junior engineers", kind: "behavioural" }),
      requirement("r3", { text: "Payments and card processing", kind: "domain" }),
    ];
    const roleTitle = "Senior Frontend Engineer";

    for (const req of cases) {
      const draft = fallbackQuestion(req, roleTitle);
      const boilerplate = new Set(allTokens(FALLBACK_TEMPLATES[req.kind]("")));
      const permitted = new Set([...allTokens(req.text), ...allTokens(roleTitle), ...boilerplate]);

      for (const token of allTokens(draft.prompt)) {
        expect(permitted, `fallback invented the word "${token}"`).toContain(token);
      }
    }
  });

  it("never infers from the tech stack", () => {
    // "React means they'll ask about hooks" is our assumption, not the posting's.
    const draft = fallbackQuestion(requirement("r1", { text: "Five years of React" }), "Frontend Engineer");
    expect(draft.prompt.toLowerCase()).not.toContain("hook");
    expect(draft.prompt.toLowerCase()).not.toContain("jsx");
  });

  it("falls back to the role title when the requirement is too thin to slot in", () => {
    const draft = fallbackQuestion(requirement("r1", { text: "Go" }), "Senior Backend Engineer");
    expect(draft.prompt).toContain("Senior Backend Engineer");
  });

  it("leaves the answer outline empty rather than guessing one", () => {
    expect(fallbackQuestion(requirement("r1"), "Engineer").answerOutline).toBe("");
  });

  it("routes each kind to a sensible category", () => {
    expect(fallbackQuestion(requirement("r1", { kind: "technical" }), "E").category).toBe("technical");
    expect(fallbackQuestion(requirement("r2", { kind: "behavioural" }), "E").category).toBe("behavioural");
    expect(fallbackQuestion(requirement("r3", { kind: "domain" }), "E").category).toBe("company-fit");
  });
});

describe("runCoverage", () => {
  const base = {
    roleTitle: "Senior Backend Engineer",
    ids: ids(),
    questions: [] as InternalQuestion[],
  };

  it("stops immediately when a pass closes zero gaps", async () => {
    const writer = vi.fn(async () => null);
    const result = await runCoverage({
      ...base,
      ids: ids(),
      requirements: [requirement("r1", { text: "Kubernetes operations" })],
      writer,
    });

    // Pass 1 is the initial check, pass 2 is the re-check after the failed fill. No pass 3.
    expect(result.passes).toBe(2);
    expect(writer).toHaveBeenCalledTimes(1);
  });

  it("caps at two extra passes even when gaps remain", async () => {
    // A writer that always returns something acceptable but never covers everything.
    const requirements = [
      requirement("r1", { text: "Kubernetes operations" }),
      requirement("r2", { text: "PostgreSQL replication" }),
      requirement("r3", { text: "Kafka streaming" }),
      requirement("r4", { text: "Terraform modules" }),
    ];

    let call = 0;
    const writer: GapFillWriter = async (request) => {
      call += 1;
      // Only ever succeeds for the first cluster of each pass.
      if (call % 4 !== 1) return null;
      return {
        prompt: `Walk me through ${request.requirements[0]?.text} on a system you ran.`,
        answerOutline: "Outline.",
        difficulty: 2,
      };
    };

    const result = await runCoverage({ ...base, ids: ids(), requirements, writer });

    expect(result.passes).toBe(3); // 1 initial + 2 extra
    expect(result.reports).toHaveLength(3);
  });

  it("tracks attempts per requirement so one stubborn requirement cannot eat the budget", async () => {
    // The zero-gaps-closed guard cannot help here: the other requirements keep succeeding, so
    // the loop stays alive and r1 would otherwise be retried on every remaining pass.
    const requirements = [
      requirement("r1", { text: "Kubernetes operations" }), // the writer never manages this one
      requirement("r2", { text: "PostgreSQL replication" }),
      requirement("r3", { text: "Kafka streaming" }),
    ];

    const attemptedIds: string[] = [];
    const write: GapFillWriter = async (request) => {
      const target = request.requirements[0] as Requirement;
      attemptedIds.push(target.id);
      if (target.id === "r1") return { prompt: "no", answerOutline: "", difficulty: 2 };
      return {
        prompt: `Walk me through ${target.text} on a system you ran in production.`,
        answerOutline: "Outline.",
        difficulty: 2,
      };
    };
    const writer = vi.fn(write);

    const result = await runCoverage({
      ...base,
      ids: ids(),
      requirements,
      writer,
      maxExtraPasses: 5,
      maxAttemptsPerRequirement: 1,
    });

    // Attempted once and then left alone, even though four more passes were available.
    expect(attemptedIds.filter((id) => id === "r1")).toEqual(["r1"]);
    expect(result.fallbackCount).toBe(1);
    expect(result.questions.at(-1)?.origin).toBe("fallback");
  });

  it("keeps retrying a stubborn requirement up to the cap while other passes succeed", async () => {
    const requirements = [
      requirement("r1", { text: "Kubernetes operations" }),
      requirement("r2", { text: "PostgreSQL replication" }),
      requirement("r3", { text: "Kafka streaming" }),
    ];

    const attemptedIds: string[] = [];
    const writer: GapFillWriter = async (request) => {
      const target = request.requirements[0] as Requirement;
      attemptedIds.push(target.id);
      if (target.id === "r1") return null;
      return {
        prompt: `Walk me through ${target.text} on a system you ran in production.`,
        answerOutline: "Outline.",
        difficulty: 2,
      };
    };

    await runCoverage({ ...base, ids: ids(), requirements, writer, maxExtraPasses: 5, maxAttemptsPerRequirement: 2 });

    expect(attemptedIds.filter((id) => id === "r1")).toEqual(["r1", "r1"]);
  });

  it("attaches the requirement ids itself, ignoring whatever the writer claims", async () => {
    const requirements = [requirement("r1", { text: "Kubernetes cluster operations" })];
    const writer: GapFillWriter = async () => ({
      prompt: "How do you run a Kubernetes cluster in production?",
      answerOutline: "Outline.",
      difficulty: 2,
    });

    const result = await runCoverage({ ...base, ids: ids(), requirements, writer });
    const added = result.questions.at(-1);

    expect(added?.requirementIds).toEqual(["r1"]);
    expect(result.uncoveredRequirementIds).toEqual([]);
    expect(result.fallbackCount).toBe(0);
  });

  it("rejects a draft that volunteers a requirement id we did not supply", async () => {
    const requirements = [
      requirement("r1", { text: "Kubernetes cluster operations" }),
      requirement("r2", { text: "PostgreSQL replication" }),
    ];
    const writer: GapFillWriter = async () => ({
      prompt: "How do you run a Kubernetes cluster and PostgreSQL replication together?",
      answerOutline: "Outline.",
      difficulty: 2,
      requirementIds: ["r1", "r2", "r99"],
    });

    const result = await runCoverage({ ...base, ids: ids(), requirements, writer, maxExtraPasses: 1 });

    expect(result.reports[1]?.attempts.every((a) => a.reason === "unsolicited_requirement_id")).toBe(true);
    expect(result.fallbackCount).toBe(2);
  });

  it("falls back for every must-have still uncovered, and marks it fallback", async () => {
    const requirements = [requirement("r1", { text: "Five years of Python" })];
    const result = await runCoverage({ ...base, ids: ids(), requirements, writer: async () => null });

    const added = result.questions.at(-1);
    expect(added?.origin).toBe("fallback");
    expect(added?.requirementIds).toEqual(["r1"]);
    expect(result.uncoveredRequirementIds).toEqual([]);
  });

  it("leaves nice-to-haves in uncoveredRequirementIds without filling them", async () => {
    const requirements = [
      requirement("r1", { text: "Five years of Python", priority: "must" }),
      requirement("r2", { text: "Rust experience", priority: "nice" }),
    ];
    const result = await runCoverage({ ...base, ids: ids(), requirements, writer: async () => null });

    expect(result.uncoveredRequirementIds).toEqual(["r2"]);
    expect(result.fallbackCount).toBe(1);
  });

  it("produces zero fallbacks on a rich set the writer handles well", async () => {
    // If fallbacks appear on a normal description, extraction or generation is broken, and this
    // is the test that finds out.
    const requirements = [
      requirement("r1", { text: "Kubernetes cluster operations" }),
      requirement("r2", { text: "PostgreSQL replication" }),
      requirement("r3", { text: "Mentoring junior engineers", kind: "behavioural" }),
    ];
    const questions = [
      question({ id: "q1", prompt: "How do you size a Kubernetes cluster?", requirementIds: ["r1"] }),
      question({ id: "q2", prompt: "Explain PostgreSQL replication trade-offs.", requirementIds: ["r2"] }),
      question({ id: "q3", prompt: "Tell me about mentoring a junior engineer.", requirementIds: ["r3"] }),
    ];

    const writer = vi.fn(async () => null);
    const result = await runCoverage({ ...base, ids: ids(), requirements, questions, writer });

    expect(result.fallbackCount).toBe(0);
    expect(result.passes).toBe(1);
    expect(writer).not.toHaveBeenCalled();
  });

  it("survives a writer that throws", async () => {
    const result = await runCoverage({
      ...base,
      ids: ids(),
      requirements: [requirement("r1", { text: "Five years of Python" })],
      writer: async () => {
        throw new Error("provider exploded");
      },
    });

    expect(result.fallbackCount).toBe(1);
    expect(result.reports[1]?.attempts[0]?.reason).toBe("writer_returned_nothing");
  });

  it("reports each pass honestly, for the trace", async () => {
    const requirements = [requirement("r1", { text: "Kubernetes cluster operations" })];
    const writer: GapFillWriter = async () => ({
      prompt: "How do you run a Kubernetes cluster in production?",
      answerOutline: "Outline.",
      difficulty: 2,
    });

    const result = await runCoverage({ ...base, ids: ids(), requirements, writer });

    expect(result.reports[0]).toMatchObject({ pass: 1, mustCount: 1, coveredCount: 0, gapIds: ["r1"] });
    expect(result.reports[1]).toMatchObject({ pass: 2, mustCount: 1, coveredCount: 1, gapIds: [] });
    expect(result.reports[1]?.attempts[0]).toMatchObject({ requirementIds: ["r1"], accepted: true });
  });

  it("never touches the caller's question array", async () => {
    const questions = [question({ id: "q1", requirementIds: [] })];
    await runCoverage({
      ...base,
      ids: ids(),
      requirements: [requirement("r1")],
      questions,
      writer: async () => null,
    });

    expect(questions).toHaveLength(1);
  });

  it("asks the writer for one cluster at a time, never for a batch of everything", async () => {
    const requirements = [
      requirement("r1", { text: "Kubernetes operations" }),
      requirement("r2", { text: "PostgreSQL replication" }),
      requirement("r3", { text: "Kafka streaming" }),
    ];
    const writer = writerReturning({});

    await runCoverage({ ...base, ids: ids(), requirements, writer, maxExtraPasses: 1 });

    expect(writer).toHaveBeenCalledTimes(3);
    for (const call of (writer as ReturnType<typeof vi.fn>).mock.calls) {
      expect((call[0] as { requirements: Requirement[] }).requirements.length).toBeLessThanOrEqual(MAX_CLUSTER_SIZE);
    }
  });
});

/**
 * Gating every question's tags, not just gap-fill answers.
 *
 * Both scenarios below are transcribed from one live run against a real posting.
 */
describe("tag gating on every question", () => {
  const base = { roleTitle: "Software Engineer", questions: [] as InternalQuestion[] };
  const CONNECTED_SERVICES =
    "Connected services — the surfaces that let users plug Gmail, Drive, Slack, and the rest of their stack into Magica.";

  const integration = (id: string, text: string): Requirement => ({
    id,
    text,
    kind: "technical",
    priority: "must",
    sourceSpan: CONNECTED_SERVICES,
  });

  const byId = (...rs: Requirement[]) => new Map(rs.map((r) => [r.id, r]));

  it("trims a question tagged with five ids down to three", () => {
    const requirements = [
      integration("r6", "Connected services"),
      integration("r7", "Gmail"),
      integration("r8", "Drive"),
      integration("r9", "Slack"),
      requirement("r13", { text: "A portfolio of real things you've shipped" }),
    ];

    const verdict = gateQuestionTags(
      {
        prompt:
          "Walk me through building the connected services surfaces that let users plug Gmail, Drive and Slack into the product.",
        requirementIds: ["r6", "r7", "r8", "r9", "r13"],
      },
      byId(...requirements),
    );

    expect(verdict.kept.length).toBeLessThanOrEqual(MAX_REQUIREMENT_IDS_PER_QUESTION);
    // r13 is not in the question at all, so it is dropped before the cap is even reached.
    expect(verdict.kept).not.toContain("r13");
    expect(verdict.dropped.map((d) => d.id)).toContain("r13");
  });

  it("does not let a question cover a requirement it merely name-drops", () => {
    // The live failure: one question mentioned Gmail and Slack in passing and coverage marked
    // both closed.
    const requirements = [integration("r7", "Gmail"), integration("r9", "Slack")];

    const verdict = gateQuestionTags(
      {
        prompt: "How do you decide what to build first when everything is urgent?",
        answerOutline: "Mentions triage. Notes that Gmail and Slack were deprioritised.",
        requirementIds: ["r7", "r9"],
      },
      byId(...requirements),
    );

    expect(verdict.kept).toEqual([]);
    expect(verdict.dropped.every((d) => d.reason === "name_drop" || d.reason === "no_overlap")).toBe(true);
  });

  it('rejects the "maintain your drive" answer offered as coverage for Drive', () => {
    const drive = integration("r8", "Drive");

    const motivation = coversRequirement(drive, "How do you maintain your drive on a long project with no clear finish line?");
    expect(motivation.covers).toBe(false);
    expect(motivation.reason).toBe("name_drop");

    // The genuine question is still accepted — the span disambiguates rather than raising the bar.
    const genuine = coversRequirement(drive, "How would you design the OAuth flow for connecting a user's Drive and Slack accounts?");
    expect(genuine.covers).toBe(true);
  });

  it("rejects the same thing through the gap-fill gate", () => {
    const result = acceptGapFill({
      prompt: "How do you maintain your drive on a long project with no clear finish line?",
      cluster: [integration("r8", "Drive")],
      existingQuestions: [],
    });

    expect(result).toEqual({ accepted: false, reason: "name_drop" });
  });

  it("leaves a multi-word requirement alone — the span only disambiguates short ones", () => {
    const verdict = coversRequirement(
      requirement("r1", { text: "Experience operating PostgreSQL at scale, including replication" }),
      "Explain how you would set up PostgreSQL replication for a read-heavy workload at scale.",
    );

    expect(verdict.covers).toBe(true);
  });

  it("reports the correct gaps at pass 1, after gating", async () => {
    const requirements = [integration("r7", "Gmail"), integration("r8", "Drive"), integration("r9", "Slack")];

    // One over-tagged question claiming all three, genuinely covering none.
    const questions = [
      question({
        id: "q2",
        prompt: "How do you decide what to build first when everything is urgent?",
        requirementIds: ["r7", "r8", "r9"],
      }),
    ];

    const result = await runCoverage({
      ...base,
      ids: ids(),
      requirements,
      questions,
      writer: async () => null,
      maxExtraPasses: 0,
    });

    // Without gating this would have read musts=3 covered=3 gaps=[].
    expect(result.reports[0]).toMatchObject({ mustCount: 3, coveredCount: 0, gapIds: ["r7", "r8", "r9"] });
    expect(result.retagged[0]?.questionId).toBe("q2");
    expect(result.retagged[0]?.kept).toEqual([]);
  });

  it("puts a requirement back into the gap list when it loses its last question", async () => {
    const requirements = [integration("r8", "Drive")];
    const questions = [
      question({ id: "q1", prompt: "How do you maintain your drive under pressure?", requirementIds: ["r8"] }),
    ];

    const result = await runCoverage({ ...base, ids: ids(), requirements, questions, writer: async () => null });

    expect(result.reports[0]?.gapIds).toEqual(["r8"]);
    // And the fallback picks it up, so the must-have is not simply lost.
    expect(result.fallbackCount).toBe(1);
  });
});

describe("gap-fill category comes from the requirement's kind", () => {
  const base = { roleTitle: "Software Engineer", questions: [] as InternalQuestion[] };

  it("puts a behavioural gap fill in the behavioural section", async () => {
    const requirements = [
      requirement("r1", { text: "Mentoring junior engineers and reviewing their work", kind: "behavioural" }),
    ];

    const writer: GapFillWriter = async () => ({
      prompt: "Tell me about a time you mentored a junior engineer through reviewing their work.",
      answerOutline: "Outline.",
      difficulty: 2,
      // The model volunteers the wrong section; the requirement's kind overrules it.
      category: "technical",
    });

    const result = await runCoverage({ ...base, ids: ids(), requirements, writer });

    expect(result.questions.at(-1)?.category).toBe("behavioural");
  });

  it("routes a domain requirement to company-fit", async () => {
    const requirements = [requirement("r1", { text: "A background in payments", kind: "domain" })];
    const writer: GapFillWriter = async () => ({
      prompt: "What is different about building software in payments compared with other domains?",
      answerOutline: "Outline.",
      difficulty: 2,
    });

    const result = await runCoverage({ ...base, ids: ids(), requirements, writer });
    expect(result.questions.at(-1)?.category).toBe("company-fit");
  });
});
