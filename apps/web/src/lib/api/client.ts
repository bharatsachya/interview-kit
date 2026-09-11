import {
  ApiError,
  type JobListView,
  type CreateBatchRequest,
  type CreateJobsResponse,
  type CreateKitRequest,
  type JobView,
  type KitListView,
  type KitView,
  VersionConflict,
} from "./types";
import type { RegenerateRequest, RegenerateResponse } from "@trao/api-contract";

/**
 * The typed client for `apps/api`.
 *
 * Every network call the app makes goes through here. The base URL is the only thing that
 * changes when the real API lands: today it points at this app's own route handlers, which
 * implement the same contract against an in-memory store.
 *
 * There is no retry logic and no caching in here on purpose. Retrying a POST that starts a job
 * risks starting two, and the progress screen already polls — a second layer of cleverness
 * would make "why did it run twice" unanswerable.
 */
import { KIT_VERSION_HEADER } from "@/lib/api/headers";

export const API_BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL ?? "/api";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${API_BASE_URL}${path}`, {
      ...init,
      headers: {
        "content-type": "application/json",
        ...init?.headers,
      },
    });
  } catch (cause) {
    // A dead network is not a 500. Distinguishing them lets the UI say "you appear to be
    // offline" rather than blaming the server.
    throw new ApiError(0, "NETWORK_UNREACHABLE", cause instanceof Error ? cause.message : "Network request failed.");
  }

  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as
      | { code?: string; message?: string; current_version?: number }
      | null;

    // A 409 is not a failure to report and forget — it is the one error the UI can actually do
    // something about, and the version it carries is what makes the retry possible. Read the
    // header first: it is authoritative and present even when the body is not.
    if (response.status === 409) {
      const tagged = Number(response.headers.get(KIT_VERSION_HEADER));
      throw new VersionConflict(
        Number.isSafeInteger(tagged) ? tagged : (body?.current_version ?? -1),
        body?.message ?? "This kit has changed since you loaded it.",
      );
    }

    throw new ApiError(
      response.status,
      body?.code ?? "REQUEST_FAILED",
      body?.message ?? `Request to ${path} failed with ${response.status}.`,
    );
  }

  return (await response.json()) as T;
}

/**
 * A write and the version it produced.
 *
 * The version travels in `X-Kit-Version` between the browser and this app's own routes, and as
 * `If-Match`/`ETag` between those routes and the API. The translation happens in `upstream.ts`
 * and it is not decoration — see the note there. The API's HTTP stays correct; the hop a CDN can
 * see does not use headers a CDN is entitled to act on.
 *
 * Still read from a header rather than from `kit.version`, for the original reason: the header
 * is what the next write has to echo, and taking it from the body would break quietly the first
 * time the two disagreed.
 */
async function write<T>(path: string, init: RequestInit): Promise<{ body: T; version: number }> {
  const response = await requestRaw(path, init);
  const sent = Number(response.headers.get(KIT_VERSION_HEADER));
  return { body: (await response.json()) as T, version: Number.isSafeInteger(sent) ? sent : -1 };
}

/** The same call as `request`, stopping short of the body so the caller can read headers. */
async function requestRaw(path: string, init?: RequestInit): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(`${API_BASE_URL}${path}`, {
      ...init,
      headers: { "content-type": "application/json", ...init?.headers },
    });
  } catch (cause) {
    throw new ApiError(0, "NETWORK_UNREACHABLE", cause instanceof Error ? cause.message : "Network request failed.");
  }

  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as
      | { code?: string; message?: string; current_version?: number }
      | null;
    if (response.status === 409) {
      const tagged = Number(response.headers.get(KIT_VERSION_HEADER));
      throw new VersionConflict(
        Number.isSafeInteger(tagged) ? tagged : (body?.current_version ?? -1),
        body?.message ?? "This kit has changed since you loaded it.",
      );
    }
    throw new ApiError(
      response.status,
      body?.code ?? "REQUEST_FAILED",
      body?.message ?? `Request to ${path} failed with ${response.status}.`,
    );
  }
  return response;
}

function kitPath(kitId: string, tail: string): string {
  return `/kits/${encodeURIComponent(kitId)}/${tail}`;
}

export interface BriefFields {
  summary?: string;
  what_they_do?: string;
  hiring_process?: string;
}
export interface QuestionFields {
  prompt?: string;
  answer_outline?: string;
  difficulty?: 1 | 2 | 3;
}
export interface NewQuestionBody {
  category: string;
  prompt: string;
  answer_outline: string;
  difficulty: 1 | 2 | 3;
  requirement_ids: string[];
}
export interface FlashcardFields {
  front?: string;
  back?: string;
  requirement_ids?: string[];
}
export interface NewFlashcardBody {
  front: string;
  back: string;
  requirement_ids: string[];
}
export interface ScheduleFields {
  focus?: string;
  minutes?: number;
  question_ids?: string[];
}

/**
 * The version this write expects to be replacing.
 *
 * `X-Kit-Version`, not `If-Match`. The guard used to be a real conditional request, which is the
 * right HTTP and the wrong thing to send through a CDN: Vercel's edge evaluates the precondition
 * itself, and because the proxy passed the API's `ETag` back, every successful write came home
 * as `If-Match: "5"` against `ETag: "6"` — a mismatch by construction, since a write is what
 * changes the version. The edge then replaced a 200 with a 412 and the builder reported a
 * conflict for a write that had already been committed.
 *
 * A header the CDN has no opinion about cannot be second-guessed by it. `upstream.ts` turns this
 * back into `If-Match` for the API, which never had to change.
 */
function guard(version: number | undefined): Record<string, string> {
  return version === undefined ? {} : { [KIT_VERSION_HEADER]: String(version) };
}

export const api = {
  /** Starts one generation job and returns immediately with its id. */
  async createKit(body: CreateKitRequest, signal?: AbortSignal): Promise<CreateJobsResponse> {
    return request<CreateJobsResponse>("/kits", { method: "POST", body: JSON.stringify(body), signal });
  },

  /** Starts one job per case. The ids come back in input order so the rows can be labelled. */
  async createBatch(body: CreateBatchRequest, signal?: AbortSignal): Promise<CreateJobsResponse> {
    return request<CreateJobsResponse>("/kits/batch", { method: "POST", body: JSON.stringify(body), signal });
  },

  /**
   * Run a failed job's work again. Answers with the new job's id, like any other start.
   *
   * No body: what the run was for is on the job record, which is why it is stored there. The
   * page cannot supply it — a run reached from history was loaded long after its posting left
   * the screen.
   */
  async retryJob(jobId: string, signal?: AbortSignal): Promise<CreateJobsResponse> {
    return request<CreateJobsResponse>(`/jobs/${encodeURIComponent(jobId)}/retry`, {
      method: "POST",
      signal,
    });
  },

  async getJob(jobId: string, signal?: AbortSignal): Promise<JobView> {
    return request<JobView>(`/jobs/${encodeURIComponent(jobId)}`, { signal });
  },

  async listKits(signal?: AbortSignal): Promise<KitListView> {
    return request<KitListView>("/kits", { signal });
  },

  /**
   * Every run, including the ones still going.
   *
   * `listKits` only ever returns finished work, so a run in flight is invisible to it. This is
   * what keeps a queued or running job in the history list while the user is somewhere else.
   */
  async listJobs(signal?: AbortSignal): Promise<JobListView> {
    return request<JobListView>("/jobs", { signal });
  },

  async getKit(kitId: string, signal?: AbortSignal): Promise<KitView> {
    return request<KitView>(`/kits/${encodeURIComponent(kitId)}`, { signal });
  },

  // ── the builder ────────────────────────────────────────────────────────────────────────
  //
  // Every write answers with the whole kit and its new version rather than a patch. That looks
  // wasteful and is not: the alternative is the client reassembling the document from a diff,
  // and a schedule repaired server-side after an archive is precisely the change a diff of the
  // edited field would not contain.

  async editBrief(kitId: string, fields: BriefFields, version?: number) {
    return write<KitView>(kitPath(kitId, "brief"), {
      method: "PATCH",
      body: JSON.stringify(fields),
      headers: guard(version),
    });
  },

  async addQuestion(kitId: string, question: NewQuestionBody, version?: number) {
    return write<KitView>(kitPath(kitId, "questions"), {
      method: "POST",
      body: JSON.stringify(question),
      headers: guard(version),
    });
  },

  async editQuestion(kitId: string, questionId: string, fields: QuestionFields, version?: number) {
    return write<KitView>(kitPath(kitId, `questions/${encodeURIComponent(questionId)}`), {
      method: "PATCH",
      body: JSON.stringify(fields),
      headers: guard(version),
    });
  },

  async deleteQuestion(kitId: string, questionId: string, version?: number) {
    return write<KitView>(kitPath(kitId, `questions/${encodeURIComponent(questionId)}`), {
      method: "DELETE",
      headers: guard(version),
    });
  },

  async pinQuestion(kitId: string, questionId: string, pinned: boolean, version?: number) {
    return write<KitView>(kitPath(kitId, `questions/${encodeURIComponent(questionId)}/pin`), {
      method: "POST",
      body: JSON.stringify({ pinned }),
      headers: guard(version),
    });
  },

  async moveQuestion(kitId: string, questionId: string, toCategory: string, version?: number) {
    return write<KitView>(kitPath(kitId, `questions/${encodeURIComponent(questionId)}/move`), {
      method: "POST",
      body: JSON.stringify({ to_category: toCategory }),
      headers: guard(version),
    });
  },

  async reorderQuestions(kitId: string, category: string, ids: readonly string[], version?: number) {
    return write<KitView>(kitPath(kitId, "questions/reorder"), {
      method: "POST",
      body: JSON.stringify({ category, ids }),
      headers: guard(version),
    });
  },

  async addFlashcard(kitId: string, card: NewFlashcardBody, version?: number) {
    return write<KitView>(kitPath(kitId, "flashcards"), {
      method: "POST",
      body: JSON.stringify(card),
      headers: guard(version),
    });
  },

  async editFlashcard(kitId: string, flashcardId: string, fields: FlashcardFields, version?: number) {
    return write<KitView>(kitPath(kitId, `flashcards/${encodeURIComponent(flashcardId)}`), {
      method: "PATCH",
      body: JSON.stringify(fields),
      headers: guard(version),
    });
  },

  async deleteFlashcard(kitId: string, flashcardId: string, version?: number) {
    return write<KitView>(kitPath(kitId, `flashcards/${encodeURIComponent(flashcardId)}`), {
      method: "DELETE",
      headers: guard(version),
    });
  },

  async editScheduleDay(kitId: string, day: number, fields: ScheduleFields, version?: number) {
    return write<KitView>(kitPath(kitId, `schedule/days/${day}`), {
      method: "PATCH",
      body: JSON.stringify(fields),
      headers: guard(version),
    });
  },

  /**
   * Rebuild a section. Answers 202 with a job id, not a kit.
   *
   * Regeneration is several model calls and the builder stays usable while it runs, so the
   * caller watches the job and refetches when it lands. `existing: true` means a run for this
   * same section was already going and nothing new was started.
   */
  async regenerate(kitId: string, target: RegenerateRequest): Promise<RegenerateResponse> {
    return request<RegenerateResponse>(kitPath(kitId, "regenerate"), {
      method: "POST",
      body: JSON.stringify(target),
    });
  },

  /**
   * Open a practice sitting: the deck order, what the history knows, and a session id.
   *
   * A fresh session id on every call, because a session is one sitting and a reload is a new
   * one. The ratings themselves are not per-session — they accumulate, which is what makes the
   * next deck ordered by lowest confidence rather than by the last five minutes.
   */
  async openPractice(kitId: string, signal?: AbortSignal): Promise<PracticeView> {
    return request<PracticeView>(kitPath(kitId, "practice"), { signal });
  },

  /** Record one card. Fire-and-forget from the deck's point of view — see `use-practice.ts`. */
  async recordPractice(kitId: string, rating: PracticeRatingRequest): Promise<PracticeSummaryView> {
    return request<PracticeSummaryView>(kitPath(kitId, "practice"), {
      method: "POST",
      body: JSON.stringify(rating),
    });
  },
};

export interface PracticeStanding {
  flashcard_id: string;
  /** Null for a card the deck has never dealt — not the same as one rated "Again". */
  confidence: "unseen" | "shaky" | "known" | null;
  rated_at: number | null;
  attempts: number;
}

export interface PracticeSummaryBody {
  total: number;
  covered: number;
  not_covered: number;
  known: number;
  shaky: number;
  again: number;
  last_practised_at: number | null;
}

export interface PracticeView {
  session_id: string;
  /** Flashcard ids, lowest confidence first. Computed on the server from the whole history. */
  deck: string[];
  standings: PracticeStanding[];
  summary: PracticeSummaryBody;
}

export interface PracticeSummaryView {
  summary: PracticeSummaryBody;
}

export interface PracticeRatingRequest {
  session_id: string;
  flashcard_id: string;
  confidence: "unseen" | "shaky" | "known";
}
