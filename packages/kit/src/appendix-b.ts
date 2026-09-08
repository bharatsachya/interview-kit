/**
 * APPENDIX B — THE BATCH INPUT AND OUTPUT SHAPES.
 *
 * ────────────────────────────────────────────────────────────────────────────────────────
 * Every Appendix B field name in the codebase appears in this file and nowhere else.
 * ────────────────────────────────────────────────────────────────────────────────────────
 *
 * This lives beside `appendix-a.ts` because the two are the same kind of thing: the frozen
 * shapes the assessment hands us and grades us against. Keeping the spec in one package means
 * a field name has one definition, and `scripts/evaluate.ts` and the web app's multi-role
 * upload parse the same bytes with the same code rather than agreeing by coincidence.
 *
 * The input parser is deliberately strict about ids. The output is "one entry per input case,
 * keyed by the given id" — two cases sharing an id make that impossible to satisfy, and the
 * failure would surface as a silently short `kits` array rather than as a bad input file.
 */

import { z } from "zod";
import { kitJsonSchema } from "./appendix-a";

/** [SPEC] `[{ "id": "case-01", "jd": "...", "company_url": "...", "days": 5 }]` */
const evaluationCaseSchema = z
  .object({
    id: z.string().min(1), // [SPEC] the output is keyed by this
    jd: z.string().min(1), // [SPEC] the job description, verbatim
    company_url: z.string().url(), // [SPEC] may be a loopback URL — see ALLOW_PRIVATE_HOSTS
    days: z.number().int().min(1), // [SPEC] days until the interview, used as given
  })
  .strict();

export type EvaluationCase = z.infer<typeof evaluationCaseSchema>;

const evaluationCasesSchema = z.array(evaluationCaseSchema).min(1);

export type ParseCasesResult =
  | { ok: true; cases: EvaluationCase[]; errors: [] }
  | { ok: false; cases: null; errors: string[] };

/**
 * Parse a cases.json payload.
 *
 * Returns errors rather than throwing, because both callers need to report them to a person:
 * the batch script prints them, and the upload field shows them next to the file. Messages
 * name the offending case by index and field, since "invalid input" is useless when the file
 * has forty entries.
 */
export function parseCases(value: unknown): ParseCasesResult {
  const parsed = evaluationCasesSchema.safeParse(value);
  if (!parsed.success) {
    return {
      ok: false,
      cases: null,
      errors: parsed.error.issues.map((issue) => {
        const path = issue.path.length > 0 ? issue.path.join(".") : "(root)";
        return `${path}: ${issue.message}`;
      }),
    };
  }

  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const item of parsed.data) {
    if (seen.has(item.id)) duplicates.add(item.id);
    seen.add(item.id);
  }
  if (duplicates.size > 0) {
    return {
      ok: false,
      cases: null,
      errors: [...duplicates].map((id) => `duplicate case id: ${id}`),
    };
  }

  return { ok: true, cases: parsed.data, errors: [] };
}

/** Convenience for the two callers that hold the file as text rather than as a parsed value. */
export function parseCasesJSON(text: string): ParseCasesResult {
  try {
    return parseCases(JSON.parse(text) as unknown);
  } catch (error) {
    return {
      ok: false,
      cases: null,
      errors: [`not valid JSON: ${error instanceof Error ? error.message : String(error)}`],
    };
  }
}

/**
 * [SPEC] The output envelope.
 *
 * `status: "failed"` is reserved for a case no kit could be produced for at all. A case that
 * could only be partially researched is `ok`, with the gaps recorded inside the kit — a missing
 * hiring page is not a failure, and neither is a thin description.
 */
const evaluationResultSchema = z
  .object({
    id: z.string().min(1), // [SPEC] the id from the input case
    status: z.enum(["ok", "failed"]), // [SPEC]
    kit: kitJsonSchema.nullable(), // [SPEC] Appendix A, or null when failed
    error: z
      .object({
        code: z.string().min(1), // [SPEC] e.g. COMPANY_UNREACHABLE
        message: z.string().min(1), // [SPEC]
      })
      .strict()
      .nullable(), // [SPEC]
  })
  .strict();

export const evaluationOutputSchema = z
  .object({
    version: z.literal("1.0"), // [SPEC]
    generated_at: z.string().min(1), // [SPEC] ISO 8601, e.g. 2026-09-01T09:12:44Z
    kits: z.array(evaluationResultSchema), // [SPEC]
  })
  .strict();

export type EvaluationOutput = z.infer<typeof evaluationOutputSchema>;
export type EvaluationResult = z.infer<typeof evaluationResultSchema>;

export type ValidateOutputResult =
  | { ok: true; output: EvaluationOutput; errors: [] }
  | { ok: false; output: null; errors: string[] };

/** Used by the batch script's own tests: the file it writes must satisfy the shape it claims. */
export function validateEvaluationOutput(value: unknown): ValidateOutputResult {
  const parsed = evaluationOutputSchema.safeParse(value);
  if (!parsed.success) {
    return {
      ok: false,
      output: null,
      errors: parsed.error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`),
    };
  }
  return { ok: true, output: parsed.data, errors: [] };
}
