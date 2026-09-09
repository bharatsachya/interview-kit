/**
 * APPENDIX A — THE FROZEN OUTPUT SHAPE.
 *
 * ────────────────────────────────────────────────────────────────────────────────────────
 * Every Appendix A field name in the codebase appears in this file and nowhere else.
 * If a name here is wrong, this file and the mapping in projections.ts are the only edits.
 * ────────────────────────────────────────────────────────────────────────────────────────
 *
 * Field names may not be renamed or omitted. The structure MAY be extended, so the few
 * additions below (`gaps`, `id` on flashcards) are safe; a wrong name is not.
 *
 * Provenance: names marked [SPEC] are quoted directly by the assessment or the skills, so
 * they are certain. Names marked [INFERRED] are reconstructed from the prose description
 * ("company brief, role breakdown, categorised question bank, flashcards, and a day-by-day
 * study schedule") and should be checked against the real Appendix A before submission.
 */

import { z } from "zod";

/** [SPEC] difficulty is an integer 1–3. Not a float, not 0, not 4. */
const difficultySchema = z.number().int().min(1).max(3);

/** [SPEC] minutes is an integer. No floats, no "about an hour". */
const minutesSchema = z.number().int().min(0);

const requirementSchema = z
  .object({
    id: z.string().min(1), // [SPEC] every requirement has a stable id
    text: z.string().min(1), // [SPEC]
    kind: z.enum(["technical", "behavioural", "domain"]), // [SPEC]
    priority: z.enum(["must", "nice"]), // [SPEC]
  })
  .strict();

const questionSchema = z
  .object({
    id: z.string().min(1),
    category: z.enum(["technical", "behavioural", "system-design", "company-fit"]), // [SPEC]
    prompt: z.string().min(1), // [SPEC]
    answer_outline: z.string(), // [SPEC]
    difficulty: difficultySchema, // [SPEC]
    requirement_ids: z.array(z.string()), // [SPEC] every question lists the requirements it covers
  })
  .strict();

const flashcardSchema = z
  .object({
    id: z.string().min(1), // [INFERRED] — extension; the builder needs a stable handle
    front: z.string().min(1), // [SPEC]
    back: z.string(), // [SPEC]
    requirement_ids: z.array(z.string()), // [SPEC] carried over from the source question
  })
  .strict();

const daySchema = z
  .object({
    day: z.number().int().min(1), // [INFERRED]
    focus: z.string(), // [SPEC] every day has a focus
    question_ids: z.array(z.string()), // [SPEC]
    minutes: minutesSchema, // [SPEC] integer duration
  })
  .strict();

const scheduleSchema = z
  .object({
    days_available: z.number().int().min(1), // [SPEC]
    days: z.array(daySchema), // [SPEC]
  })
  .strict();

const roleSchema = z
  .object({
    title: z.string(), // [INFERRED]
    company: z.string(), // [INFERRED]
    location: z.string(), // [SPEC] required, and "" when the posting does not say
    summary: z.string(), // [INFERRED]
    responsibilities: z.array(z.string()), // [SPEC] the role breakdown's "what the role does"
  })
  .strict();

const companyBriefSchema = z
  .object({
    summary: z.string(), // [INFERRED]
    what_they_do: z.string(), // [INFERRED]
    hiring_process: z.string(), // [INFERRED]
    sources: z.array(z.string()), // [SPEC] record sources truthfully
    pages_used: z.array(z.string()), // [SPEC] record pages_used truthfully
    gaps: z.array(z.string()), // [INFERRED] extension — what could not be found, said plainly
  })
  .strict();

const coverageSchema = z
  .object({
    passes: z.number().int().min(1), // [SPEC] coverage.passes, recorded honestly
    uncovered_requirement_ids: z.array(z.string()), // [SPEC]
  })
  .strict();

/**
 * The whole kit, with the cross-field integrity rules that the per-field schemas cannot express.
 *
 * These four refinements are the ones that actually catch bugs. Every one of them corresponds
 * to a way the state model could go wrong after an archive, an edit or a regeneration.
 */
export const kitJsonSchema = z
  .object({
    id: z.string().min(1), // [INFERRED]
    role: roleSchema,
    company_brief: companyBriefSchema, // [INFERRED] key name
    requirements: z.array(requirementSchema), // [SPEC]
    questions: z.array(questionSchema), // [SPEC]
    flashcards: z.array(flashcardSchema), // [SPEC]
    schedule: scheduleSchema, // [SPEC]
    coverage: coverageSchema, // [SPEC]
  })
  .strict()
  .superRefine((kit, ctx) => {
    const requirementIds = new Set(kit.requirements.map((r) => r.id));
    const questionIds = new Set(kit.questions.map((q) => q.id));

    // Every question lists requirement ids that exist. Catches a model that invented one.
    for (const [index, question] of kit.questions.entries()) {
      for (const id of question.requirement_ids) {
        if (!requirementIds.has(id)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["questions", index, "requirement_ids"],
            message: `question ${question.id} references unknown requirement ${id}`,
          });
        }
      }
    }

    for (const [index, card] of kit.flashcards.entries()) {
      for (const id of card.requirement_ids) {
        if (!requirementIds.has(id)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["flashcards", index, "requirement_ids"],
            message: `flashcard ${card.id} references unknown requirement ${id}`,
          });
        }
      }
    }

    // The dangling-id rule. This is the one an archive-then-serialize would break.
    for (const [index, day] of kit.schedule.days.entries()) {
      for (const id of day.question_ids) {
        if (!questionIds.has(id)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["schedule", "days", index, "question_ids"],
            message: `day ${day.day} references unknown question ${id}`,
          });
        }
      }
    }

    // [SPEC] days.length equals days_available exactly.
    if (kit.schedule.days.length !== kit.schedule.days_available) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["schedule", "days"],
        message: `days_available is ${kit.schedule.days_available} but there are ${kit.schedule.days.length} days`,
      });
    }

    // A question listed twice on the SAME day double-counts its minutes and reads as a bug.
    // Across days it is deliberate: the 60-day schedule policy is spaced review, so material
    // from an early day is meant to come back later.
    for (const [index, day] of kit.schedule.days.entries()) {
      const seen = new Set<string>();
      for (const id of day.question_ids) {
        if (seen.has(id)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["schedule", "days", index, "question_ids"],
            message: `question ${id} is listed twice on day ${day.day}`,
          });
        }
        seen.add(id);
      }
    }
  });

export type KitJSON = z.infer<typeof kitJsonSchema>;
export type KitJSONQuestion = KitJSON["questions"][number];
export type KitJSONFlashcard = KitJSON["flashcards"][number];
export type KitJSONDay = KitJSON["schedule"]["days"][number];

export interface KitValidationResult {
  ok: boolean;
  /** Human-readable, one per problem. Reaches the trace, never a user. */
  errors: string[];
}

/** Validate without throwing — for the batch path, which records rather than crashes. */
export function validateKitJSON(value: unknown): KitValidationResult {
  const result = kitJsonSchema.safeParse(value);
  if (result.success) return { ok: true, errors: [] };
  return {
    ok: false,
    errors: result.error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`),
  };
}
