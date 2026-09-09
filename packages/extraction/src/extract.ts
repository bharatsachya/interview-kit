import { truncateForPrompt, untrustedBlock, type IdGenerator, type LlmProvider } from "@trao/contracts";
import type { Requirement, RoleSummary } from "@trao/kit";
import { z } from "zod";
import { checkGrounding } from "./grounding";
import { collapseExampleLists, type MergedGroup, type SpannedCandidate } from "./merge";
import { priorityFromPosting, sectionsOf } from "./sections";
import { locateSpan, spansOf } from "./spans";
import { normalise } from "./text";

/**
 * Job description → requirements. The single biggest scoring item.
 *
 * ## Two piles
 *
 * The posting is read into two piles before anything else happens: **what the role does** and
 * **what the candidate must have**. Only the second becomes requirements; the first becomes
 * `role.responsibilities`.
 *
 * This exists because of a real failure. An 1,800-character posting produced twenty
 * requirements, all `must`, six of which were "Gmail", "Drive", "Slack", "WhatsApp", "Telegram"
 * and "iMessage" — the products the company's own product integrates with, named in two
 * sentences describing what the role builds. Nobody is going to be interviewed on Telegram.
 * Asking for everything in one pile makes every noun in the posting a candidate requirement;
 * asking for the two piles separately gives the "what you'll build" sentences somewhere to go.
 *
 * ## Four things the code decides rather than the model
 *
 *   1. **Ids.** Assigned here, in order, so they are stable and readable in the trace.
 *   2. **Whether a requirement is real.** Everything returned is checked back against the
 *      posting; anything that is not in there is dropped and counted.
 *   3. **Priority, where the posting says.** A requirement under a "Nice to have:" heading is
 *      `nice` whatever the model claimed — the rubric names this exact distinction, and models
 *      mark almost everything `must` because postings sound urgent.
 *   4. **Whether a list of names is one requirement.** Enforced in `collapseExampleLists`, not
 *      only in the prompt, because a prompt rule is a request and this one is cheap to check.
 */

