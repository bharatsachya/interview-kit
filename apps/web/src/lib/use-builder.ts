"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { QuestionCategory } from "@trao/kit";
import {
  deleteFlashcard as applyDeleteFlashcard,
  deleteQuestion as applyDeleteQuestion,
  editBrief as applyEditBrief,
  editFlashcard as applyEditFlashcard,
  editQuestion as applyEditQuestion,
  editScheduleDay as applyEditScheduleDay,
  moveQuestion as applyMoveQuestion,
  pinQuestion as applyPinQuestion,
  reorderQuestions as applyReorderQuestions,
  getKitForBuilder,
  type Difficulty,
  type InternalKit,
} from "@trao/kit";
import { api } from "@/lib/api/client";
import { ApiError, VersionConflict } from "@/lib/api/types";

/**
 * The builder's state: one kit, its version, and every way to change it.
 *
 * Two properties are worth stating before the code, because everything here follows from them.
 *
 * **Optimistic updates run the server's own functions.** `apps/web` may import `@trao/kit`, so
 * the local preview of an edit is `editQuestion` — the same pure function the API calls. The
 * usual objection to optimistic UI is that the client ends up with a second, worse copy of the
 * business rules that drifts; here there is no second copy. What the user sees immediately is
 * what the server will compute, and the response replaces it anyway.
 *
 * **A conflict is recoverable, so the intent is kept.** When a write is refused because someone
 * else moved the kit on, the operation is held. Refetching and replaying it is then a real
 * offer rather than a hopeful one — see `reapply`.
 */

export interface Conflict {
  /** What the kit is actually on now. Sent as `If-Match` when the operation is replayed. */
  currentVersion: number;
  message: string;
  /** What the user was trying to do, so it can be offered again rather than described. */
  label: string;
  /**
   * Whether replaying means the same thing it did the first time.
   *
   * True for an edit: the change is a patch, and a patch replayed against a newer kit is still
   * the change the user asked for. False for a regeneration, which never ran at all — replaying
   * it produces different questions from the ones on screen, so it needs different words.
   */
  replayable: boolean;
}

export interface BuilderState {
  kit: InternalKit | null;
  loading: boolean;
  error: string | null;
  /**
   * The kit is not there, as opposed to unreachable.
   *
   * Kept separate because the two need opposite treatment: a server that is down deserves a
   * retry, a kit that does not exist can never be fetched however many times you ask. Reached
   * most often by a tab left open on a kit that has since been deleted.
   */
  notFound: boolean;
  /** Label of the operation in flight, for disabling the control that started it. */
  busy: string | null;
  conflict: Conflict | null;
  /** Section currently regenerating, if any. */
  regenerating: string | null;

  refetch: () => void;
  dismissConflict: () => void;
  /** Refetch, then run the held operation again against the kit that came back. */
  reapply: () => void;

  editBrief: (fields: { summary?: string; whatTheyDo?: string; hiringProcess?: string }) => void;
  editQuestion: (id: string, fields: { prompt?: string; answerOutline?: string; difficulty?: Difficulty }) => void;
  addQuestion: (draft: {
    category: QuestionCategory;
    prompt: string;
    answerOutline: string;
    difficulty: Difficulty;
    requirementIds: string[];
  }) => void;
  deleteQuestion: (id: string) => void;
  pinQuestion: (id: string, pinned: boolean) => void;
  moveQuestion: (id: string, toCategory: QuestionCategory) => void;
  reorderQuestions: (category: QuestionCategory, ids: string[]) => void;
  addFlashcard: (draft: { front: string; back: string; requirementIds: string[] }) => void;
  editFlashcard: (id: string, fields: { front?: string; back?: string }) => void;
  deleteFlashcard: (id: string) => void;
  editScheduleDay: (day: number, fields: { focus?: string; minutes?: number }) => void;
  regenerate: (target: { section: "company_brief" | "schedule" } | { section: "questions"; category: QuestionCategory }) => void;
}

/** A write: what it is called, what it looks like locally, and what the server is asked to do. */
interface Operation {
  label: string;
  /** Local preview. Omitted where the server mints ids and a guess would flicker. */
  preview?: (kit: InternalKit) => InternalKit;
  send: (version: number) => Promise<{ body: { kit: InternalKit }; version: number }>;
}

