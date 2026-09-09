import { describe, expect, it } from "vitest";
import type { IdGenerator, LlmProvider, LlmRequest, LlmResult } from "@trao/contracts";
import type { InternalQuestion, Requirement } from "@trao/kit";
import { generateBrief } from "../src/brief";
import { deriveFlashcards, frontFor } from "../src/flashcards";
import { createGapFillWriter } from "../src/gap-fill";
import { generateQuestions, requirementsFor, responsibilitiesFor } from "../src/questions";

class StubLlm implements LlmProvider {
  readonly name = "stub";
  readonly calls: { purpose: string; prompt: string }[] = [];

  constructor(private readonly responses: Record<string, unknown>) {}

  async complete<T>(request: LlmRequest<T>): Promise<LlmResult<T>> {
    this.calls.push({ purpose: request.purpose, prompt: request.prompt });

    const canned = this.responses[request.purpose];
    if (canned === undefined) throw new Error(`no response for ${request.purpose}`);

    const parsed = request.schema.safeParse(canned);
    if (!parsed.success) throw new Error(`invalid canned response: ${parsed.error.message}`);
    return { data: parsed.data, usage: { inputTokens: 1, outputTokens: 1 }, model: "stub", cacheHit: false, repaired: false };
  }
}

function ids(): IdGenerator {
  const counters = new Map<string, number>();
  return {
    next: (prefix) => {
      const n = (counters.get(prefix) ?? 0) + 1;
      counters.set(prefix, n);
      return `${prefix}${n}`;
    },
  };
}

const REQUIREMENTS: Requirement[] = [
  { id: "r1", text: "Five years of Python", kind: "technical", priority: "must" },
  { id: "r2", text: "Designing distributed systems for availability", kind: "technical", priority: "must" },
  { id: "r3", text: "Mentoring junior engineers", kind: "behavioural", priority: "must" },
  { id: "r4", text: "A background in payments", kind: "domain", priority: "nice" },
];

const questionsFor = (ids_: string[]) => ({
  questions: [
    { prompt: "A first question about the topic?", answer_outline: "Point one. Point two.", difficulty: 2, requirement_ids: ids_ },
    { prompt: "A second question about the topic?", answer_outline: "Point one.", difficulty: 3, requirement_ids: ids_ },
  ],
});

const ALL_CATEGORIES = {
  "generate_questions:technical": questionsFor(["r1"]),
  "generate_questions:behavioural": questionsFor(["r3"]),
  "generate_questions:system-design": questionsFor(["r2"]),
  "generate_questions:company-fit": questionsFor(["r4"]),
};

describe("four separate calls", () => {
  it("makes exactly one call per category", async () => {
    const llm = new StubLlm(ALL_CATEGORIES);
    await generateQuestions({ requirements: REQUIREMENTS, roleTitle: "Senior Backend Engineer", company: "Acme", llm, ids: ids() });

    expect(llm.calls.map((c) => c.purpose)).toEqual([
      "generate_questions:technical",
      "generate_questions:behavioural",
      "generate_questions:system-design",
      "generate_questions:company-fit",
    ]);
  });

  it("sends four distinct prompts", async () => {
    const llm = new StubLlm(ALL_CATEGORIES);
    await generateQuestions({ requirements: REQUIREMENTS, roleTitle: "Senior Backend Engineer", company: "Acme", llm, ids: ids() });

    expect(new Set(llm.calls.map((c) => c.prompt)).size).toBe(4);
  });

  it("never shows a technical requirement to the behavioural call", async () => {
    const llm = new StubLlm(ALL_CATEGORIES);
    await generateQuestions({ requirements: REQUIREMENTS, roleTitle: "Senior Backend Engineer", company: "Acme", llm, ids: ids() });

    const behavioural = llm.calls.find((c) => c.purpose.endsWith("behavioural"))?.prompt ?? "";
    expect(behavioural).not.toContain("Five years of Python");
    expect(behavioural).not.toContain("r1");
    expect(behavioural).toContain("Mentoring junior engineers");
  });

  it("never shows a behavioural requirement to the technical call", async () => {
    const llm = new StubLlm(ALL_CATEGORIES);
    await generateQuestions({ requirements: REQUIREMENTS, roleTitle: "Senior Backend Engineer", company: "Acme", llm, ids: ids() });

    const technical = llm.calls.find((c) => c.purpose.endsWith(":technical"))?.prompt ?? "";
    expect(technical).not.toContain("Mentoring junior engineers");
  });

  it("gives each category its own instructions, not one shared voice", async () => {
    const llm = new StubLlm(ALL_CATEGORIES);
    await generateQuestions({ requirements: REQUIREMENTS, roleTitle: "Senior Backend Engineer", company: "Acme", llm, ids: ids() });

    const behavioural = llm.calls.find((c) => c.purpose.endsWith("behavioural"))?.prompt ?? "";
    const design = llm.calls.find((c) => c.purpose.endsWith("system-design"))?.prompt ?? "";

    expect(behavioural).toContain("specific story");
    expect(design).toContain("trade-off");
    expect(design).not.toContain("specific story");
  });

  it("tags each question with its own category", async () => {
    const result = await generateQuestions({
      requirements: REQUIREMENTS,
      roleTitle: "Senior Backend Engineer",
      company: "Acme",
      llm: new StubLlm(ALL_CATEGORIES),
      ids: ids(),
    });

    expect(new Set(result.questions.map((q) => q.category))).toEqual(
      new Set(["technical", "behavioural", "system-design", "company-fit"]),
    );
  });
});

