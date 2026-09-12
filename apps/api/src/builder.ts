import { Router, type Request } from "express";
import type { z } from "zod";
import type { Clock, IdGenerator, KitStore } from "@trao/contracts";
import type { Authenticator } from "@trao/auth";
import type { RegenerateResponse } from "@trao/api-contract";
import {
  VersionConflictError,
  addFlashcard,
  addQuestion,
  deleteFlashcard,
  deleteQuestion,
  editBrief,
  editFlashcard,
  editQuestion,
  editScheduleDay,
  moveQuestion,
  pinQuestion,
  reorderQuestions,
  toKitJSON,
  type InternalKit,
  type MutationOptions,
} from "@trao/kit";
import { expectedVersion, guarded, notFound, ownedKit, sendKit, versionConflict } from "./http";
import type { JobRunner } from "./jobs";
import {
  briefPatchSchema,
  flashcardPatchSchema,
  moveSchema,
  newFlashcardSchema,
  newQuestionSchema,
  parseBody,
  pinSchema,
  questionPatchSchema,
  regenerateSchema,
  reorderSchema,
  schedulePatchSchema,
} from "./schemas";

/**
 * The builder's API surface.
 *
 * Fourteen routes that all do the same five things in the same order: authenticate, prove
 * ownership, validate the body, apply one named state transition from `@trao/kit`, hand back the
 * builder projection with the new version in an `ETag`. None of them contains a state rule —
 * what survives a regeneration, what an edit does to provenance, where a moved question lands —
 * because all of that is in `packages/kit`, tested without an HTTP server in front of it.
 *
 * Two design choices are worth naming:
 *
 * **Every write returns the whole kit.** A reorder changes every sibling's index, a delete takes
 * a flashcard and a schedule slot with it, and a regeneration changes three sections at once. A
 * response describing only what was asked for would leave the client to model those consequences
 * a second time, and the two models would disagree the first time a rule changed.
 *
 * **Nothing is a partial write.** A mutation either produces a new kit and is saved whole, or it
 * throws and nothing is stored. There is no route that saves twice.
 */

export interface BuilderDeps {
  auth: Authenticator;
  kits: KitStore<InternalKit>;
  runner: JobRunner;
  ids: IdGenerator;
  clock: Clock;
}

/** Thrown by a mutation that cannot find what the URL names. Becomes a 404 with the right noun. */
class Missing extends Error {
  constructor(readonly what: string) {
    super(`No such ${what}.`);
    this.name = "Missing";
  }
}