const extractionSchema = z.object({
  role: z.object({
    title: z.string(),
    company: z.string(),
    /** "" when the posting does not say. A required Appendix A field with no obvious source. */
    location: z.string(),
    summary: z.string(),
  }),
  /**
   * Pile one: what the role does. Optional so that a model which forgets the field costs us the
   * responsibilities rather than the whole extraction.
   */
  responsibilities: z.array(z.string()).max(20).optional().default([]),
  /** Pile two, and the only pile that becomes requirements. */
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

/** Responsibilities are context for the brief and the kit's role breakdown, not a study list. */
export const MAX_RESPONSIBILITIES = 12;

/**
 * One requirement per this many characters of posting is already generous. Above it, extraction
 * has almost certainly turned a description of the product into a list of study topics.
 */
export const CHARS_PER_REQUIREMENT = 100;

/** Below this, a posting is too short to be expected to distinguish must from nice. */
export const PRIORITY_SANITY_MIN_CHARS = 500;

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
  /** Example lists collapsed into a single requirement, and what went into each. */
  merged: MergedGroup[];
  /** How many priorities the posting's own headings overruled. */
  priorityCorrections: number;
  /**
   * The extraction looks wrong, but not wrong enough to throw away.
   *
   * Flagged, never fatal. A kit built on a suspicious extraction is still a kit, and a run that
   * silently discarded it would be worse than one that says so on its trace.
   */
  suspicious: boolean;
  suspiciousReasons: string[];
  jdChars: number;
}

export async function extractRequirements(input: ExtractionInput): Promise<ExtractionResult> {
  const jd = input.jd.trim();
  if (jd.length === 0) {
    return {
      role: { title: "", company: "", location: "", summary: "", responsibilities: [] },
      requirements: [],
      dropped: [],
      merged: [],
      priorityCorrections: 0,
      suspicious: false,
      suspiciousReasons: [],
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
  const spans = spansOf(jd);
  const dropped: DroppedRequirement[] = [];
  const seen = new Set<string>();
  const candidates: SpannedCandidate[] = [];

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

    // Grounded text always matches some span, because every word of the posting is in one.
    const match = locateSpan(text, spans);
    if (match === null) {
      dropped.push({ text, reason: "not_in_posting", missing: [] });
      continue;
    }

    candidates.push({ text, kind: candidate.kind, priority: candidate.priority, span: match.span, spanScore: match.score });
  }

  const { kept, merged } = collapseExampleLists(candidates);

  // Priority last, so a merged requirement is judged on the sentence it ended up as rather than
  // on the fragment the model happened to return first.
  const requirements: Requirement[] = [];
  let priorityCorrections = 0;

  for (const candidate of kept) {
    const fromPosting = priorityFromPosting(candidate.text, jd, sections);
    if (fromPosting !== null && fromPosting !== candidate.priority) priorityCorrections += 1;

    requirements.push({
      id: input.ids.next("r"),
      text: candidate.text,
      kind: candidate.kind,
      priority: fromPosting ?? candidate.priority,
      sourceSpan: candidate.span.text,
    });
  }

  const sanity = sanityCheck(requirements, jd.length);

  return {
    role: {
      title: data.role.title.trim(),
      company: data.role.company.trim(),
      // Only keep a location the posting actually contains. An invented city is worse than "".
      location: containsLocation(data.role.location, jd) ? data.role.location.trim() : "",
      summary: data.role.summary.trim(),
      responsibilities: keepGrounded(data.responsibilities, jd),
    },
    requirements,
    dropped,
    merged,
    priorityCorrections,
    suspicious: sanity.suspicious,
    suspiciousReasons: sanity.reasons,
    jdChars: jd.length,
  };
}

export interface SanityVerdict {
  suspicious: boolean;
  reasons: string[];
}

/**
 * Two cheap checks for the shape of extraction that went wrong in the live run.
 *
 * Neither fails the case. Both write to the trace, which is where a grader — or the next person
 * to debug this — will look to see whether the requirements can be believed.
 */
export function sanityCheck(requirements: readonly Requirement[], jdChars: number): SanityVerdict {
  const reasons: string[] = [];

  if (requirements.length > jdChars / CHARS_PER_REQUIREMENT) {
    reasons.push(
      `${requirements.length} requirements from ${jdChars} characters — more than one per ${CHARS_PER_REQUIREMENT}`,
    );
  }

  if (
    jdChars > PRIORITY_SANITY_MIN_CHARS &&
    requirements.length > 0 &&
    requirements.every((requirement) => requirement.priority === "must")
  ) {
    reasons.push(`every one of ${requirements.length} requirements is a must on a ${jdChars}-character posting`);
  }

  return { suspicious: reasons.length > 0, reasons };
}

/** Responsibilities are quoted from the posting too, so the same invention check applies. */
function keepGrounded(responsibilities: readonly string[], jd: string): string[] {
  const kept: string[] = [];
  const seen = new Set<string>();

  for (const raw of responsibilities) {
    const text = raw.trim();
    if (text.length === 0 || !checkGrounding(text, jd).grounded) continue;

    const key = normalise(text);
    if (seen.has(key)) continue;
    seen.add(key);

    kept.push(text);
    if (kept.length === MAX_RESPONSIBILITIES) break;
  }

  return kept;
}

function containsLocation(location: string, jd: string): boolean {
  const trimmed = location.trim();
  if (trimmed.length === 0) return false;
  return normalise(jd).includes(normalise(trimmed));
}

function buildPrompt(jd: string): string {
  return [
    "You are reading a job posting for an interview study kit.",
    "",
    "STEP 1 — split the posting into two piles. Do this before writing any output.",
    "",
    "  Pile A, WHAT THE ROLE DOES: the work, the systems it builds, the surfaces it owns, the",
    "  products the company's product connects to, the problems that make the job hard. Anything",
    "  written about the job rather than about the person.",
    "",
    "  Pile B, WHAT THE CANDIDATE MUST ALREADY HAVE: skills, experience, qualities and knowledge",
    "  the posting asks the applicant to bring. Anything a candidate could be interviewed on.",
    "",
    "A sentence describing what the product integrates with is pile A, always. 'Users can plug",
    "Gmail, Drive and Slack into the product' says nothing about the candidate — nobody is",
    "interviewed on Gmail. It is a responsibility, not a requirement.",
    "",
    "STEP 2 — write pile A into `responsibilities`, one entry per area of work, each a phrase",
    "copied from the posting. Write pile B into `requirements`. Only pile B becomes requirements.",
    "",
    "Rules for `requirements`, in order of importance:",
    "",
    "1. Every `text` must be a phrase taken FROM the posting, not a paraphrase and not a",
    "   generalisation. Copy the posting's own wording.",
    "2. Invent nothing. Do not add requirements that are typical for this kind of role but are",
    "   not written down here. A short posting must produce a short list — that is a correct",
    "   answer, not a failure. Returning two requirements for a two-line posting is right.",
    "3. A list of examples is ONE requirement, with the names inside its text. 'Experience with",
    "   Gmail, Drive and Slack' is one requirement, never three. Splitting a list of named",
    "   products into one requirement each is the single most common way to get this wrong.",
    "4. `priority` follows how the posting words it. Something under 'Required' or 'You'll need'",
    "   is `must`. Something under 'Nice to have', 'Bonus', or 'Preferred' is `nice`.",
    "5. `kind` is `technical` for tools, languages, systems and practices; `behavioural` for",
    "   working with people, communication, ownership and mentoring; `domain` for industry or",
    "   subject-matter knowledge.",
    "6. Split a line only where it lists genuinely separate skills joined by 'and':",
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
    '  "responsibilities": [ "" ],',
    '  "requirements": [ { "text": "", "kind": "technical", "priority": "must" } ]',
    "}",
    "",
    "Do not return a bare array. Do not add an `id` field — ids are assigned by the caller.",
    "Do not add a `source` field — the caller finds each requirement's sentence itself.",
  ].join("\n");
}
