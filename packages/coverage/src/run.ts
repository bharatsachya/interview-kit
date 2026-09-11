import { NOOP_SPAN, type IdGenerator, type SpanHandle } from "@trao/contracts";
import type { Difficulty, InternalQuestion, QuestionCategory, Requirement } from "@trao/kit";
import { clusterRequirements } from "./cluster";
import { detectGaps, type CoverageGaps } from "./detect";
import { fallbackQuestion } from "./fallback";
import { acceptGapFill, gateQuestionTags, type GateRejection, type TagGateResult } from "./gates";

/**
 * The coverage loop: check, fill, re-check.
 *
 * The model is asked for question *text* and nothing else. The code attaches `requirement_ids`,
 * because the code is the one that chose the cluster and asked. That costs more calls than
 * batching, which is why it applies to gap fill — where gaps are few — rather than to bulk
 * generation.
 *
 * No tracer here. The package stays pure and returns a per-pass report; the pipeline turns that
 * into `coverage_check pass=n` and `gap_fill r3` spans. Coverage may only import contracts and
 * kit, and NoopTracer lives in kernel.
 */

/**
 * What gap fill asks the model for. Note what is absent: requirement ids. The writer is never
 * told to label its own output, so it cannot mislabel it.
 */
export interface GapFillRequest {
  requirements: readonly Requirement[];
  roleTitle: string;
  /** What the company publishes about how it interviews, when a hiring page was found. */
  hiringProcess?: string;
}

export interface GapFillDraft {
  prompt: string;
  answerOutline: string;
  difficulty: Difficulty;
  category?: QuestionCategory;
  /** Ignored for labelling; only checked, so a volunteered id that we did not supply is caught. */
  requirementIds?: string[];
}

/** Returns null when the model produced nothing usable — a failure here is never fatal. */
export type GapFillWriter = (request: GapFillRequest) => Promise<GapFillDraft | null>;

export interface CoverageRunInput {
  requirements: readonly Requirement[];
  questions: readonly InternalQuestion[];
  roleTitle: string;
  hiringProcess?: string;
  ids: IdGenerator;
  writer: GapFillWriter;
  maxExtraPasses?: number;
  maxAttemptsPerRequirement?: number;
  /**
   * The parent span, so each check and each fill is recorded while it runs.
   *
   * This package used to return `reports` and let the pipeline replay them as spans afterwards,
   * which kept coverage free of any tracing dependency. It also produced a trace that lied: the
   * checks came out as 0ms annotations timestamped after the work, so `coverage_check pass=1`
   * appeared 2.5 seconds AFTER the gap-fill calls it had triggered. Read cold, the trace said
   * fills happened before any check — undermining the one thing it exists to evidence.
   *
   * A `SpanHandle` rather than a `Tracer`: the caller already owns the parent span, `child()` is
   * scoped so the work happens inside it, and any LLM call made in there nests underneath
   * automatically. `reports` is still returned, for callers that want the data rather than a
   * trace.
   */
  span?: SpanHandle;
  /**
   * Whether to re-judge the `requirementIds` already on the questions handed in.
   *
   * True on a first generation, where every question is model output arriving for the first time
   * and `gateQuestionTags` is the admission control on its claims.
   *
   * False when regenerating one section of a kit that already exists, for two separate reasons.
   *
   * The gate is not idempotent against a *stored* question the way it is against a fresh one:
   * it judges the question's text against the requirement's source sentence, and a question the
   * user has since rewritten no longer reads like the sentence it was generated from. Re-running
   * it on every regeneration means a question the user edited quietly loses the requirement it
   * covers, on a regeneration of a different category, with nothing in the UI to say why. A
   * question already in the kit has been admitted; coverage's job from then on is to count.
   *
   * And it is only a shared-term threshold. That is the right trade for admission — cheap,
   * deterministic, inspectable — but its false negatives are real: "PostgreSQL query tuning" and
   * a question about `Postgres` index bloat share no token, so the gate reads a perfectly good
   * question as covering nothing. Paying that cost once, when the question enters, is
   * proportionate. Paying it again on every later regeneration is how a kit erodes.
   *
   * Gap fill's own gates (`acceptGapFill`) are unaffected and always run: that answer IS fresh
   * model output, and it is the one place a hallucinated id could still get in.
   */
  gateTags?: boolean;
}

export interface GapFillAttempt {
  requirementIds: string[];
  accepted: boolean;
  reason?: GateRejection | "writer_returned_nothing" | "writer_threw";
  questionId?: string;
}