export function builderRoutes(deps: BuilderDeps): Router {
  const router = Router();

  // ── Reading ──────────────────────────────────────────────────────────────────────────

  router.get(
    "/kits/:kitId",
    guarded(deps.auth, async (req, res, userId) => {
      const record = await ownedKit(deps.kits, param(req, "kitId"), userId);
      if (record === null) return notFound(res);
      sendKit(res, record.kit);
    }),
  );

  /**
   * The kit as Appendix A, unwrapped.
   *
   * The same projection the batch output uses, so what a user downloads and what a grader runs
   * `npm run evaluate` for are the same bytes produced by the same function. Provenance is
   * stripped and the schedule is repaired on the way out, which is why this is a projection
   * rather than a dump of the stored document.
   */
  router.get(
    "/kits/:kitId/export",
    guarded(deps.auth, async (req, res, userId) => {
      const record = await ownedKit(deps.kits, param(req, "kitId"), userId);
      if (record === null) return notFound(res);

      res
        .status(200)
        .set("etag", `"${record.kit.version}"`)
        .set("cache-control", "no-store")
        .set("content-disposition", `attachment; filename="kit-${record.kit.id}.json"`)
        .json(toKitJSON(record.kit));
    }),
  );

  // ── The company brief ────────────────────────────────────────────────────────────────

  router.patch(
    "/kits/:kitId/brief",
    write(deps, briefPatchSchema, ({ kit, body, options }) =>
      editBrief(
        kit,
        {
          ...(body.summary !== undefined ? { summary: body.summary } : {}),
          ...(body.what_they_do !== undefined ? { whatTheyDo: body.what_they_do } : {}),
          ...(body.hiring_process !== undefined ? { hiringProcess: body.hiring_process } : {}),
        },
        options,
      ),
    ),
  );

  // ── Questions ────────────────────────────────────────────────────────────────────────

  router.post(
    "/kits/:kitId/questions",
    write(deps, newQuestionSchema, ({ kit, body, options }) =>
      addQuestion(
        kit,
        {
          category: body.category,
          prompt: body.prompt,
          answerOutline: body.answer_outline,
          difficulty: body.difficulty,
          requirementIds: body.requirement_ids,
        },
        deps.ids,
        options,
      ),
    ),
    // 201 would be the letter of it, but the body is the whole kit rather than the new question
    // and there is no per-question URL to put in a Location header. 200 says what happened.
  );

  /**
   * Reorder before the per-question routes, so a category called "reorder" is not a possibility
   * anyone has to think about. They differ in depth, but the ordering makes that explicit.
   */
  router.post(
    "/kits/:kitId/questions/reorder",
    write(deps, reorderSchema, ({ kit, body, options }) =>
      reorderQuestions(kit, body.category, body.ids, options),
    ),
  );

  router.patch(
    "/kits/:kitId/questions/:questionId",
    write(deps, questionPatchSchema, ({ kit, body, req, options }) =>
      editQuestion(
        requireQuestion(kit, param(req, "questionId")),
        param(req, "questionId"),
        {
          ...(body.prompt !== undefined ? { prompt: body.prompt } : {}),
          ...(body.answer_outline !== undefined ? { answerOutline: body.answer_outline } : {}),
          ...(body.difficulty !== undefined ? { difficulty: body.difficulty } : {}),
        },
        options,
      ),
    ),
  );

  router.delete(
    "/kits/:kitId/questions/:questionId",
    write(deps, null, ({ kit, req, options }) =>
      deleteQuestion(requireQuestion(kit, param(req, "questionId")), param(req, "questionId"), options),
    ),
  );

  router.post(
    "/kits/:kitId/questions/:questionId/pin",
    write(deps, pinSchema, ({ kit, body, req, options }) =>
      pinQuestion(requireQuestion(kit, param(req, "questionId")), param(req, "questionId"), body.pinned, options),
    ),
  );

  router.post(
    "/kits/:kitId/questions/:questionId/move",
    write(deps, moveSchema, ({ kit, body, req, options }) =>
      moveQuestion(requireQuestion(kit, param(req, "questionId")), param(req, "questionId"), body.to_category, options),
    ),
  );

  // ── Flashcards ───────────────────────────────────────────────────────────────────────

  router.post(
    "/kits/:kitId/flashcards",
    write(deps, newFlashcardSchema, ({ kit, body, options }) =>
      addFlashcard(kit, { front: body.front, back: body.back, requirementIds: body.requirement_ids }, deps.ids, options),
    ),
  );

  router.patch(
    "/kits/:kitId/flashcards/:flashcardId",
    write(deps, flashcardPatchSchema, ({ kit, body, req, options }) =>
      editFlashcard(
        requireFlashcard(kit, param(req, "flashcardId")),
        param(req, "flashcardId"),
        {
          ...(body.front !== undefined ? { front: body.front } : {}),
          ...(body.back !== undefined ? { back: body.back } : {}),
          ...(body.requirement_ids !== undefined ? { requirementIds: body.requirement_ids } : {}),
        },
        options,
      ),
    ),
  );

  router.delete(
    "/kits/:kitId/flashcards/:flashcardId",
    write(deps, null, ({ kit, req, options }) =>
      deleteFlashcard(requireFlashcard(kit, param(req, "flashcardId")), param(req, "flashcardId"), options),
    ),
  );

  // ── The schedule ─────────────────────────────────────────────────────────────────────

  router.patch(
    "/kits/:kitId/schedule/days/:day",
    write(deps, schedulePatchSchema, ({ kit, body, req, options }) => {
      const day = Number(param(req, "day"));
      if (!kit.schedule.days.some((d) => d.day === day)) throw new Missing("day");
      return editScheduleDay(
        kit,
        day,
        {
          ...(body.focus !== undefined ? { focus: body.focus } : {}),
          ...(body.minutes !== undefined ? { minutes: body.minutes } : {}),
          ...(body.question_ids !== undefined ? { questionIds: body.question_ids } : {}),
        },
        options,
      );
    }),
  );

  // ── Regeneration ─────────────────────────────────────────────────────────────────────

  /**
   * Rewrite one section into a new kit, in the background, exactly once.
   *
   * **This route does not write to the kit in its URL.** It reads it, re-runs one section over
   * it, and saves the result as a fork with its own id — returned as `kit_id`, reserved before
   * any model is called. The kit you were looking at keeps its version, its edits and its
   * questions, and stays in the history rail beside the rewrite. That is the whole reason the
   * rewrite is a prompt in the composer rather than a button that changes what is on screen: a
   * generation you cannot undo should not be one click away from work you have been editing.
   *
   * 202 and a job id rather than a finished kit: rewriting the technical questions is several
   * model calls, and the builder must stay usable while it happens. The client watches
   * `/jobs/:id/events` and opens the new kit when the job completes.
   *
   * A second request for the same kit, section, category and instructions while one is running
   * is answered with the same job id and starts nothing. Two sends of a button that takes twenty
   * seconds is the normal case, not the pathological one. Different instructions are a different
   * request and get their own run — they are asking for something else.
   *
   * `If-Match` still means something even though nothing is overwritten: it says "fork the
   * version I am looking at", and a mismatch means the section on screen is not the section that
   * would be rewritten.
   */
  router.post(
    "/kits/:kitId/regenerate",
    guarded(deps.auth, async (req, res, userId) => {
      const record = await ownedKit(deps.kits, param(req, "kitId"), userId);
      if (record === null) return notFound(res);

      const body = parseBody(regenerateSchema, req.body);
      if (!body.ok) return void res.status(400).json(body.error);

      // Checked here rather than forwarded to the job. The guarantee a client wants from
      // `If-Match` on this route is "do not start work on a kit I am no longer looking at" —
      // and by the time the job reaches the front of the queue, a version it was told to
      // expect is a version anything could have moved past. What survives a regeneration is
      // decided by provenance, not by when it was written.
      const version = expectedVersion(req);
      if (version !== undefined && version !== record.kit.version) {
        return versionConflict(res, record.kit.version);
      }

      const instructions = body.value.instructions?.trim();
      const steer = instructions !== undefined && instructions.length > 0 ? { instructions } : {};

      const request = body.value.section === "questions"
        ? { section: "questions" as const, category: body.value.category, ...steer }
        : { section: body.value.section, ...steer };

      // The conversation the source kit is in. A kit written before sessions existed has none,
      // and `buildSessions` groups those under a synthetic `kit:<id>` — passing the same string
      // here puts the rewrite in that same one rather than stranding it in a session of its own.
      const sessionId = record.sessionId ?? `kit:${record.id}`;

      const { jobId, kitId, existing } = await deps.runner.regenerate(userId, record.id, request, sessionId);
      res.status(202).json({
        job_id: jobId,
        kit_id: kitId,
        session_id: sessionId,
        existing,
      } satisfies RegenerateResponse);
    }),
  );

  return router;
}