describe("requirement routing", () => {
  it("routes by kind", () => {
    expect(requirementsFor("technical", REQUIREMENTS).map((r) => r.id)).toEqual(["r1", "r2"]);
    expect(requirementsFor("behavioural", REQUIREMENTS).map((r) => r.id)).toEqual(["r3"]);
    expect(requirementsFor("company-fit", REQUIREMENTS).map((r) => r.id)).toEqual(["r4"]);
  });

  it("gives system design the architectural technical requirements", () => {
    expect(requirementsFor("system-design", REQUIREMENTS).map((r) => r.id)).toEqual(["r2"]);
  });

  it("takes nothing when no requirement reads as architectural, rather than falling back", () => {
    // The fallback produced a design question about a "portfolio verification service handling
    // 50,000 submissions per second" from the requirement "a portfolio of real things you've
    // shipped". No system-design section is better than an invented one.
    const plain: Requirement[] = [{ id: "r1", text: "Five years of Python", kind: "technical", priority: "must" }];
    expect(requirementsFor("system-design", plain)).toEqual([]);
  });
});

describe("skipping rather than inventing", () => {
  it("skips a category with no requirements instead of asking for questions from nothing", async () => {
    // r1 is "Five years of Python" — technical, but nothing architectural about it, so
    // system-design is skipped too rather than being handed it as a fallback.
    const technicalOnly: Requirement[] = [REQUIREMENTS[0] as Requirement];
    const llm = new StubLlm({ "generate_questions:technical": questionsFor(["r1"]) });

    const result = await generateQuestions({ requirements: technicalOnly, roleTitle: "Engineer", company: "Acme", llm, ids: ids() });

    expect(llm.calls.map((c) => c.purpose)).toEqual(["generate_questions:technical"]);
    expect(result.reports.find((r) => r.category === "system-design")?.skipped).toBe("no_requirements");
    expect(result.reports.find((r) => r.category === "behavioural")?.skipped).toBe("no_requirements");
    expect(result.reports.find((r) => r.category === "company-fit")?.skipped).toBe("no_context");
  });

  it("still asks company-fit questions from the brief when there are no domain requirements", async () => {
    const technicalOnly: Requirement[] = [REQUIREMENTS[0] as Requirement];
    const llm = new StubLlm({
      "generate_questions:technical": questionsFor(["r1"]),
      "generate_questions:company-fit": questionsFor([]),
    });

    await generateQuestions({
      requirements: technicalOnly,
      roleTitle: "Engineer",
      company: "Acme",
      companySummary: "Acme moves money for marketplaces.",
      llm,
      ids: ids(),
    });

    expect(llm.calls.some((c) => c.purpose.endsWith("company-fit"))).toBe(true);
  });

  it("records a failed category without failing the run", async () => {
    const llm = new StubLlm({
      "generate_questions:behavioural": questionsFor(["r3"]),
      "generate_questions:system-design": questionsFor(["r2"]),
      "generate_questions:company-fit": questionsFor(["r4"]),
    });

    const result = await generateQuestions({ requirements: REQUIREMENTS, roleTitle: "E", company: "A", llm, ids: ids() });

    expect(result.reports.find((r) => r.category === "technical")?.failed).toBeDefined();
    expect(result.questions.length).toBeGreaterThan(0);
  });
});