export interface PassReport {
  /** 1-based. Pass 1 is the initial check, before any gap fill has run. */
  pass: number;
  mustCount: number;
  coveredCount: number;
  gapIds: string[];
  attempts: GapFillAttempt[];
}

export interface RetagReport {
  questionId: string;
  kept: string[];
  dropped: TagGateResult["dropped"];
}

export interface CoverageRunResult {
  /** The original questions plus anything gap fill or fallback added. */
  questions: InternalQuestion[];
  /** How many times coverage_check actually ran. Never rounded up. */
  passes: number;
  /** Must-haves still uncovered after fallback, then every uncovered nice-to-have. */
  uncoveredRequirementIds: string[];
  /** One entry per coverage_check, for the trace. */
  reports: PassReport[];
  fallbackCount: number;
  /**
   * Questions whose `requirement_ids` were trimmed before the first check, and why.
   *
   * Worth reporting rather than doing silently: a requirement moving back into the gap list
   * because its only question merely name-dropped it is the single most surprising thing this
   * package does, and the trace should say so.
   */
  retagged: RetagReport[];
}

export const DEFAULT_MAX_EXTRA_PASSES = 2;
export const DEFAULT_MAX_ATTEMPTS_PER_REQUIREMENT = 2;

export async function runCoverage(input: CoverageRunInput): Promise<CoverageRunResult> {
  const maxExtraPasses = input.maxExtraPasses ?? DEFAULT_MAX_EXTRA_PASSES;
  const maxAttempts = input.maxAttemptsPerRequirement ?? DEFAULT_MAX_ATTEMPTS_PER_REQUIREMENT;
  const span = input.span ?? NOOP_SPAN;

  const byId = new Map(input.requirements.map((r) => [r.id, r]));
  const attemptsPerRequirement = new Map<string, number>();
  const reports: PassReport[] = [];

  // Gate every question's tags BEFORE the first check, bulk and gap-fill alike. Without this the
  // first coverage_check is a set difference over claims rather than over coverage, and a
  // question that named five requirements in passing closes five gaps that were never closed.
  const retagged: RetagReport[] = [];
  const questions: InternalQuestion[] = input.questions.map((question) => {
    if (input.gateTags === false) return question;
    const verdict = gateQuestionTags(question, byId);
    if (verdict.dropped.length > 0) {
      retagged.push({ questionId: question.id, kept: verdict.kept, dropped: verdict.dropped });
    }
    return verdict.kept.length === question.requirementIds.length
      ? question
      : { ...question, requirementIds: verdict.kept };
  });

  let gaps = await span.child("coverage_check pass=1", async (c) => {
    const found = detectGaps(input.requirements, questions);
    c.setAll({ musts: mustCount(input.requirements), covered: coveredCount(input.requirements, found), gaps: found.uncoveredMustIds });
    if (retagged.length > 0) c.set("retagged_questions", retagged.length);
    return found;
  });
  reports.push(report(1, input.requirements, gaps, []));

  let extraPasses = 0;
  while (gaps.uncoveredMustIds.length > 0 && extraPasses < maxExtraPasses) {
    // One stubborn requirement must not eat the whole budget.
    const eligible = gaps.uncoveredMustIds
      .filter((id) => (attemptsPerRequirement.get(id) ?? 0) < maxAttempts)
      .map((id) => byId.get(id))
      .filter((r): r is Requirement => r !== undefined);

    if (eligible.length === 0) break;

    extraPasses += 1;
    const attempts: GapFillAttempt[] = [];
    let closed = 0;

    for (const cluster of clusterRequirements(eligible)) {
      const clusterIds = cluster.map((r) => r.id);
      for (const id of clusterIds) attemptsPerRequirement.set(id, (attemptsPerRequirement.get(id) ?? 0) + 1);

      const outcome = await span.child(`gap_fill ${clusterIds.join("+")}`, async (c) => {
        const written = await write(input, cluster);
        if (written === null) {
          c.setAll({ accepted: false, reason: "writer_returned_nothing" });
          c.skip("writer_returned_nothing");
          return { draft: null, reason: "writer_returned_nothing" as const };
        }

        const gate = acceptGapFill({
          prompt: written.prompt,
          ...(written.requirementIds !== undefined ? { claimedRequirementIds: written.requirementIds } : {}),
          cluster,
          existingQuestions: questions,
        });

        c.set("accepted", gate.accepted);
        if (!gate.accepted) {
          c.set("reason", gate.reason);
          c.skip(gate.reason);
          return { draft: null, reason: gate.reason };
        }
        return { draft: written, reason: null };
      });

      if (outcome.draft === null) {
        attempts.push({ requirementIds: clusterIds, accepted: false, reason: outcome.reason });
        continue;
      }
      const draft = outcome.draft;

      // The code attaches the ids, because the code chose the cluster.
      const question = buildQuestion(input.ids, {
        prompt: draft.prompt,
        answerOutline: draft.answerOutline,
        difficulty: draft.difficulty,
        // The requirement's kind decides the category, not the model. A gap fill for
        // "mentoring junior engineers" produces a behavioural-shaped question, and letting a
        // volunteered `category` put it in the technical section would mean the technical
        // section is not technical.
        category: categoryForKind(cluster),
        requirementIds: clusterIds,
        origin: "generated",
        order: questions.length,
      });

      questions.push(question);
      attempts.push({ requirementIds: clusterIds, accepted: true, questionId: question.id });
      closed += clusterIds.length;
    }

    const pass = reports.length + 1;
    gaps = await span.child(`coverage_check pass=${pass}`, async (c) => {
      const found = detectGaps(input.requirements, questions);
      c.setAll({ musts: mustCount(input.requirements), covered: coveredCount(input.requirements, found), gaps: found.uncoveredMustIds });
      return found;
    });
    reports.push(report(pass, input.requirements, gaps, attempts));

    // A pass that closed nothing will not do better next time.
    if (closed === 0) break;
  }

  // Whatever is still uncovered and must-have gets a question built in code.
  let fallbackCount = 0;
  for (const id of gaps.uncoveredMustIds) {
    const requirement = byId.get(id);
    if (!requirement) continue;

    const draft = fallbackQuestion(requirement, input.roleTitle);
    questions.push(
      buildQuestion(input.ids, {
        prompt: draft.prompt,
        answerOutline: draft.answerOutline,
        difficulty: draft.difficulty,
        category: draft.category,
        requirementIds: draft.requirementIds,
        origin: "fallback",
        order: questions.length,
      }),
    );
    fallbackCount += 1;
  }

  const finalGaps = fallbackCount > 0 ? detectGaps(input.requirements, questions) : gaps;

  return {
    questions,
    passes: reports.length,
    // Nice-to-haves stay in the list so the field means something.
    uncoveredRequirementIds: [...finalGaps.uncoveredMustIds, ...finalGaps.uncoveredNiceIds],
    reports,
    fallbackCount,
    retagged,
  };
}

