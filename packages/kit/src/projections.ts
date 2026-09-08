import { KitError } from "@trao/contracts";
import { kitJsonSchema, validateKitJSON, type KitJSON } from "./appendix-a";
import { repairSchedule } from "./repair";
import { QUESTION_CATEGORIES, type InternalKit, type InternalQuestion } from "./types";

/**
 * The two projections.
 *
 * Both run repair, so the two views can never disagree and no kit ever looks half-built: the
 * schedule the user sees in the builder is the schedule that gets exported.
 */

/**
 * What the API serves to the UI: active items only, provenance flags intact, schedule repaired.
 *
 * Same camelCase shape as storage, minus everything archived. The builder needs `origin`,
 * `pinned` and `active` to decide what a regeneration may take away.
 */
export type BuilderKit = InternalKit;

export function getKitForBuilder(kit: InternalKit): BuilderKit {
  const questions = sortQuestions(kit.questions.filter((q) => q.active));
  const flashcards = kit.flashcards.filter((f) => f.active).sort((a, b) => a.order - b.order);

  return {
    ...kit,
    questions,
    flashcards,
    schedule: repairSchedule(kit.schedule, kit.questions),
  };
}

/**
 * What batch output and export produce: active only, schedule repaired, provenance stripped,
 * validated against Appendix A.
 *
 * Every output field is written by hand rather than spread from the internal object. A
 * passthrough plus a delete-list is how `pinned: true` eventually ships to a grader — with
 * explicit construction, a field that is not named here cannot leak.
 *
 * Throws `KIT_VALIDATION_FAILED` on an invalid kit, which is always our bug rather than the
 * user's. Callers that must record instead of crash use `tryToKitJSON`.
 */
export function toKitJSON(kit: InternalKit): KitJSON {
  const result = tryToKitJSON(kit);
  if (!result.ok) {
    throw new KitError("KIT_VALIDATION_FAILED", `Kit ${kit.id} failed Appendix A validation.`, {
      details: { errors: result.errors },
    });
  }
  return result.kit;
}

export type ToKitJSONResult = { ok: true; kit: KitJSON; errors: [] } | { ok: false; kit: null; errors: string[] };

export function tryToKitJSON(kit: InternalKit): ToKitJSONResult {
  const activeQuestions = sortQuestions(kit.questions.filter((q) => q.active));
  const activeQuestionIds = new Set(activeQuestions.map((q) => q.id));
  const requirementIds = new Set(kit.requirements.map((r) => r.id));
  const schedule = repairSchedule(kit.schedule, kit.questions);

  const candidate = {
    id: kit.id,
    role: {
      title: kit.role.title,
      company: kit.role.company,
      location: kit.role.location,
      summary: kit.role.summary,
    },
    company_brief: {
      summary: kit.companyBrief.summary,
      what_they_do: kit.companyBrief.whatTheyDo,
      hiring_process: kit.companyBrief.hiringProcess,
      sources: [...kit.companyBrief.sources],
      pages_used: [...kit.companyBrief.pagesUsed],
      gaps: [...kit.companyBrief.gaps],
    },
    requirements: kit.requirements.map((r) => ({
      id: r.id,
      text: r.text,
      kind: r.kind,
      priority: r.priority,
    })),
    questions: activeQuestions.map((q) => ({
      id: q.id,
      category: q.category,
      prompt: q.prompt,
      answer_outline: q.answerOutline,
      difficulty: q.difficulty,
      // A requirement is never deleted, but an id that no longer resolves would fail
      // validation for a reason the reader cannot act on. Drop it and let coverage report it.
      requirement_ids: q.requirementIds.filter((id) => requirementIds.has(id)),
    })),
    flashcards: kit.flashcards
      .filter((f) => f.active)
      .sort((a, b) => a.order - b.order)
      .map((f) => ({
        id: f.id,
        front: f.front,
        back: f.back,
        requirement_ids: f.requirementIds.filter((id) => requirementIds.has(id)),
      })),
    schedule: {
      days_available: schedule.daysAvailable,
      days: [...schedule.days]
        .sort((a, b) => a.day - b.day)
        .map((d) => ({
          day: d.day,
          focus: d.focus,
          question_ids: d.questionIds.filter((id) => activeQuestionIds.has(id)),
          minutes: d.minutes,
        })),
    },
    coverage: {
      passes: kit.coverage.passes,
      uncovered_requirement_ids: kit.coverage.uncoveredRequirementIds.filter((id) => requirementIds.has(id)),
    },
  };

  const validation = validateKitJSON(candidate);
  if (!validation.ok) return { ok: false, kit: null, errors: validation.errors };

  // Parse rather than cast, so the returned object is the schema's own output.
  return { ok: true, kit: kitJsonSchema.parse(candidate), errors: [] };
}

/** Stable order: by category as listed in the spec, then the user's ordering, then id. */
function sortQuestions(questions: InternalQuestion[]): InternalQuestion[] {
  return [...questions].sort((a, b) => {
    const byCategory = QUESTION_CATEGORIES.indexOf(a.category) - QUESTION_CATEGORIES.indexOf(b.category);
    if (byCategory !== 0) return byCategory;
    if (a.order !== b.order) return a.order - b.order;
    return a.id.localeCompare(b.id);
  });
}