interface MutationInput<T> {
  kit: InternalKit;
  body: T;
  req: Request;
  options: MutationOptions;
}

/**
 * One write, done the one way.
 *
 * Ownership is checked before the body is looked at. A stranger poking at a kit id should not
 * learn which of their fields was malformed — and more practically, a 400 and a 404 from the
 * same URL would tell them the kit exists.
 *
 * The version check lives inside the mutation rather than here: `commit` in `packages/kit` is
 * the only thing that bumps a version, so making it the only thing that checks one is what stops
 * a mutation from being written that does one and forgets the other.
 */
function write<S extends z.ZodTypeAny>(
  deps: BuilderDeps,
  schema: S | null,
  mutate: (input: MutationInput<z.infer<S>>) => InternalKit,
): ReturnType<typeof guarded> {
  return guarded(deps.auth, async (req, res, userId) => {
    const record = await ownedKit(deps.kits, param(req, "kitId"), userId);
    if (record === null) return notFound(res);

    let body = undefined as z.infer<S>;
    if (schema !== null) {
      const parsed = parseBody(schema, req.body);
      if (!parsed.ok) return void res.status(400).json(parsed.error);
      body = parsed.value;
    }

    const version = expectedVersion(req);
    const options: MutationOptions = version === undefined ? {} : { ifVersion: version };

    let next: InternalKit;
    try {
      next = mutate({ kit: record.kit, body, req, options });
    } catch (error) {
      if (error instanceof VersionConflictError) return versionConflict(res, error.currentVersion);
      if (error instanceof Missing) return notFound(res, error.what);
      throw error;
    }

    await deps.kits.save({ ...record, kit: next, updatedAt: deps.clock.now() });
    sendKit(res, next);
  });
}

/**
 * The kit, if it still has this question.
 *
 * Returned rather than asserted so the call reads as part of the expression it guards. Archived
 * questions count as missing: they are gone from the user's view, and letting an edit land on
 * one would resurrect a question they deleted the moment anything rebuilt the projection.
 */
function requireQuestion(kit: InternalKit, questionId: string): InternalKit {
  if (!kit.questions.some((q) => q.id === questionId && q.active)) throw new Missing("question");
  return kit;
}

function requireFlashcard(kit: InternalKit, flashcardId: string): InternalKit {
  if (!kit.flashcards.some((f) => f.id === flashcardId && f.active)) throw new Missing("flashcard");
  return kit;
}

/** Express types params as possibly-undefined; a route that declared one always has it. */
function param(req: Request, name: string): string {
  return req.params[name] ?? "";
}