async function write(input: CoverageRunInput, cluster: readonly Requirement[]): Promise<GapFillDraft | null> {
  try {
    return await input.writer({
      requirements: cluster,
      roleTitle: input.roleTitle,
      ...(input.hiringProcess !== undefined ? { hiringProcess: input.hiringProcess } : {}),
    });
  } catch {
    // A writer that throws leaves the gap open. Never fatal — the fallback still runs.
    return null;
  }
}

function mustCount(requirements: readonly Requirement[]): number {
  return requirements.filter((r) => r.priority === "must").length;
}

function coveredCount(requirements: readonly Requirement[], gaps: CoverageGaps): number {
  return mustCount(requirements) - gaps.uncoveredMustIds.length;
}

function report(
  pass: number,
  requirements: readonly Requirement[],
  gaps: CoverageGaps,
  attempts: GapFillAttempt[],
): PassReport {
  const mustCount = requirements.filter((r) => r.priority === "must").length;
  return {
    pass,
    mustCount,
    coveredCount: mustCount - gaps.uncoveredMustIds.length,
    gapIds: [...gaps.uncoveredMustIds],
    attempts,
  };
}

interface QuestionDraft {
  prompt: string;
  answerOutline: string;
  difficulty: Difficulty;
  category: QuestionCategory;
  requirementIds: string[];
  origin: InternalQuestion["origin"];
  order: number;
}

function buildQuestion(ids: IdGenerator, draft: QuestionDraft): InternalQuestion {
  return {
    id: ids.next("q"),
    category: draft.category,
    prompt: draft.prompt.trim(),
    answerOutline: draft.answerOutline.trim(),
    difficulty: draft.difficulty,
    requirementIds: [...draft.requirementIds],
    origin: draft.origin,
    pinned: false,
    active: true,
    order: draft.order,
  };
}

const KIND_CATEGORY: Readonly<Record<Requirement["kind"], QuestionCategory>> = {
  technical: "technical",
  behavioural: "behavioural",
  domain: "company-fit",
};

function categoryForKind(cluster: readonly Requirement[]): QuestionCategory {
  return KIND_CATEGORY[(cluster[0] as Requirement).kind];
}