describe("requirement ids on generated questions", () => {
  it("drops an id the call was never shown", async () => {
    const llm = new StubLlm({
      ...ALL_CATEGORIES,
      "generate_questions:technical": {
        questions: [
          { prompt: "A question?", answer_outline: "Outline.", difficulty: 2, requirement_ids: ["r1", "r3", "r99"] },
        ],
      },
    });

    const result = await generateQuestions({ requirements: REQUIREMENTS, roleTitle: "E", company: "A", llm, ids: ids() });
    const technical = result.questions.find((q) => q.category === "technical");

    // r3 is behavioural and r99 does not exist; neither was supplied to this call.
    expect(technical?.requirementIds).toEqual(["r1"]);
  });

  it("attaches the single seeded requirement when the model tagged nothing", async () => {
    const one: Requirement[] = [REQUIREMENTS[2] as Requirement];
    const llm = new StubLlm({
      "generate_questions:behavioural": {
        questions: [{ prompt: "Tell me about mentoring?", answer_outline: "Outline.", difficulty: 2, requirement_ids: [] }],
      },
    });

    const result = await generateQuestions({ requirements: one, roleTitle: "E", company: "A", llm, ids: ids() });
    expect(result.questions[0]?.requirementIds).toEqual(["r3"]);
  });
});

describe("sequencing: the hiring page changes the questions", () => {
  it("feeds the discovered hiring process into every category", async () => {
    const llm = new StubLlm(ALL_CATEGORIES);
    await generateQuestions({
      requirements: REQUIREMENTS,
      roleTitle: "Engineer",
      company: "Acme",
      hiringProcess: "A take-home exercise, then a system design round.",
      llm,
      ids: ids(),
    });

    for (const call of llm.calls) {
      expect(call.prompt, `${call.purpose} did not receive the hiring process`).toContain("take-home exercise");
    }
  });

  it("says nothing about a process when none was found", async () => {
    const llm = new StubLlm(ALL_CATEGORIES);
    await generateQuestions({ requirements: REQUIREMENTS, roleTitle: "Engineer", company: "Acme", llm, ids: ids() });

    for (const call of llm.calls) expect(call.prompt).not.toContain("HIRINGPROCESS");
  });
});

describe("the company brief", () => {
  const briefResponse = {
    summary: "Acme moves money for marketplaces.",
    what_they_do: "Card processing.",
    hiring_process: "Two technical rounds.",
  };

  it("records sources and pages_used from what was actually fetched, not from the model", async () => {
    const result = await generateBrief({
      company: "Acme",
      roleTitle: "Engineer",
      pages: [{ url: "https://acme.test/", title: "Acme", text: "We do payments." }],
      discussion: [{ url: "https://forum.test/1", title: "Interviewing at Acme", content: "Two rounds." }],
      llm: new StubLlm({ generate_brief: briefResponse }),
    });

    expect(result.brief.pagesUsed).toEqual(["https://acme.test/"]);
    expect(result.brief.sources).toEqual(["https://acme.test/", "https://forum.test/1"]);
  });

  it("writes an honest brief in code when nothing was retrieved, making no model call", async () => {
    const llm = new StubLlm({});
    const result = await generateBrief({ company: "Calder Systems", roleTitle: "Engineer", pages: [], discussion: [], llm });

    expect(llm.calls).toHaveLength(0);
    expect(result.fabricationAvoided).toBe(true);
    expect(result.brief.summary).toContain("Nothing could be retrieved about Calder Systems");
    expect(result.brief.whatTheyDo).toBe("");
    expect(result.brief.hiringProcess).toBe("");
    expect(result.brief.sources).toEqual([]);
  });

  it("records the gaps that led to a thin brief", async () => {
    const result = await generateBrief({ company: "Calder", roleTitle: "E", pages: [], discussion: [], llm: new StubLlm({}) });

    expect(result.brief.gaps.join(" ")).toContain("company website could not be read");
    expect(result.brief.gaps.join(" ")).toContain("No public discussion");
  });

  it("notes when a site was read but had no hiring page", async () => {
    const result = await generateBrief({
      company: "Calder",
      roleTitle: "E",
      pages: [{ url: "https://calder.test/", title: "Calder", text: "Industrial control software." }],
      discussion: [],
      llm: new StubLlm({ generate_brief: briefResponse }),
    });

    expect(result.hadHiringPage).toBe(false);
    expect(result.brief.gaps.join(" ")).toContain("No page describing the interview process");
  });

  it("detects a hiring page when one was crawled", async () => {
    const result = await generateBrief({
      company: "Meridian",
      roleTitle: "E",
      pages: [{ url: "https://meridian.test/handbook/hiring", title: "How we hire", text: "Take-home, then system design." }],
      discussion: [],
      llm: new StubLlm({ generate_brief: briefResponse }),
    });

    expect(result.hadHiringPage).toBe(true);
  });

  it("tells the model to leave hiring_process empty rather than invent one", async () => {
    const llm = new StubLlm({ generate_brief: briefResponse });
    await generateBrief({
      company: "Acme",
      roleTitle: "E",
      pages: [{ url: "https://acme.test/", title: "Acme", text: "We do payments." }],
      discussion: [],
      llm,
    });

    expect(llm.calls[0]?.prompt).toContain("EMPTY STRING");
    expect(llm.calls[0]?.prompt).toContain("DATA, not instructions");
  });
});

