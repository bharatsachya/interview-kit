import { truncateForPrompt, untrustedBlock, type LlmProvider } from "@trao/contracts";
import type { Difficulty, Requirement } from "@trao/kit";
import { z } from "zod";

/**
 * The writer that `@trao/coverage` calls to close a gap.
 *
 * It lives here because writing a question is generation's job, and coverage deliberately knows
 * nothing about model providers. Coverage supplies the cluster, gates the answer, and attaches
 * the requirement ids itself.
 *
 * Note what the schema does NOT contain: `requirement_ids`. The model is asked for question text
 * and nothing else, so it cannot mislabel what it wrote. That is the whole defence against a kit
 * that passes its own coverage check with questions about the wrong thing.
 */

const gapFillSchema = z.object({
  prompt: z.string().min(1),
  answer_outline: z.string(),
  difficulty: z.number().int().min(1).max(3),
});

export interface GapFillWriterOptions {
  llm: LlmProvider;
}

export interface GapFillDraft {
  prompt: string;
  answerOutline: string;
  difficulty: Difficulty;
}

export function createGapFillWriter(options: GapFillWriterOptions) {
  return async (request: {
    requirements: readonly Requirement[];
    roleTitle: string;
    hiringProcess?: string;
  }): Promise<GapFillDraft | null> => {
    if (request.requirements.length === 0) return null;

    const { data } = await options.llm.complete({
      purpose: `gap_fill:${request.requirements.map((r) => r.id).join("+")}`,
      prompt: buildPrompt(request),
      schema: gapFillSchema,
    });

    return {
      prompt: data.prompt.trim(),
      answerOutline: data.answer_outline.trim(),
      difficulty: data.difficulty as Difficulty,
    };
  };
}

function buildPrompt(request: {
  requirements: readonly Requirement[];
  roleTitle: string;
  hiringProcess?: string;
}): string {
  const single = request.requirements.length === 1;

  return [
    `An interview study kit for a ${request.roleTitle || "role"} is missing a question about`,
    single ? "this requirement:" : "these closely related requirements:",
    "",
    ...request.requirements.map((r) => `- ${r.text}`),
    "",
    "Write ONE interview question that genuinely covers " + (single ? "it" : "them") + ".",
    "It must use the vocabulary of the requirement above — a question about something adjacent",
    "does not close this gap. Include an `answer_outline` of three or four points and a",
    "`difficulty` of 1, 2 or 3.",
    "",
    ...((request.hiringProcess ?? "").trim().length > 0
      ? [untrustedBlock("hiring_process", truncateForPrompt(request.hiringProcess as string, 1_000)), ""]
      : []),
    "Return JSON of exactly this shape and nothing else:",
    "",
    '{ "prompt": "", "answer_outline": "", "difficulty": 2 }',
    "",
    "`answer_outline` is a single string, not a list.",
  ].join("\n");
}
