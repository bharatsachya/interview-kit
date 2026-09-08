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
  status: JobStatus;
  progress: JobProgress | null;
  error: { code: string; message: string } | null;
  createdAt: number;
  updatedAt: number;
}

export interface JobStore {
  create(job: JobRecord): Promise<void>;
  findById(id: string): Promise<JobRecord | null>;
  updateProgress(id: string, progress: JobProgress): Promise<void>;
  complete(id: string, kitId: string): Promise<void>;
  fail(id: string, error: { code: string; message: string }): Promise<void>;
}