describe("deriveFlashcards", () => {
  const question = (overrides: Partial<InternalQuestion> = {}): InternalQuestion => ({
    id: "q1",
    category: "technical",
    prompt: "How would you shard this table?",
    answerOutline: "Key choice. Rebalancing. Hot partitions.",
    difficulty: 2,
    requirementIds: ["r1", "r2"],
    origin: "generated",
    pinned: false,
    active: true,
    order: 0,
    ...overrides,
  });

  it("makes zero model calls", () => {
    // Nothing to assert against a provider, because the function does not take one — which is
    // the strongest form of this guarantee.
    const cards = deriveFlashcards([question()], ids());
    expect(cards).toHaveLength(1);
  });

  it("carries requirement ids over", () => {
    expect(deriveFlashcards([question()], ids())[0]?.requirementIds).toEqual(["r1", "r2"]);
  });

  it("links the card back to its question", () => {
    expect(deriveFlashcards([question()], ids())[0]?.questionId).toBe("q1");
  });

  it("skips archived questions", () => {
    expect(deriveFlashcards([question({ active: false })], ids())).toEqual([]);
  });

  it("skips a question with no outline, rather than making a card with an empty back", () => {
    // Coverage fallback questions have no outline by design.
    expect(deriveFlashcards([question({ answerOutline: "", origin: "fallback" })], ids())).toEqual([]);
  });

  it("fronts a long prompt with its question, not a truncation", () => {
    const long =
      "Our ingest pipeline buffers in memory and loses data whenever a node restarts, which has happened three times this quarter and cost us a customer. How would you make it durable without adding more than ten milliseconds of write latency?";
    const front = frontFor(long);

    expect(front.endsWith("?")).toBe(true);
    expect(front).toContain("How would you make it durable");
    expect(front).not.toContain("…");
  });

  it("leaves a short prompt alone", () => {
    expect(frontFor("How would you shard this table?")).toBe("How would you shard this table?");
  });
});

describe("the gap-fill writer", () => {
  it("asks for question text and never for requirement ids", async () => {
    const llm = new StubLlm({
      "gap_fill:r1": { prompt: "How do you profile a slow Python service?", answer_outline: "Outline.", difficulty: 2 },
    });

    const write = createGapFillWriter({ llm });
    const draft = await write({ requirements: [REQUIREMENTS[0] as Requirement], roleTitle: "Engineer" });

    expect(draft?.prompt).toContain("profile a slow Python service");
    expect(llm.calls[0]?.prompt).not.toContain("requirement_ids");
    expect(llm.calls[0]?.prompt).toContain("Five years of Python");
  });

  it("returns null for an empty cluster rather than calling the model", async () => {
    const llm = new StubLlm({});
    const draft = await createGapFillWriter({ llm })({ requirements: [], roleTitle: "Engineer" });

    expect(draft).toBeNull();
    expect(llm.calls).toHaveLength(0);
  });
});

/**
 * Flashcard fronts are never truncated.
 *
 * Practice mode is scored on these. A card fronted with "Our ingest pipeline buffers in memory
 * and…" is not a prompt, it is a fragment with an ellipsis, and it reads as a broken generator.
 */
