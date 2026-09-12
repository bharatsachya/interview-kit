/**
 * The wire contract between this app and `apps/api`.
 *
 * It lives in `packages/api-contract` now that both sides consume it — these shapes were
 * written here first, with a note saying they belonged in a shared package once there were two
 * callers. There are. This file stays as the import site the app already uses.
 */
export type {
  ApiErrorBody,
  CreateBatchRequest,
  CreateJobsResponse,
  CreateKitRequest,
  JobListView,
  JobRecordView,
  JobSummary,
  JobView,
  KitExport,
  KitListView,
  KitSummary,
  KitView,
  SessionKitView,
  SessionListView,
  SessionSummary,
  SessionTurnView,
  SessionView,
} from "@trao/api-contract";

export { ApiError } from "@trao/api-contract";

/**
 * The write was refused because the kit had moved on.
 *
 * Its own class rather than an `ApiError` with a code, because it is the one failure the UI is
 * expected to recover from rather than report. `currentVersion` is what the retry sends back as
 * `If-Match`, so catching this is the difference between "something went wrong" and a working
 * reload-and-reapply.
 */
export class VersionConflict extends Error {
  readonly code = "VERSION_CONFLICT" as const;

  constructor(
    readonly currentVersion: number,
    message: string,
  ) {
    super(message);
    this.name = "VersionConflict";
  }
}