export function useBuilder(
  kitId: string | null,
  /**
   * Called once when the kit turns out not to exist.
   *
   * A callback rather than a flag, matching `useKit`: the workspace's response is to drop the
   * dead id from the URL and close the panel, which is an action taken once, not a state the
   * render has to keep consulting.
   */
  onNotFound?: (kitId: string) => void,
): BuilderState {
  // Held in a ref so a caller passing an inline function cannot restart the request.
  const notify = useRef(onNotFound);
  useEffect(() => {
    notify.current = onNotFound;
  }, [onNotFound]);

  const [kit, setKit] = useState<InternalKit | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [conflict, setConflict] = useState<Conflict | null>(null);
  const [regenerating, setRegenerating] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const [notFound, setNotFound] = useState(false);

  // The operation a conflict refused, kept so it can be replayed rather than retyped.
  const held = useRef<Operation | null>(null);

  useEffect(() => {
    if (kitId === null) {
      setKit(null);
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    api
      .getKit(kitId, controller.signal)
      .then((view) => {
        if (controller.signal.aborted) return;
        setKit(view.kit);
        setError(null);
        setNotFound(false);
      })
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return;
        const missing = cause instanceof ApiError && (cause.code === "NOT_FOUND" || cause.status === 404);
        setNotFound(missing);
        setError(cause instanceof Error ? cause.message : "Could not load this kit.");
        if (missing) notify.current?.(kitId);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [kitId, nonce]);

  const refetch = useCallback(() => setNonce((n) => n + 1), []);

  /**
   * Run one operation.
   *
   * Preview, send, replace. On any failure the kit goes back to exactly what it was — captured
   * before the preview rather than recomputed, because an inverse of every mutation is a second
   * implementation of all of them and `deleteQuestion` has no inverse at all.
   */
  const run = useCallback(
    async (operation: Operation) => {
      if (kit === null || kitId === null) return;
      const rollback = kit;

      setBusy(operation.label);
      if (operation.preview) setKit(operation.preview(kit));

      try {
        const { body } = await operation.send(rollback.version);
        // The server's kit is authoritative — it carries the repaired schedule and the real ids.
        setKit(body.kit);
        setConflict(null);
        held.current = null;
      } catch (cause) {
        setKit(rollback);
        if (cause instanceof VersionConflict) {
          held.current = operation;
          setConflict({
            currentVersion: cause.currentVersion,
            message: cause.message,
            label: operation.label,
            replayable: operation.preview !== undefined,
          });
        } else {
          setError(cause instanceof Error ? cause.message : "That change could not be saved.");
        }
      } finally {
        setBusy(null);
      }
    },
    [kit, kitId],
  );

  /**
   * Reload, then do it again.
   *
   * Honest only because the held operation is a patch: `editQuestion(id, {prompt})` means the
   * same thing against version 9 that it meant against version 7. Anything not replayable never
   * gets here — the conflict banner offers different words for those.
   */
  const reapply = useCallback(async () => {
    const operation = held.current;
    if (operation === null || kitId === null) return;

    setBusy(operation.label);
    try {
      const view = await api.getKit(kitId);
      const fresh = view.kit;
      setKit(fresh);
      const { body } = await operation.send(fresh.version);
      setKit(body.kit);
      setConflict(null);
      held.current = null;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "That change could not be reapplied.");
    } finally {
      setBusy(null);
    }
  }, [kitId]);

  const id = kitId ?? "";

  /**
   * Watch a regeneration and refetch when it lands.
   *
   * Polling rather than the event stream: a regeneration finishes in seconds, the builder has
   * one of them at a time, and the stream is worth its reconnection logic for a nine-step run
   * being watched live, not for a spinner on a button.
   */
  const watch = useCallback(
    async (jobId: string, section: string) => {
      setRegenerating(section);
      const started = Date.now();
      try {
        while (Date.now() - started < 120_000) {
          await new Promise((resolve) => setTimeout(resolve, 1200));
          const view = await api.getJob(jobId);
          if (view.job.status === "done") {
            refetch();
            return;
          }
          if (view.job.status === "failed") {
            setError(view.job.error?.message ?? "The regeneration failed. The kit is unchanged.");
            return;
          }
        }
        setError("The regeneration is taking longer than expected. Reload to see where it got to.");
      } finally {
        setRegenerating(null);
      }
    },
    [refetch],
  );

  return {
    kit,
    loading,
    error,
    notFound,
    busy,
    conflict,
    regenerating,
    refetch,
    dismissConflict: () => {
      held.current = null;
      setConflict(null);
    },
    reapply: () => void reapply(),

    editBrief: (fields) =>
      void run({
        label: "brief",
        preview: (k) => applyEditBrief(k, fields),
        send: (v) =>
          api.editBrief(
            id,
            {
              ...(fields.summary !== undefined ? { summary: fields.summary } : {}),
              ...(fields.whatTheyDo !== undefined ? { what_they_do: fields.whatTheyDo } : {}),
              ...(fields.hiringProcess !== undefined ? { hiring_process: fields.hiringProcess } : {}),
            },
            v,
          ),
      }),

    editQuestion: (questionId, fields) =>
      void run({
        label: `question:${questionId}`,
        preview: (k) => applyEditQuestion(k, questionId, fields),
        send: (v) =>
          api.editQuestion(
            id,
            questionId,
            {
              ...(fields.prompt !== undefined ? { prompt: fields.prompt } : {}),
              ...(fields.answerOutline !== undefined ? { answer_outline: fields.answerOutline } : {}),
              ...(fields.difficulty !== undefined ? { difficulty: fields.difficulty } : {}),
            },
            v,
          ),
      }),

    // No preview: the id is the server's to mint, and showing a placeholder that changes the
    // moment the response lands is a worse flicker than a short wait.
    addQuestion: (draft) =>
      void run({
        label: "question:new",
        send: (v) =>
          api.addQuestion(
            id,
            {
              category: draft.category,
              prompt: draft.prompt,
              answer_outline: draft.answerOutline,
              difficulty: draft.difficulty,
              requirement_ids: draft.requirementIds,
            },
            v,
          ),
      }),

    deleteQuestion: (questionId) =>
      void run({
        label: `question:${questionId}`,
        preview: (k) => applyDeleteQuestion(k, questionId),
        send: (v) => api.deleteQuestion(id, questionId, v),
      }),

    pinQuestion: (questionId, pinned) =>
      void run({
        label: `question:${questionId}`,
        preview: (k) => applyPinQuestion(k, questionId, pinned),
        send: (v) => api.pinQuestion(id, questionId, pinned, v),
      }),

    moveQuestion: (questionId, toCategory) =>
      void run({
        label: `question:${questionId}`,
        preview: (k) => applyMoveQuestion(k, questionId, toCategory),
        send: (v) => api.moveQuestion(id, questionId, toCategory, v),
      }),

    reorderQuestions: (category, ids) =>
      void run({
        label: `reorder:${category}`,
        preview: (k) => applyReorderQuestions(k, category, ids),
        send: (v) => api.reorderQuestions(id, category, ids, v),
      }),

    addFlashcard: (draft) =>
      void run({
        label: "flashcard:new",
        send: (v) =>
          api.addFlashcard(
            id,
            { front: draft.front, back: draft.back, requirement_ids: draft.requirementIds },
            v,
          ),
      }),

    editFlashcard: (flashcardId, fields) =>
      void run({
        label: `flashcard:${flashcardId}`,
        preview: (k) => applyEditFlashcard(k, flashcardId, fields),
        send: (v) => api.editFlashcard(id, flashcardId, fields, v),
      }),

    deleteFlashcard: (flashcardId) =>
      void run({
        label: `flashcard:${flashcardId}`,
        preview: (k) => applyDeleteFlashcard(k, flashcardId),
        send: (v) => api.deleteFlashcard(id, flashcardId, v),
      }),

    editScheduleDay: (day, fields) =>
      void run({
        label: `day:${day}`,
        preview: (k) => applyEditScheduleDay(k, day, fields),
        send: (v) => api.editScheduleDay(id, day, fields, v),
      }),

    regenerate: (target) => {
      if (kitId === null || regenerating !== null) return;
      const section = target.section === "questions" ? `questions:${target.category}` : target.section;
      void api
        .regenerate(kitId, target)
        .then((response) => watch(response.job_id, section))
        .catch((cause: unknown) =>
          setError(cause instanceof Error ? cause.message : "Could not start the regeneration."),
        );
    },
  };
}

/** The projection the builder must render. Never the raw kit — see the note in `projections`. */
export function builderView(kit: InternalKit): InternalKit {
  return getKitForBuilder(kit);
}
