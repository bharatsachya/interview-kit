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

export interface JobRecord {
  id: string;
  userId: string | null;
  kitId: string | null;
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
   * What the run was asked for, kept so it can be asked again.
   *
   * A failed run is the one a user most wants to retry, and until this was stored there was
   * nothing to retry *from*: the record knew a run had failed and not what it had been for. The
   * browser could not supply it either — after a reload the posting is gone from the page.
   *
   * Null on a regeneration, which re-runs from a kit rather than from a posting, and on any
   * record written before this field existed. Both mean the same thing to a caller: no retry.
   */
  request: { jd: string; companyUrl: string; days: number } | null;
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
