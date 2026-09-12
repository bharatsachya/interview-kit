import { z } from "zod";
import { MAX_INSTRUCTION_CHARS } from "@trao/contracts";
import { QUESTION_CATEGORIES, type QuestionCategory } from "@trao/kit";

/**
 * Every request body the builder sends, and one way to reject one.
 *
 * The schemas are strict: a body carrying a field the route does not accept is a 400 rather
 * than a silently ignored key. That is the difference between a client that finds out its
 * `requirement_ids` edit did nothing and one that believes it worked — and retagging a question
 * by hand is exactly the write `QuestionPatch` refuses on purpose, so failing loudly here is
 * how the refusal reaches the person who tried it.
 *
 * Field names on the wire are snake_case, matching Appendix A and the rest of the HTTP surface;
 * the mapping onto the internal camelCase happens in the route, by hand, one field at a time.
 */

// One source of truth for the four categories. The cast only tells Zod the list is non-empty,
// which `QUESTION_CATEGORIES` is by construction; the element type survives it, so a parsed
// body lands as `QuestionCategory` rather than as a bare string.
const category = z.enum(QUESTION_CATEGORIES as unknown as readonly [QuestionCategory, ...QuestionCategory[]]);

/** 1 easy, 2 medium, 3 hard. The whole scale — a 9 is a bug in the client, not a hard question. */
const difficulty = z.union([z.literal(1), z.literal(2), z.literal(3)]);

/** Bounded so a paste of a whole job description cannot become a question prompt. */
const prose = (max: number) => z.string().trim().min(1).max(max);

export const briefPatchSchema = z
  .object({
    summary: z.string().trim().max(4_000).optional(),
    what_they_do: z.string().trim().max(4_000).optional(),
    hiring_process: z.string().trim().max(4_000).optional(),
  })
  .strict()
  .refine((body) => Object.keys(body).length > 0, { message: "No fields to update." });

export const questionPatchSchema = z
  .object({
    prompt: prose(2_000).optional(),
    answer_outline: z.string().trim().max(8_000).optional(),
    difficulty: difficulty.optional(),
  })
  .strict()
  .refine((body) => Object.keys(body).length > 0, { message: "No fields to update." });

export const newQuestionSchema = z
  .object({
    category,
    prompt: prose(2_000),
    answer_outline: z.string().trim().max(8_000).default(""),
    difficulty: difficulty.default(2),
    requirement_ids: z.array(z.string().min(1)).max(20).default([]),
  })
  .strict();

export const pinSchema = z
  .object({
    // Absent means "pin it" — the button that sends this is a pin, and an unpin sends false.
    pinned: z.boolean().default(true),
  })
  .strict();

export const moveSchema = z.object({ to_category: category }).strict();

export const reorderSchema = z
  .object({
    category,
    /**
     * The ids in their new order.
     *
     * Not required to be complete: a list is authoritative about what is in it and silent about
     * everything else, so a drag that sent only the visible window cannot reshuffle what was
     * scrolled off. Duplicates are refused, because two positions for one question has no
     * meaning and the last one would silently win.
     */
    ids: z
      .array(z.string().min(1))
      .max(200)
      .refine((ids) => new Set(ids).size === ids.length, { message: "Duplicate question id." }),
  })
  .strict();

export const flashcardPatchSchema = z
  .object({
    front: prose(2_000).optional(),
    back: z.string().trim().max(8_000).optional(),
    requirement_ids: z.array(z.string().min(1)).max(20).optional(),
  })
  .strict()
  .refine((body) => Object.keys(body).length > 0, { message: "No fields to update." });

export const newFlashcardSchema = z
  .object({
    front: prose(2_000),
    back: z.string().trim().max(8_000).default(""),
    requirement_ids: z.array(z.string().min(1)).max(20).default([]),
  })
  .strict();

export const schedulePatchSchema = z
  .object({
    focus: z.string().trim().max(500).optional(),
    minutes: z.number().int().min(0).max(24 * 60).optional(),
    question_ids: z.array(z.string().min(1)).max(200).optional(),
  })
  .strict()
  .refine((body) => Object.keys(body).length > 0, { message: "No fields to update." });

/**
 * Regeneration takes a section, and a category only when the section is `questions`.
 *
 * The category is refused on the other two rather than ignored: `{section: "schedule",
 * category: "technical"}` is a client that thinks it asked for something narrower than it did,
 * and answering it with a full schedule rebuild would look like a bug in the schedule.
 *
 * `instructions` is the free text the composer sends with the rewrite. Capped at the same number
 * of characters the prompt builder truncates to, so the request is refused at the edge rather
 * than silently shortened three packages later — a user who typed six hundred words deserves to
 * be told, not to wonder why only the first paragraph was heard.
 */
const instructions = z.string().trim().max(MAX_INSTRUCTION_CHARS).optional();

export const regenerateSchema = z
  .union([
    z.object({ section: z.literal("questions"), category, instructions }).strict(),
    z.object({ section: z.enum(["company_brief", "schedule"]), instructions }).strict(),
  ]);

export const createKitSchema = z
  .object({
    jd: prose(100_000),
    company_url: z.string().url(),
    days: z.number().int().min(1).max(365),
  })
  .strict();

export interface ValidationFailure {
  code: "INVALID_BODY";
  field: string;
  message: string;
}

export type ParsedBody<T> = { ok: true; value: T } | { ok: false; error: ValidationFailure };

/**
 * Parse a body, or produce the one error shape every 400 uses.
 *
 * Only the first issue is reported. A form that highlights one field at a time is what the
 * builder actually does, and a list of issues would have to be rendered somewhere that does not
 * exist. `field` is the dotted path, or the root schema's name when the problem is the shape of
 * the body rather than one field in it.
 */
export function parseBody<S extends z.ZodTypeAny>(schema: S, body: unknown): ParsedBody<z.infer<S>> {
  const parsed = schema.safeParse(body);
  if (parsed.success) return { ok: true, value: parsed.data };

  const issue = parsed.error.issues[0];
  return {
    ok: false,
    error: {
      code: "INVALID_BODY",
      field: fieldOf(issue),
      message: issue?.message ?? "The request body could not be read.",
    },
  };
}

/**
 * The field a Zod issue is about.
 *
 * A union reports its failure at the root with the branch errors nested underneath, so the path
 * is empty exactly when the body as a whole is wrong — `(body)` says that plainly rather than
 * naming a field at random from one of the branches.
 */
function fieldOf(issue: z.ZodIssue | undefined): string {
  if (issue === undefined || issue.path.length === 0) return "(body)";
  return issue.path.join(".");
}
