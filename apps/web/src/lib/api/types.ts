import type { JobRecord, Span } from "@trao/contracts";
import type { EvaluationCase, InternalKit } from "@trao/kit";

/**
 * The wire contract between this app and `apps/api`.
 *
 * Every shape here is composed from `@trao/contracts` and `@trao/kit` rather than restated.
 * `JobRecord`, `JobProgress` and `Span` already exist and already mean something precise; a
 * parallel frontend definition would drift the first time one of them gained a field, and the
 * drift would show up as a runtime surprise rather than a type error.
 *
 * These belong in `packages/contracts` once `apps/api` exists and there are two callers to
 * share them. They are here while there is exactly one.
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
