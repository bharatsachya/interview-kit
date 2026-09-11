import { KitError, type IdGenerator, type LlmProvider, type Tracer } from "@trao/contracts";
import { runCoverage } from "@trao/coverage";
import {
  createGapFillWriter,
  deriveFlashcards,
  generateBrief,
  generateCategoryQuestions,
  requirementsFor,
  type SourcePage,
} from "@trao/generation";
import {
  commit,
  regenerateCategory,
  type InternalFlashcard,
  type InternalKit,
  type InternalQuestion,
  type QuestionCategory,
  type Requirement,
} from "@trao/kit";
import { reallocateSchedule } from "@trao/scheduling";

/**
 * Regenerating one section of a kit that already exists.
 *
 * The 15-point state problem, from the other end. `generateKit` writes a kit onto a blank page;
 * this rewrites one part of a page the user has been working on. The rule underneath every
 * branch: **a regeneration may only take back what the machine put there and the user has not
 * claimed.** Everything else — edited, manual, pinned, and every other section — comes out the
 * far side byte-identical.
 *
 * Three properties hold across all three branches:
 *
 * 1. **Exactly one version bump.** However many internal steps run, `commit` is reached once, so
 *    a caller holding version 7 sees version 8 and an `ifVersion` check means what it says.
 * 2. **Nothing is deleted.** Replaced questions and their derived flashcards go `active: false`
 *    and keep their ids forever, so no reference can dangle in storage.
 * 3. **The schedule is not touched by the question branch.** Repair belongs at the serialize
 *    boundary, in the projections — not on a write path. A question archived here disappears
 *    from its day when the kit is next projected, and a question added here is placed then too.
 *    Writing to `schedule` from this function is what would wipe a day the user rewrote.
 *
 * The spans mirror the first-generation pipeline, so a regeneration reads in the trace viewer
 * like the steps it replays: `regenerate_section` wrapping `generate_brief`, or
 * `generate_questions > category:<name>` then `coverage > coverage_check` then any `gap_fill`.
 */

export type RegenerateSectionName = "company_brief" | "questions" | "schedule";

export interface RegenerateRequest {
  section: RegenerateSectionName;
  /** Required when `section` is `"questions"`, meaningless otherwise. */
  category?: QuestionCategory;
}

/**
 * Deliberately narrower than `PipelineDeps`, and structurally satisfied by it, so the API route
 * can pass the deps it already built.
 *
 * No fetcher and no search provider: regeneration re-runs generation over what the first run
 * retrieved, and never goes back out to the network. Re-crawling on a button press would cost a
 * user their rate limit to produce a brief from pages that have not changed since this morning.
 */
export interface RegenerateDeps {
  llm: LlmProvider;
  ids: IdGenerator;
  tracer: Tracer;
  questionsPerCategory?: number;
  maxCoveragePasses?: number;
  /** The version the caller believes the kit is on. Forwarded to `commit`. */
  ifVersion?: number;
}

export async function regenerateSection(
  kit: InternalKit,
  request: RegenerateRequest,
  deps: RegenerateDeps,
): Promise<InternalKit> {
  return deps.tracer.span("regenerate_section", async (root) => {
    root.setAll({
      section: request.section,
      version_before: kit.version,
      ...(request.category !== undefined ? { category: request.category } : {}),
    });

    // Ids are never reused. That is a property of the document, not of whichever generator the
    // caller happened to pass, so it is enforced here rather than assumed. See `UnusedIds`.
    const ids = new UnusedIds(deps.ids, kit);
    const safe: RegenerateDeps = { ...deps, ids };

    try {
      switch (request.section) {
        case "company_brief":
          return await regenerateBrief(kit, safe);
        case "schedule":
          return await regenerateSchedule(kit, safe);
        case "questions": {
          if (request.category === undefined) {
            throw new KitError("INVALID_INPUT", "Regenerating questions needs a category.");
          }
          root.set("category", request.category);
          return await regenerateQuestions(kit, request.category, safe);
        }
      }
    } finally {
      // Zero on a correctly wired caller. Anything else says the generator it passed is minting
      // names this kit already holds, which is worth seeing before it becomes a support ticket.
      if (ids.skipped > 0) root.set("ids_skipped", ids.skipped);
    }
  });
}

/**
 * The caller's generator, minus any name this kit already holds.
 *
 * Soft delete is the reason. Nothing is ever removed from a kit and no id is ever reused, which
 * is what makes a dangling reference impossible in storage — and a generator that hands back an
 * id already in use turns that guarantee inside out. The new question does not replace the old
 * one, it sits beside it: two records, one id, `byId` maps silently keeping whichever came last,
 * and a schedule day that no longer says which of the two it meant.
 *
 * It is not a hypothetical. A composition root that builds a fresh `SequentialIdGenerator` per
 * job — which is exactly what `--fake-llm` did — starts counting at `q1` against a kit whose
 * first question is `q1`. The generator is not wrong in isolation; it simply has no idea a
 * document already exists. Nothing downstream notices, because nothing downstream is looking.
 *
 * So the invariant is enforced where the document is, not left to each caller to remember: three
 * call sites needed this independently and two of them got it wrong. Skipping rather than
 * throwing keeps a merely misconfigured caller working, since the right answer is obvious and
 * costs one loop; `ids_skipped` on the span is what stops that being invisible.
 */
