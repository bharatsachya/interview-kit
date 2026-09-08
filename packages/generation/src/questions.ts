import { truncateForPrompt, untrustedBlock, type IdGenerator, type LlmProvider } from "@trao/contracts";
import type { Difficulty, InternalQuestion, QuestionCategory, Requirement } from "@trao/kit";
import { z } from "zod";

/**
 * Question generation: four categories, four separate calls, four distinct prompts.
 *
 * This is checked directly. "Five years of React" leads somewhere different from "mentoring
 * junior engineers", and the two must not come out of one call with one set of instructions —
 * a single call produces four blocks of questions in the same voice, all lightly technical,
 * because that is the average of the instruction it was given.
 *
 * Each call is seeded **only** with the requirements that belong to it, so a technical
 * requirement is never even visible to the behavioural call.
 *
 * Sequencing: the hiring-process text found by the crawl is fed into every call. A company that
 * publishes "take-home, then a system design round" should produce a different kit from one that
 * says nothing, and this is where that happens.
 */

export const DEFAULT_QUESTIONS_PER_CATEGORY = 5;

/** Technical requirements that read as architectural get the system-design call as well. */
const SYSTEM_DESIGN_SIGNALS =
  /\b(scal|distribut|architect|design|infrastructur|latency|throughput|availab|reliab|micro-?service|queue|stream|cache|shard|partition|concurren|capacity|resilien|failover|load)\w*/i;

const questionsSchema = z.object({
  questions: z
    .array(
      z.object({
        prompt: z.string().min(1),
        answer_outline: z.string(),
        difficulty: z.number().int().min(1).max(3),
        /** Checked against what we supplied, never trusted. */
        requirement_ids: z.array(z.string()).default([]),
      }),
    )
    .max(12),
});

export interface QuestionGenerationInput {
  requirements: readonly Requirement[];
  roleTitle: string;
  company: string;
  /** From the crawl. Empty when no hiring page was found. */
  hiringProcess?: string;
  companySummary?: string;
  llm: LlmProvider;
  ids: IdGenerator;
  perCategory?: number;
}

export interface CategoryReport {
  category: QuestionCategory;
  requirementsIn: number;
  questionsOut: number;
  /** Set when the call was not made, and why. Recorded honestly rather than faked. */
  skipped?: "no_requirements" | "no_context";
  failed?: string;
}

export interface QuestionGenerationResult {
  questions: InternalQuestion[];
  reports: CategoryReport[];
}