describe("frontFor never truncates", () => {
  const PROMPTS = [
    "How would you shard this table?",
    "Our ingest pipeline buffers in memory and loses data whenever a node restarts, which cost us a customer. How would you make it durable without adding more than ten milliseconds of write latency?",
    "Walk me through a time when streaming partial outputs from a sub-agent caused a race condition in your orchestration UI. How did you handle user interrupts without corrupting the memory context?",
    "Describe your approach to mentoring.",
    "Tell me about a production incident. What broke? What did you change afterwards?",
    "Design a system where availability is the binding constraint and defend the trade-off you make.",
  ];

  it.each(PROMPTS)("leaves no ellipsis on %#", (prompt) => {
    const front = frontFor(prompt);
    expect(front).not.toContain("…");
    expect(front).not.toMatch(/\.\.\.$/);
  });

  it.each(PROMPTS)("ends every front on a sentence boundary (%#)", (prompt) => {
    expect(frontFor(prompt)).toMatch(/[.!?]$/);
  });

  it.each(PROMPTS)("keeps the front a prefix of the prompt, never a rewrite (%#)", (prompt) => {
    const normalised = prompt.trim().replace(/\s+/g, " ");
    expect(normalised.startsWith(frontFor(prompt))).toBe(true);
  });

  it("uses the first sentence when it is itself the question", () => {
    expect(frontFor("How do you debug a failing rollout? Assume no logs.")).toBe(
      "How do you debug a failing rollout?",
    );
  });

  it("keeps the whole prompt when the setup comes first", () => {
    // Cutting to the buried question would lose the constraint it depends on.
    const prompt = "Our writes drop on restart. How would you make it durable?";
    expect(frontFor(prompt)).toBe(prompt);
  });

  it("keeps a long single-sentence prompt whole rather than cutting it", () => {
    const long =
      "Design the ingestion path for a ledger that must sustain ten thousand writes a second while keeping strict ordering guarantees across three regions.";
    expect(frontFor(long)).toBe(long);
  });

  it("produces card fronts that are all complete sentences", () => {
    const cards = deriveFlashcards(
      PROMPTS.map((prompt, index) => ({
        id: `q${index}`,
        category: "technical" as const,
        prompt,
        answerOutline: "Some outline.",
        difficulty: 2 as const,
        requirementIds: [],
        origin: "generated" as const,
        pinned: false,
        active: true,
        order: index,
      })),
      ids(),
    );

    expect(cards).toHaveLength(PROMPTS.length);
    for (const card of cards) {
      expect(card.front).not.toContain("…");
      expect(card.front).toMatch(/[.!?]$/);
    }
  });
});

/**
 * Responsibilities are material, even though they are not requirements.
 *
 * A live run on a platform-engineering posting produced three requirements and seven
 * responsibilities. The seven were the entire substance of the job — orchestration UX, streaming
 * partial output, interrupts and approvals, three messaging channels — and none of them produced
 * a question, because generation only ever saw the requirements. The kit asked about portfolios
 * and ambiguity and nothing about the work.
 */
describe("responsibilities reach question generation", () => {
  const RESPONSIBILITIES = [
    "Orchestration UX — sub-agent state, streaming partial output, handling interrupts and approvals",
    "Connected services — let users plug Gmail, Drive and Slack into the product",
    "Keeping the web experience consistent across WhatsApp, Telegram and iMessage",
  ];

  const thin: Requirement[] = [
    { id: "r1", text: "A portfolio of real things you've shipped", kind: "technical", priority: "must" },
  ];

  it("gives the technical call the work as well as the requirements", async () => {
    const llm = new StubLlm({ ...ALL_CATEGORIES, "generate_questions:technical": questionsFor(["r1"]) });
    await generateQuestions({
      requirements: thin,
      responsibilities: RESPONSIBILITIES,
      roleTitle: "Software Engineer",
      company: "Magica",
      llm,
      ids: ids(),
    });

    const technical = llm.calls.find((c) => c.purpose.endsWith(":technical"))?.prompt ?? "";
    expect(technical).toContain("streaming partial output");
    expect(technical).toContain("do NOT tag questions about");
  });

  it("runs system design on architectural work when no requirement is architectural", async () => {
    // Previously skipped as no_requirements while "streaming partial output" sat unused.
    const llm = new StubLlm({ "generate_questions:system-design": questionsFor([]) });
    const result = await generateQuestions({
      requirements: thin,
      responsibilities: RESPONSIBILITIES,
      roleTitle: "Software Engineer",
      company: "Magica",
      llm,
      ids: ids(),
    });

    expect(llm.calls.some((c) => c.purpose.endsWith("system-design"))).toBe(true);
    expect(result.reports.find((r) => r.category === "system-design")?.skipped).toBeUndefined();
  });

  it("keeps the work away from the behavioural call", () => {
    // "Build the connected services surfaces" as a behavioural prompt is a technical question
    // wearing a story.
    expect(responsibilitiesFor("behavioural", RESPONSIBILITIES)).toEqual([]);
    expect(responsibilitiesFor("technical", RESPONSIBILITIES)).toHaveLength(3);
  });

  it("gives system design only the architectural ones", () => {
    const design = responsibilitiesFor("system-design", RESPONSIBILITIES);
    expect(design).toHaveLength(1);
    expect(design[0]).toContain("streaming partial output");
  });

  it("still skips a category with neither requirements nor work", async () => {
    const llm = new StubLlm({ "generate_questions:technical": questionsFor(["r1"]) });
    const result = await generateQuestions({
      requirements: thin,
      responsibilities: [],
      roleTitle: "E",
      company: "A",
      llm,
      ids: ids(),
    });

    expect(result.reports.find((r) => r.category === "behavioural")?.skipped).toBe("no_requirements");
  });
});