class UnusedIds implements IdGenerator {
  skipped = 0;
  readonly #taken: Set<string>;

  constructor(
    private readonly inner: IdGenerator,
    kit: InternalKit,
  ) {
    this.#taken = new Set<string>([
      ...kit.questions.map((q) => q.id),
      ...kit.flashcards.map((f) => f.id),
      ...kit.requirements.map((r) => r.id),
      kit.id,
    ]);
  }

  next(prefix: string): string {
    for (;;) {
      const id = this.inner.next(prefix);
      if (this.#taken.has(id)) {
        this.skipped += 1;
        continue;
      }
      this.#taken.add(id);
      return id;
    }
  }
}

// ── company_brief ────────────────────────────────────────────────────────────────────────

/**
 * Re-run `generate_brief` over the pages the first run already read. One call, nothing else
 * touched.
 *
 * Every field that records *what was retrieved* — `sources`, `pagesUsed`, `passages`, `gaps` —
 * is carried over verbatim, because regeneration retrieves nothing. Recomputing them would
 * quietly rewrite the provenance record: `sources` would lose the discussion results this
 * function never saw, and `gaps` would gain "no public discussion was retrieved" for a kit where
 * some had been. Only the prose the model writes is replaced.
 */
async function regenerateBrief(kit: InternalKit, deps: RegenerateDeps): Promise<InternalKit> {
  const stored = kit.companyBrief;

  const fresh = await deps.tracer.span("generate_brief", async (s) => {
    const pages = passagesOf(stored);
    s.setAll({ pages_in: pages.length, regenerated: true });

    const result = await generateBrief({
      company: kit.role.company,
      roleTitle: kit.role.title,
      pages,
      // Search results are not kept on the kit, only the URLs they contributed to `sources`.
      // Passing none is honest rather than convenient: the brief is rewritten from the company's
      // own pages, and `gaps` below still carries whatever the first run recorded.
      discussion: [],
      llm: deps.llm,
    });

    s.setAll({
      output_chars: result.brief.summary.length + result.brief.whatTheyDo.length,
      wrote_without_model: result.fabricationAvoided,
      cache_hit: result.cacheHit,
    });
    return result.brief;
  });

  return commit(
    kit,
    { ...(deps.ifVersion !== undefined ? { ifVersion: deps.ifVersion } : {}) },
    {
      companyBrief: {
        summary: fresh.summary,
        whatTheyDo: fresh.whatTheyDo,
        hiringProcess: fresh.hiringProcess,
        sources: stored.sources,
        pagesUsed: stored.pagesUsed,
        ...(stored.passages !== undefined ? { passages: stored.passages } : {}),
        gaps: stored.gaps,
        // The machine wrote this one, whatever was here before. A user who had edited the brief
        // and then asked for it to be regenerated gets the regeneration they asked for.
        origin: "generated",
        edited: false,
      },
    },
  );
}

/**
 * The page text the brief was written from.
 *
 * Falls back to the URL list for a kit stored before `passages` existed. A brief regenerated from
 * bare URLs is thin rather than wrong — `generateBrief` sees pages with no body, and its own
 * empty-context guard is what decides whether a model call is worth making.
 */
function passagesOf(brief: InternalKit["companyBrief"]): SourcePage[] {
  if (brief.passages !== undefined && brief.passages.length > 0) return brief.passages.map((p) => ({ ...p }));
  return brief.pagesUsed.map((url) => ({ url, title: "", text: "" }));
}

// ── schedule ─────────────────────────────────────────────────────────────────────────────

/**
 * Pure. Zero model calls — the brief says twice that allocating topics across days is the
 * application's job, and that does not stop being true because the user pressed a button.
 *
 * Days the user edited are returned byte-for-byte: focus, question ids and minutes. Everything
 * not sitting on one of those days is reallocated across the rest.
 */
async function regenerateSchedule(kit: InternalKit, deps: RegenerateDeps): Promise<InternalKit> {
  const schedule = await deps.tracer.span("allocate_schedule", async (s) => {
    const result = reallocateSchedule(kit.schedule, {
      questions: kit.questions,
      requirements: kit.requirements,
    });
    s.setAll({
      days: `${result.days.length}/${result.daysAvailable}`,
      preserved_days: result.days.filter((d) => d.edited).length,
      placed: new Set(result.days.flatMap((d) => d.questionIds)).size,
      minutes: result.days.reduce((total, day) => total + day.minutes, 0),
    });
    return result;
  });

  return commit(kit, { ...(deps.ifVersion !== undefined ? { ifVersion: deps.ifVersion } : {}) }, { schedule });
}

// ── questions ────────────────────────────────────────────────────────────────────────────

