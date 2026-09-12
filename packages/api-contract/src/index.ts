import type { JobAsk, JobRecord, Span } from "@trao/contracts";
import type { BuilderKit, EvaluationCase, KitJSON, KitLineage, QuestionCategory } from "@trao/kit";

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
  /**
   * The conversation these runs are turns in.
   *
   * One session for a whole batch submission, because one ask produced all of it — six roles
   * uploaded together are one thing the user did, and six sessions would put that single ask at
   * the head of six transcripts it is only partly about.
   */
  session_id: string;
}

/**
 * POST /kits — one role.
 *
 * `kit_id` is reserved before the pipeline runs rather than read off the finished kit. The
 * second of two identical submissions has to be answered with the id of the first, and at that
 * moment the first has not produced anything yet — so either the id exists up front or a
 * double-submitted form gets two kits. `existing: true` says this response joined work that was
 * already under way (or already finished); nothing new was started and no model was called.
 *
 * `job_ids` is carried alongside so the one-role and batch paths can be handled by one caller.
 */
export interface CreateKitResponse extends CreateJobsResponse {
  job_id: string;
  kit_id: string;
  existing: boolean;
}

/**
 * A conversation: the posting, every rewrite since, and the kits they produced.
 *
 * Derived by grouping the jobs and kits the API already reads — there is no `sessions`
 * collection. See `apps/api/src/sessions.ts` for why.
 */
export interface SessionTurnView {
  job_id: string;
  ask: JobAsk | null;
  /** What the run was called. The only self-description a turn written before asks were stored has. */
  label: string;
  status: JobRecord["status"];
  kit_id: string | null;
  error: JobRecord["error"];
  progress: JobRecord["progress"];
  created_at: number;
}

export interface SessionKitView {
  id: string;
  title: string;
  company: string;
  days: number;
  created_at: number;
  revision: number;
  /** What the rewrite that produced this kit did. Absent on the kit a posting built. */
  changed?: string;
}

export interface SessionSummary {
  id: string;
  title: string;
  created_at: number;
  updated_at: number;
  kits: SessionKitView[];
  /** True while any turn is queued or running — one live dot per conversation. */
  running: boolean;
  /** The newest turn's status, so a session whose last run failed can say so without expanding. */
  status: JobRecord["status"] | null;
}

export interface SessionListView {
  sessions: SessionSummary[];
}

/** One conversation in full: every turn, in the order it was asked. */
export interface SessionView extends SessionSummary {
  turns: SessionTurnView[];
}

/** The three things the builder can ask to be rebuilt. Questions take a category, the rest do not. */
export type RegenerateSection = "company_brief" | "questions" | "schedule";

export interface RegenerateRequest {
  section: RegenerateSection;
  /** Required when `section` is "questions": the four categories are regenerated one at a time. */
  category?: QuestionCategory;
  /**
   * What the person typed in the composer before sending, if anything.
   *
   * The rewrite arrives as a prompt rather than as a button press, so there is somewhere to say
   * what you actually wanted — "harder", "more about the streaming work". Fenced as untrusted on
   * the way into the prompt, and ignored outright by the schedule, which is allocated in code.
   */
  instructions?: string;
}

/**
 * Regeneration is a background job, like first generation — and it forks.
 *
 * `kit_id` is the NEW kit the rewrite will produce, reserved before any model is called, exactly
 * as `POST /kits` reserves one. The kit in the URL is not written to: a rewrite leaves the
 * document you pressed the button on byte-identical and puts its answer in a sibling, so the
 * version you had is still there to go back to. The client uses this id to switch the panel over
 * when the job lands.
 *
 * `existing: true` means this request joined one already running for the same kit, section,
 * category and instructions — two clicks on Send produce one job and one set of model calls.
 */
export interface RegenerateResponse {
  job_id: string;
  kit_id: string;
  /** The conversation this rewrite joins — the one the source kit is already in. */
  session_id: string;
  existing: boolean;
}

/**
 * What the progress screen polls.
 *
 * The spans come with it because the screen shows real named steps read from the trace, not a
 * fake spinner — and asking for them separately would let the two answers disagree about which
 * step is running.
 */
/**
 * A job record as the browser sees it, minus what the browser has no use for.
 *
 * `request` — the whole job description — stays on the server. The progress screen polls this
 * every couple of seconds, and shipping the posting back on every tick to answer a yes/no
 * question about a button would be a strange way to spend a phone's data. `retryable` is that
 * answer, computed where the record already is.
 */
export type JobRecordView = Omit<JobRecord, "request"> & { retryable: boolean };

export interface JobView {
  job: JobRecordView;
  spans: Span[];
  /** The role this job is for, so a batch of six can label its rows before any kit exists. */
  label: string;
}

/**
 * What the builder reads, and what every write hands straight back.
 *
 * A mutation returns the whole projection rather than the changed fragment. The builder is a
 * set of small writes against one document — a reorder shifts every sibling's index, a delete
 * takes a flashcard and a schedule slot with it — so a response describing only what was asked
 * for would leave the client to guess at the rest. The new version travels in an `ETag`, which
 * is the value the next write sends back as `If-Match`.
 */
export interface KitView {
  kit: BuilderKit;
}

/** GET /kits/:id/export — Appendix A exactly, unwrapped, as a file the user can keep. */
export type KitExport = KitJSON;

/** What the history sidebar lists. Deliberately small — the panel fetches the kit itself. */
export interface KitSummary {
  id: string;
  title: string;
  company: string;
  days: number;
  createdAt: number;
  /** The conversation this kit belongs to. Synthesised for kits written before sessions existed. */
  sessionId: string;
  /**
   * How many rewrites deep this kit is — 1 for one the pipeline built from a posting.
   *
   * The rail needs it because forking means a company can hold four rows with the same name and
   * the same role, and "Vaultline — Senior Backend" four times over is a list you cannot use.
   */
  revision: number;
  /** What the rewrite that produced this kit was asked to do. Absent on an original. */
  forkedFrom?: KitLineage;
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
  /**
   * Whether this run can be started again.
   *
   * Sent rather than inferred from the status: a run that failed before the posting was stored
   * on the record has nothing to retry with, and a client deducing "failed means retryable"
   * would offer a button that can only 404.
   */
  retryable: boolean;
}

export interface JobListView {
  jobs: JobSummary[];
}

/** The error body every failing endpoint returns. One shape, so the client has one branch. */
export interface ApiErrorBody {
  code: string;
  message: string;
}

/**
 * A body that failed validation.
 *
 * `field` is the addition worth having: the builder edits one control at a time, and a 400 that
 * names the field can be shown against that control instead of as a banner the user has to map
 * back onto the form themselves.
 */
export interface ValidationErrorBody extends ApiErrorBody {
  code: "INVALID_BODY";
  field: string;
}

/**
 * A write that lost a race.
 *
 * `current_version` is what makes this recoverable without a reload: the client refetches at
 * that version, replays the edit on top, and sends it again.
 */
export interface VersionConflictBody extends ApiErrorBody {
  code: "VERSION_CONFLICT";
  current_version: number;
}

/** A request with no usable session. The two codes are the two things the UI does about it. */
export interface AuthErrorBody extends ApiErrorBody {
  code: "UNAUTHENTICATED" | "SESSION_EXPIRED";
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
