import {
  ApiError,
  type CreateBatchRequest,
  type CreateJobsResponse,
  type CreateKitRequest,
  type JobView,
  type KitView,
} from "./types";

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
const BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL ?? "/api";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${BASE_URL}${path}`, {
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
    const body = (await response.json().catch(() => null)) as { code?: string; message?: string } | null;
    throw new ApiError(
      response.status,
      body?.code ?? "REQUEST_FAILED",
      body?.message ?? `Request to ${path} failed with ${response.status}.`,
    );
  }

  return (await response.json()) as T;
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

  async getJob(jobId: string, signal?: AbortSignal): Promise<JobView> {
    return request<JobView>(`/jobs/${encodeURIComponent(jobId)}`, { signal });
  },

  async getKit(kitId: string, signal?: AbortSignal): Promise<KitView> {
    return request<KitView>(`/kits/${encodeURIComponent(kitId)}`, { signal });
  },
};
