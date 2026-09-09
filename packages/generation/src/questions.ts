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

/**
 * Deliberately tolerant of how models actually answer.
 *
 * Every one of these coercions was observed on the first live Gemini run, in a single response:
 * a bare array instead of the wrapper object, `question` instead of `prompt`, and
 * `answer_outline` as an array of bullet strings instead of one string. None of it showed up
 * against the fake, which returns the right shape by construction — which is precisely the class
 * of bug a fake hides.
 *
 * Being strict here would be principled and wrong. Each rejection costs a repair round, and a
 * second failure loses the whole category — four categories failing this way produced a kit with
 * zero questions. The prompt states the exact shape (see `buildPrompt`); this is the belt to
 * that pair of braces.
 */
const questionItemSchema = z.preprocess((value) => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return value;
  const item = { ...(value as Record<string, unknown>) };

  if (item["prompt"] === undefined && typeof item["question"] === "string") item["prompt"] = item["question"];
  if (item["answer_outline"] === undefined && item["outline"] !== undefined) item["answer_outline"] = item["outline"];
  if (Array.isArray(item["answer_outline"])) {
    item["answer_outline"] = (item["answer_outline"] as unknown[]).map((line) => `- ${String(line)}`).join("\n");
  }
  if (typeof item["difficulty"] === "string") item["difficulty"] = Number.parseInt(item["difficulty"], 10);
  if (typeof item["requirement_ids"] === "string") item["requirement_ids"] = [item["requirement_ids"]];

  return item;
}, z.object({
  prompt: z.string().min(1),
  answer_outline: z.string(),
  difficulty: z.number().int().min(1).max(3),
  /** Checked against what we supplied, never trusted. */
  requirement_ids: z.array(z.string()).default([]),
}));

const questionsSchema = z.preprocess(
  // A bare array is the single most common deviation: the prompt asks for questions, so the
  // model returns questions rather than an object containing them.
  (value) => (Array.isArray(value) ? { questions: value } : value),
  z.object({ questions: z.array(questionItemSchema).max(12) }),
);

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
 * takes only the ones that read as architectural, and takes none if there are none.
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
      // No fallback to "all technical". Seeding this call with whatever technical requirements
      // happen to exist produced a design question about a "portfolio verification service
      // handling 50,000 submissions per second" from the requirement "a portfolio of real
      // things you've shipped" — an invented domain wearing a scale constraint. A posting with
      // nothing architectural in it should yield no system-design section, which the category
      // report records as skipped.
      return technical.filter((r) => SYSTEM_DESIGN_SIGNALS.test(r.text));
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
    "Never mention the brief, the material you were given, or its limitations. The candidate",
    "reads these questions; a question that says 'given that company details are limited' is",
    "about our retrieval, not about them.",
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

  // Stating the envelope explicitly. Without it the model returns a bare array of items keyed
  // `question`, which is a perfectly reasonable reading of "write questions" and fails the
  // schema twice.
  lines.push(
    "Return JSON of exactly this shape and nothing else:",
    "",
    "{",
    '  "questions": [',
    "    {",
    '      "prompt": "the question, as a single string",',
    '      "answer_outline": "the points a strong answer covers, as a SINGLE string, not a list",',
    '      "difficulty": 2,',
    // An id from this call's own list, never a made-up one — a literal example id would both
    // teach the model a value that does not exist and leak another category's id into this
    // prompt, which is the thing the four-separate-calls test checks for.
    `      "requirement_ids": [${seed[0] !== undefined ? JSON.stringify(seed[0].id) : ""}]`,
    "    }",
    "  ]",
    "}",
    "",
    "`questions` must be present. Do not return a bare array. `prompt` is the key, not",
    "`question`. `answer_outline` is one string, not an array.",
  );
  return lines.join("\n");
}
