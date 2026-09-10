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
  JobView,
  KitListView,
  KitSummary,
  KitView,
} from "@trao/api-contract";

export { ApiError } from "@trao/api-contract";
