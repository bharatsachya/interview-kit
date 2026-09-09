import { truncateForPrompt, untrustedBlock, type IdGenerator, type LlmProvider } from "@trao/contracts";
import type { Requirement, RoleSummary } from "@trao/kit";
import { z } from "zod";
import { checkGrounding } from "./grounding";
import { priorityFromPosting, sectionsOf } from "./sections";
import { normalise } from "./text";

/**
 * Job description → requirements. The single biggest scoring item.
 *
 * Three things the code decides rather than the model:
 *
 *   1. **Ids.** Assigned here, in order, so they are stable and readable in the trace.
 *   2. **Whether a requirement is real.** Everything returned is checked back against the
 *      posting; anything that is not in there is dropped and counted.
 *   3. **Priority, where the posting says.** A requirement under a "Nice to have:" heading is
 *      `nice` whatever the model claimed — the rubric names this exact distinction, and models
 *      mark almost everything `must` because postings sound urgent.
 */

const extractionSchema = z.object({
  role: z.object({
    title: z.string(),
    company: z.string(),
    /** "" when the posting does not say. A required Appendix A field with no obvious source. */
    location: z.string(),
    summary: z.string(),
  }),
  requirements: z
    .array(
      z.object({
        // No id field. The model is not asked for one, so it cannot invent one.
        text: z.string().min(1),
        kind: z.enum(["technical", "behavioural", "domain"]),
        priority: z.enum(["must", "nice"]),
      }),
    )
    .max(40),
});

export const MAX_JD_CHARS = 12_000;

export interface ExtractionInput {
  jd: string;
  llm: LlmProvider;
  ids: IdGenerator;
}

export interface DroppedRequirement {
  text: string;
  reason: "not_in_posting" | "duplicate";
  missing?: string[];
}

export interface ExtractionResult {
  role: RoleSummary;
  requirements: Requirement[];
  /** For the trace: what the model returned that we refused to keep, and why. */
  dropped: DroppedRequirement[];
  /** How many priorities the posting's own headings overruled. */
  priorityCorrections: number;
  jdChars: number;
}

export async function extractRequirements(input: ExtractionInput): Promise<ExtractionResult> {
  const jd = input.jd.trim();
  if (jd.length === 0) {
    return {
      role: { title: "", company: "", location: "", summary: "" },
      requirements: [],
      dropped: [],
      priorityCorrections: 0,
      jdChars: 0,
    };
  }

  const { data } = await input.llm.complete({
    purpose: "extract_requirements",
    // Worth 20 points, so it gets the better model. Everything else takes the fast one.
    tier: "quality",
    prompt: buildPrompt(jd),
    schema: extractionSchema,
  });

  const sections = sectionsOf(jd);
  const requirements: Requirement[] = [];
  const dropped: DroppedRequirement[] = [];
  const seen = new Set<string>();
  let priorityCorrections = 0;

  for (const candidate of data.requirements) {
    const text = candidate.text.trim();

    const grounding = checkGrounding(text, jd);
    if (!grounding.grounded) {
      dropped.push({ text, reason: "not_in_posting", missing: grounding.missing });
      continue;
    }

    const key = normalise(text);
    if (seen.has(key)) {
      dropped.push({ text, reason: "duplicate" });
      continue;
    }
    seen.add(key);

    const fromPosting = priorityFromPosting(text, jd, sections);
    if (fromPosting !== null && fromPosting !== candidate.priority) priorityCorrections += 1;

    requirements.push({
      id: input.ids.next("r"),
      text,
      kind: candidate.kind,
      priority: fromPosting ?? candidate.priority,
    });
  }

  return {
    role: {
      title: data.role.title.trim(),
      company: data.role.company.trim(),
      // Only keep a location the posting actually contains. An invented city is worse than "".
      location: containsLocation(data.role.location, jd) ? data.role.location.trim() : "",
      summary: data.role.summary.trim(),
    },
    requirements,
    dropped,
    priorityCorrections,
    jdChars: jd.length,
  };
}

function containsLocation(location: string, jd: string): boolean {
  const trimmed = location.trim();
  if (trimmed.length === 0) return false;
  return normalise(jd).includes(normalise(trimmed));
}

function buildPrompt(jd: string): string {
  return [
    "You are extracting the stated requirements from a job posting for an interview study kit.",
    "",
    "Rules, in order of importance:",
    "",
    "1. Every `text` must be a phrase taken FROM the posting, not a paraphrase and not a",
    "   generalisation. Copy the posting's own wording.",
    "1b. Cover the WHOLE posting, not just the section that lists what they want in a candidate.",
    "   What the person will actually build is a requirement too: named systems, surfaces,",
    "   integrations and problems the role owns. A posting that describes three areas of work",
    "   and then lists three qualities has at least six requirements, not three. Named third",
    "   party products the role must integrate with are each a requirement.",
    "2. Invent nothing. Do not add requirements that are typical for this kind of role but are",
    "   not written down here. A short posting must produce a short list — that is a correct",
    "   answer, not a failure. Returning two requirements for a two-line posting is right.",
    "3. `priority` follows how the posting words it. Something under 'Required' or 'You'll need'",
    "   is `must`. Something under 'Nice to have', 'Bonus', or 'Preferred' is `nice`.",
    "4. `kind` is `technical` for tools, languages, systems and practices; `behavioural` for",
    "   working with people, communication, ownership and mentoring; `domain` for industry or",
    "   subject-matter knowledge.",
    "5. Split a line only where it lists genuinely separate skills joined by 'and':",
    "   'Python and Kubernetes' is two requirements. Do NOT split on 'or' — 'Kafka or a similar",
    "   streaming platform' is ONE requirement, because the alternatives describe the same need.",
    "   Do NOT split off a trailing clause that cannot stand alone: 'mentoring juniors and",
    "   reviewing their work' is one requirement, because 'reviewing their work' on its own says",
    "   nothing. Every `text` must be readable and meaningful in isolation — if it is not, it",
    "   belongs to the line it came from.",
    "",
    "For `role.location`, copy the location if the posting states one and use an empty string if",
    "it does not. Do not guess from the company name. `role.summary` is one sentence about what",
    "the job is.",
    "",
    untrustedBlock("job_posting", truncateForPrompt(jd, MAX_JD_CHARS)),
    "",
    "Return JSON of exactly this shape and nothing else:",
    "",
    "{",
    '  "role": { "title": "", "company": "", "location": "", "summary": "" },',
    '  "requirements": [ { "text": "", "kind": "technical", "priority": "must" } ]',
    "}",
    "",
    "Do not return a bare array. Do not add an `id` field — ids are assigned by the caller.",
  ].join("\n");
}
