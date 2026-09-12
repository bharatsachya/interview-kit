/**
 * Storage.
 *
 * The kit document type lives in packages/kit, and contracts imports nothing — so the stores
 * are generic over it. That is not a dodge: a store persists and returns a document, it never
 * interprets one. Only the composition roots pin the parameter, as `KitStore<InternalKit>`.
 *
 * Two implementations of each: in-memory for batch mode and tests, MongoDB for the app. Batch
 * mode must run from a clean clone with no database, so nothing below may become mandatory.
 */

export interface KitRecord<TKit = unknown> {
  id: string;
  /** Null in batch mode, which has no user. Ownership is attached by the API layer only. */
  userId: string | null;
  /**
   * The conversation this kit belongs to.
   *
   * Null for the same reason `userId` is: batch mode has no browser, no transcript and nobody
   * to show one to, so the pipeline never learns this field exists — the API layer attaches it,
   * exactly like ownership. Also null on any kit written before sessions existed; those are
   * grouped by a synthetic id at read time rather than migrated. See `apps/api/src/sessions.ts`.
   */
  sessionId: string | null;
  /** sha256 of (normalised JD + company_url + days). Makes a resubmission idempotent. */
  hash: string;
  createdAt: number;
  updatedAt: number;
  kit: TKit;
}

export interface KitStore<TKit = unknown> {
  save(record: KitRecord<TKit>): Promise<void>;
  findById(id: string): Promise<KitRecord<TKit> | null>;
  findByHash(hash: string): Promise<KitRecord<TKit> | null>;
  listByUser(userId: string): Promise<KitRecord<TKit>[]>;
}

export interface UserRecord {
  id: string;
  email: string;
  createdAt: number;
}

export interface UserStore {
  findById(id: string): Promise<UserRecord | null>;
  create(user: UserRecord): Promise<void>;
}

export type JobStatus = "queued" | "running" | "done" | "failed";

export interface JobProgress {
  /** The pipeline step currently running, e.g. "crawl_site". Read from the trace, not invented. */
  step: string;
  stepIndex: number;
  stepCount: number;
  message?: string;
}

/**
 * What the user asked for, in the words they asked it.
 *
 * Discriminated, because the two kinds are not variations of one thing: a posting is a document
 * the run was built from and can be retried with, a rewrite is a sentence typed against a kit
 * that already exists. The transcript renders them differently and `retry` only understands one
 * of them.
 *
 * This is what makes a conversation survive a reload. It used to live in React state on the
 * workspace, so the runs and their traces came back after a refresh and what you had actually
 * asked for did not — which is the half a transcript is for.
 */
export type JobAsk =
  | { kind: "posting"; jd: string; companyUrl: string; days: number }
  /** `section` is `company_brief` | `questions` | `schedule`; kept as a string so contracts stays importless. */
  | { kind: "rewrite"; section: string; category?: string; prompt: string };

export interface JobRecord {
  id: string;
  userId: string | null;
  kitId: string | null;
  /**
   * The conversation this run is a turn in.
   *
   * A first generation opens one; a rewrite joins the session of the kit it forks from; a retry
   * joins the session of the run it repeats. Null in batch mode and on records written before
   * sessions existed — see `KitRecord.sessionId`.
   */
  sessionId: string | null;
  /**
   * A human-readable name for the run, taken from the posting's first line.
   *
   * Stored rather than held in the running process: a job has to be nameable in a list before
   * its kit exists, and after a restart the process that started it may be gone.
   */
  label: string;
  status: JobStatus;
  progress: JobProgress | null;
  error: { code: string; message: string } | null;
  /**
   * What the run was asked for, kept so it can be replayed and so the transcript can show it.
   *
   * A failed run is the one a user most wants to retry, and until this was stored there was
   * nothing to retry *from*: the record knew a run had failed and not what it had been for. The
   * browser could not supply it either — after a reload the posting is gone from the page.
   *
   * A `rewrite` cannot be retried (there is no posting to send again) but it is still the ask,
   * and the transcript needs it. `retryable` on the wire is the answer to the button's question,
   * computed where the record already is.
   *
   * Null on records written before this field existed. Records written before it was
   * discriminated hold a bare `{jd, companyUrl, days}`; `askOf` in `apps/api/src/sessions.ts`
   * reads those as `posting` rather than migrating them.
   */
  request: JobAsk | null;
  createdAt: number;
  updatedAt: number;
}

export interface JobStore {
  create(job: JobRecord): Promise<void>;
  findById(id: string): Promise<JobRecord | null>;
  /**
   * A user's runs, newest first.
   *
   * The history list is built from kits, and a kit does not exist until its job finishes — so a
   * run in flight was invisible the moment you navigated away from the screen watching it. This
   * is what lets a queued or running job hold its place in the list.
   */
  listByUser(userId: string, limit?: number): Promise<JobRecord[]>;
  updateProgress(id: string, progress: JobProgress): Promise<void>;
  complete(id: string, kitId: string): Promise<void>;
  fail(id: string, error: { code: string; message: string }): Promise<void>;
}