async function regenerateQuestions(
  kit: InternalKit,
  category: QuestionCategory,
  deps: RegenerateDeps,
): Promise<InternalKit> {
  // What the regeneration is entitled to take back, decided before anything is generated,
  // because what is left is what decides what to ask for.
  const disposable = new Set(
    kit.questions.filter((q) => q.active && q.category === category && q.origin === "generated" && !q.pinned).map((q) => q.id),
  );
  const surviving = kit.questions.filter((q) => q.active && !disposable.has(q.id));

  const seed = seedFor(category, kit.requirements, surviving);

  const generated = await deps.tracer.span("generate_questions", async (s) => {
    s.setAll({ category, seeded_requirements: seed.map((r) => r.id), survivors: surviving.length });
    const result = await generateCategoryQuestions(category, {
      requirements: seed,
      roleTitle: kit.role.title,
      company: kit.role.company,
      hiringProcess: kit.companyBrief.hiringProcess,
      companySummary: kit.companyBrief.summary,
      responsibilities: kit.role.responsibilities,
      llm: deps.llm,
      ids: deps.ids,
      span: s,
      // The seed is a gap list here, not a section brief. See `autoTagSingleSeed`.
      autoTagSingleSeed: false,
      ...(deps.questionsPerCategory !== undefined ? { perCategory: deps.questionsPerCategory } : {}),
    });
    s.set("questions_out", result.drafts.length);
    return result;
  });

  // The one `commit` for this call. `regenerateCategory` owns the provenance rule — only
  // unpinned generated questions in this category are archived, and their derived cards go with
  // them unless the user claimed those too — and appends the new questions after the survivors.
  const replaced = regenerateCategory(
    kit,
    category,
    generated.drafts.map((draft) => ({
      id: deps.ids.next("q"),
      prompt: draft.prompt,
      answerOutline: draft.answerOutline,
      difficulty: draft.difficulty,
      requirementIds: draft.requirementIds,
    })),
    { ...(deps.ifVersion !== undefined ? { ifVersion: deps.ifVersion } : {}) },
  );

  // Coverage runs over the WHOLE kit, not just this category. Archiving the only question that
  // covered a must-have is exactly the situation the second pass exists for, and it does not
  // care which section the hole appeared in.
  const active = replaced.questions.filter((q) => q.active);
  const activeIds = new Set(active.map((q) => q.id));

  const coverage = await deps.tracer.span("coverage", async (s) => {
    const result = await runCoverage({
      requirements: kit.requirements,
      questions: active,
      roleTitle: kit.role.title,
      ...(kit.companyBrief.hiringProcess.trim().length > 0 ? { hiringProcess: kit.companyBrief.hiringProcess } : {}),
      ids: deps.ids,
      writer: createGapFillWriter({ llm: deps.llm }),
      span: s,
      // Questions already in this kit were admitted when they were written. See `gateTags`.
      gateTags: false,
      ...(deps.maxCoveragePasses !== undefined ? { maxExtraPasses: deps.maxCoveragePasses } : {}),
    });
    s.setAll({ passes: result.passes, fallbacks: result.fallbackCount, uncovered: result.uncoveredRequirementIds });
    return result;
  });

  const filled = coverage.questions.filter((q) => !activeIds.has(q.id));

  // Cards for everything new, and only for everything new. Re-deriving the whole bank would mint
  // fresh ids for cards the user has been practising against and reset their confidence history.
  const added = replaced.questions.filter((q) => q.active && !kit.questions.some((old) => old.id === q.id));
  const cards = await deps.tracer.span("derive_flashcards", async (s) => {
    const derived = deriveFlashcards([...added, ...filled], deps.ids);
    s.set("count", derived.length);
    return derived;
  });

  const cardOrder = maxOrder(replaced.flashcards) + 1;

  return {
    ...replaced,
    questions: [...replaced.questions, ...filled],
    flashcards: [
      ...replaced.flashcards,
      ...cards.map((card, index): InternalFlashcard => ({ ...card, order: cardOrder + index })),
    ],
    coverage: { passes: coverage.passes, uncoveredRequirementIds: coverage.uncoveredRequirementIds },
  };
}

/**
 * What this category's call is seeded with.
 *
 * The requirements of the kinds this category draws on that **nothing still active covers** —
 * so a regeneration asks about the holes the archiving just opened, rather than re-asking about
 * a requirement the user's pinned question already answers. Handing the model the full list
 * would spend the call producing near-duplicates of the questions that were kept.
 *
 * When the survivors cover everything, the full category list comes back. The user pressed
 * regenerate and is owed questions; "nothing was uncovered, so here is nothing" is a correct
 * reading of the gap list and a broken button.
 *
 * Note what is NOT here: a promise that the returned questions cover the seed. Coverage decides
 * that afterwards, by a set difference, on its own evidence.
 */
function seedFor(
  category: QuestionCategory,
  requirements: readonly Requirement[],
  surviving: readonly InternalQuestion[],
): Requirement[] {
  const ofCategory = requirementsFor(category, requirements);
  const covered = new Set(surviving.flatMap((q) => q.requirementIds));
  const uncovered = ofCategory.filter((r) => !covered.has(r.id));
  return uncovered.length > 0 ? uncovered : ofCategory;
}

function maxOrder(items: readonly { order: number }[]): number {
  return items.reduce((max, item) => Math.max(max, item.order), -1);
}
