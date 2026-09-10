import type { JobRecord, Span } from "@trao/contracts";
import type { EvaluationCase, InternalKit } from "@trao/kit";

/**
 * @trao/api-contract — the wire shapes shared by `apps/web` and `apps/api`.
 *
 * These were written in `apps/web/src/lib/api/types.ts` with a note saying they belonged in
 * `contracts` once there were two callers. There now are — but they cannot go in `contracts`,
 * which imports nothing and so cannot see `InternalKit` or `EvaluationCase`. A package that may
 * import both `contracts` and `kit` is where they actually belong, and having it named for what
 * it is beats filing HTTP shapes inside the kit document package.
 *
 * Every shape is composed from the existing types rather than restated. `JobRecord`,
 * `JobProgress` and `Span` already mean something precise; a parallel frontend definition would
 * drift the first time one of them gained a field, and the drift would surface as a runtime
 * surprise rather than a type error.
 */

/** POST /kits — one role. The field names match Appendix B's case shape on purpose. */
export type CreateKitRequest = Pick<EvaluationCase, "jd" | "company_url" | "days">;

/** POST /kits/batch — many roles, parsed from a cases.json upload. */
export interface CreateBatchRequest {
  cases: EvaluationCase[];
}

/**
 * Generation is a background job. The response is immediate — a 90-second HTTP request dies on
 * free-tier hosts, and the job id is what makes the run resumable and its URL shareable.
 */
export interface CreateJobsResponse {
  job_ids: string[];
}

/**
 * What the progress screen polls.
 *
 * The spans come with it because the screen shows real named steps read from the trace, not a
 * fake spinner — and asking for them separately would let the two answers disagree about which
 * step is running.
 */
export interface JobView {
  job: JobRecord;
  spans: Span[];
  /** The role this job is for, so a batch of six can label its rows before any kit exists. */
  label: string;
}

export interface KitView {
  kit: InternalKit;
}

/** What the history sidebar lists. Deliberately small — the panel fetches the kit itself. */
export interface KitSummary {
  id: string;
  title: string;
  company: string;
  days: number;
  createdAt: number;
}

export interface KitListView {
  kits: KitSummary[];
}

/**
 * A run, listable before it has a kit.
 *
 * The history sidebar was built from kits alone, and a kit exists only once its job has
 * finished — so navigating away from the progress screen lost the run entirely. A job carries
 * enough to hold a row: what it was for, how far it got, and where its kit is once there is one.
 */
export interface JobSummary {
  id: string;
  label: string;
  status: JobRecord["status"];
  kitId: string | null;
  createdAt: number;
  progress: JobRecord["progress"];
  error: JobRecord["error"];
}

export interface JobListView {
  jobs: JobSummary[];
}

/** The error body every failing endpoint returns. One shape, so the client has one branch. */
export interface ApiErrorBody {
  code: string;
  message: string;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}
