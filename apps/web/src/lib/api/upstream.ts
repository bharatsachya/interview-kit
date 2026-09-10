import { auth } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";

/**
 * The server-side edge of the app: everything under `app/api/` forwards to `apps/api` through
 * here.
 *
 * The browser never talks to the Express API directly. Two reasons, and the second is the one
 * that settles it:
 *
 *  1. Same-origin requests need no CORS policy and no public API hostname, so the API can be
 *     reached only by this app and by whoever holds a token — not by any page on the internet.
 *  2. `EventSource` cannot set an `Authorization` header. A browser talking straight to the API
 *     would have to put a session token in a query string to watch a job, which puts it in
 *     every access log between here and there. Proxying keeps the token server-side.
 *
 * The token is minted per request by Clerk and verified independently by the API against
 * Clerk's JWKS. The API does not trust this app to have authenticated anyone — see
 * `packages/auth`.
 */

/** Where `apps/api` is listening. Server-only: it is deliberately not `NEXT_PUBLIC_`. */
export const API_ORIGIN = (process.env.API_ORIGIN ?? "http://127.0.0.1:8080").replace(/\/$/, "");

/** A JSON call has a bounded life; the stream below manages its own. */
const REQUEST_TIMEOUT_MS = 20_000;

export interface UpstreamCall {
  method?: string;
  body?: string;
  signal?: AbortSignal;
}

/**
 * Authenticate the caller, then call the API as them.
 *
 * Throws `UpstreamUnreachable` when the API cannot be reached at all — a dead API and a 500 from
 * a live one are different operational facts and the UI says so differently.
 */
export async function callApi(path: string, call: UpstreamCall = {}): Promise<Response> {
  // `auth.protect()` would redirect to the sign-in page. That is right for a page and wrong
  // here: the client asked for JSON, would follow the redirect, and would report a parse
  // failure instead of "your session ended". A JSON endpoint says 401 in JSON.
  const { userId, getToken } = await auth();
  if (userId === null) throw new Unauthenticated();

  const token = await getToken();

  try {
    return await fetch(`${API_ORIGIN}${path}`, {
      method: call.method ?? "GET",
      headers: {
        "content-type": "application/json",
        ...(token !== null ? { authorization: `Bearer ${token}` } : {}),
      },
      ...(call.body !== undefined ? { body: call.body } : {}),
      signal: call.signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      cache: "no-store",
    });
  } catch (cause) {
    throw new UpstreamUnreachable(cause);
  }
}

/**
 * Forward a JSON endpoint verbatim: same status, same body.
 *
 * Nothing is reshaped on the way through. The API owns what a valid role is, what a 404 means
 * and which projection a kit is returned in; a proxy that edited any of that would be a second
 * definition of the contract, and the two would drift.
 */
export async function proxyJson(path: string, call: UpstreamCall = {}): Promise<NextResponse> {
  let response: Response;
  try {
    response = await callApi(path, call);
  } catch (error) {
    if (error instanceof Unauthenticated) return unauthenticated();
    if (error instanceof UpstreamUnreachable) return unreachable();
    throw error;
  }

  const text = await response.text();
  const payload: unknown = text === "" ? { code: "EMPTY_RESPONSE", message: "The API returned nothing." } : safeParse(text);

  return NextResponse.json(payload, {
    status: response.status,
    headers: { "cache-control": "no-store" },
  });
}

/** Read a request body through, without inspecting it. Validation is the API's job. */
export async function forwardBody(request: Request): Promise<string> {
  return await request.text();
}

/** No signed-in user. Distinct from the API rejecting a token, which is the API's own 401. */
export class Unauthenticated extends Error {
  constructor() {
    super("Not signed in.");
    this.name = "Unauthenticated";
  }
}

export class UpstreamUnreachable extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : "The API could not be reached.", { cause });
    this.name = "UpstreamUnreachable";
  }
}

/**
 * 502, not 500. The app is fine; the thing behind it is not, and the distinction is what tells
 * a reader of the logs whether to look at Vercel or at Azure.
 */
export function unreachable(): NextResponse {
  return NextResponse.json(
    { code: "API_UNREACHABLE", message: "The generation service is not responding." },
    { status: 502, headers: { "cache-control": "no-store" } },
  );
}

export function unauthenticated(): NextResponse {
  return NextResponse.json(
    { code: "UNAUTHENTICATED", message: "Sign in to continue." },
    { status: 401, headers: { "cache-control": "no-store" } },
  );
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    // An HTML error page from a load balancer, most likely. Do not pass it to a client that
    // expects `{ code, message }`.
    return { code: "BAD_UPSTREAM_RESPONSE", message: "The API returned a response that was not JSON." };
  }
}