export async function generateQuestions(input: QuestionGenerationInput): Promise<QuestionGenerationResult> {
  const questions: InternalQuestion[] = [];
  const reports: CategoryReport[] = [];

  for (const category of ["technical", "behavioural", "system-design", "company-fit"] as const) {
    const seed = requirementsFor(category, input.requirements);

    // Skipping is honest. Calling a model with no requirements and asking for five questions is
    // an instruction to invent, and the empty categories are exactly where invention shows.
    if (seed.length === 0 && category !== "company-fit") {
      reports.push({ category, requirementsIn: 0, questionsOut: 0, skipped: "no_requirements" });
      continue;
    }
    if (category === "company-fit" && seed.length === 0 && (input.companySummary ?? "").trim().length === 0) {
      reports.push({ category, requirementsIn: 0, questionsOut: 0, skipped: "no_context" });
      continue;
    }

    try {
      const { data } = await input.llm.complete({
        // A distinct purpose per category: a distinct span in the trace and a distinct cache key.
        purpose: `generate_questions:${category}`,
        prompt: buildPrompt(category, seed, input),
        schema: questionsSchema,
      });

      const supplied = new Set(seed.map((r) => r.id));
      let order = 0;

      for (const candidate of data.questions) {
        // The model may tag, but only with ids it was actually shown. Anything else is dropped.
        let requirementIds = candidate.requirement_ids.filter((id) => supplied.has(id));
        // With a single-requirement seed there is no ambiguity about what it was answering.
        if (requirementIds.length === 0 && seed.length === 1) requirementIds = [seed[0]?.id as string];

        questions.push({
          id: input.ids.next("q"),
          category,
          prompt: candidate.prompt.trim(),
          answerOutline: candidate.answer_outline.trim(),
          difficulty: candidate.difficulty as Difficulty,
          requirementIds,
          origin: "generated",
          pinned: false,
          active: true,
          order: order++,
        });
      }

      reports.push({ category, requirementsIn: seed.length, questionsOut: data.questions.length });
    } catch (error) {
      // One category failing is a thinner kit, not a failed run.
      reports.push({
        category,
        requirementsIn: seed.length,
        questionsOut: 0,
        failed: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { questions, reports };
}

/**
 * Which requirements each call is allowed to see.
 *
 * Technical requirements reach both the technical and system-design calls, because the same
 * requirement genuinely supports both a depth question and a design question — but system design
 * only takes the ones that read as architectural, falling back to all of them for a role that has
 * technical requirements but no obvious architectural language.
 *
 * A technical requirement never reaches the behavioural call, and vice versa.
 */
export function requirementsFor(
  category: QuestionCategory,
  requirements: readonly Requirement[],
): Requirement[] {
  const technical = requirements.filter((r) => r.kind === "technical");

  switch (category) {
    case "technical":
      return technical;
    case "behavioural":
      return requirements.filter((r) => r.kind === "behavioural");
    case "system-design": {
      const architectural = technical.filter((r) => SYSTEM_DESIGN_SIGNALS.test(r.text));
      return architectural.length > 0 ? architectural : technical;
    }
    case "company-fit":
      return requirements.filter((r) => r.kind === "domain");
  }
}

const INSTRUCTIONS: Readonly<Record<QuestionCategory, string[]>> = {
  technical: [
    "Write technical interview questions that probe depth on the specific tools and practices",
    "listed. A good question here cannot be answered by someone who has only read about the",
    "technology — it asks about a decision, a failure, or a trade-off they had to live with.",
    "Avoid trivia with a single correct answer.",
  ],
  behavioural: [
    "Write behavioural interview questions about working with other people. Each should invite a",
    "specific story rather than a policy statement: what happened, what they did, how it landed.",
    "Do not ask about tools, languages or systems — that is another interviewer's job.",
  ],
  "system-design": [
    "Write system design questions grounded in the listed requirements. Each should state a",
    "concrete constraint — a scale, a latency budget, a failure mode — and ask the candidate to",
    "design against it and defend the trade-off. Not 'design Twitter'.",
  ],
  "company-fit": [
    "Write questions about this specific company and its domain: why this problem, what they",
    "would want to know before joining, how their background meets this industry. Use only what",
    "the brief below actually says about the company. If the brief is thin, ask fewer questions",
    "rather than inventing detail about the company.",
  ],
};

function buildPrompt(
  category: QuestionCategory,
  seed: readonly Requirement[],
  input: QuestionGenerationInput,
): string {
  const wanted = input.perCategory ?? DEFAULT_QUESTIONS_PER_CATEGORY;
  const lines: string[] = [
    `You are writing the ${category} section of an interview study kit for a`,
    `${input.roleTitle || "role"}${input.company ? ` at ${input.company}` : ""}.`,
    "",
    ...INSTRUCTIONS[category],
    "",
    `Write at most ${wanted} questions. Fewer is correct when there is less to ask about.`,
    "Each question needs an `answer_outline`: the three or four points a strong answer covers.",
    "`difficulty` is 1, 2 or 3.",
    "",
  ];

  if (seed.length > 0) {
    lines.push(
      "These are the requirements this section covers. Tag each question with the ids of the",
      "requirements it genuinely covers, using `requirement_ids`. Only these ids exist:",
      "",
      ...seed.map((r) => `- ${r.id} [${r.priority}] ${r.text}`),
      "",
    );
  }

  if ((input.hiringProcess ?? "").trim().length > 0) {
    lines.push(
      "The company describes its own interview process as follows. Let it shape what you ask —",
      "if they run a take-home followed by a design round, the questions should reflect that.",
      "",
      untrustedBlock("hiring_process", truncateForPrompt(input.hiringProcess as string, 1_500)),
      "",
    );
  }

  if (category === "company-fit" && (input.companySummary ?? "").trim().length > 0) {
    lines.push(untrustedBlock("company_brief", truncateForPrompt(input.companySummary as string, 1_500)), "");
  }

  lines.push("Return JSON only.");
  return lines.join("\n");
}
