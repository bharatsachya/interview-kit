import { KIT_VERSION_HEADER } from "@/lib/api/headers";
import { forwardBody, proxyJson } from "@/lib/api/upstream";

/**
 * Everything under `/kits/:kitId/…` — the builder's writes, the export, the regenerate trigger.
 *
 * One catch-all rather than a file per route. There are fourteen of them and they are defined in
 * `apps/api/src/builder.ts`; mirroring each one here would mean fourteen files whose only content
 * is the path they forward, and a fifteenth route added there would 404 in the browser until
 * somebody remembered to add a sixteenth file. The API owns the route table, this owns the hop.
 *
 * Nothing is validated here on purpose. The API parses every body with zod and returns a typed
 * 400; a second opinion in the proxy is a second thing to keep in step, and the two disagreeing
 * is worse than either being wrong alone.
 *
 * The version guard is carried up and comes back down — see `upstream.ts`. That round trip is
 * the builder's whole concurrency story, and a proxy that dropped it would leave the version
 * checking in `packages/kit` running against a number no client ever sends.
 *
 * It changes names on the way: `X-Kit-Version` from the browser, `If-Match` to the API. The two
 * headers mean the same thing and only one of them is safe to send through a CDN.
 */

/** Path segments are already decoded by Next; re-encode so a stray slash cannot forge a route. */
function upstreamPath(kitId: string, path: string[]): string {
  const tail = path.map((segment) => encodeURIComponent(segment)).join("/");
  return `/kits/${encodeURIComponent(kitId)}${tail === "" ? "" : `/${tail}`}`;
}

type Context = { params: Promise<{ kitId: string; path: string[] }> };

/**
 * The version guard, translated for the API.
 *
 * The browser sends `X-Kit-Version: 5`; the API expects `If-Match: "5"`, which is the correct
 * HTTP for a guarded write and exactly why it cannot be used on the hop a CDN sees — Vercel's
 * edge evaluates the precondition against the response's ETag and answers 412 for a write that
 * succeeded. `If-Match` is still accepted here, so a direct caller or a curl reproducing a bug
 * behaves the same as the app.
 */
function guardHeader(request: Request): Record<string, string> {
  const version = request.headers.get(KIT_VERSION_HEADER);
  if (version !== null && version.trim() !== "") return { "if-match": `"${version.trim()}"` };

  const ifMatch = request.headers.get("if-match");
  return ifMatch === null ? {} : { "if-match": ifMatch };
}

export async function GET(request: Request, context: Context) {
  const { kitId, path } = await context.params;
  return proxyJson(upstreamPath(kitId, path), { headers: guardHeader(request) });
}

export async function POST(request: Request, context: Context) {
  const { kitId, path } = await context.params;
  return proxyJson(upstreamPath(kitId, path), {
    method: "POST",
    body: await forwardBody(request),
    headers: guardHeader(request),
  });
}

export async function PATCH(request: Request, context: Context) {
  const { kitId, path } = await context.params;
  return proxyJson(upstreamPath(kitId, path), {
    method: "PATCH",
    body: await forwardBody(request),
    headers: guardHeader(request),
  });
}

export async function DELETE(request: Request, context: Context) {
  const { kitId, path } = await context.params;
  // No body: `deleteQuestion` and `deleteFlashcard` take none, and the guard travels in a header.
  return proxyJson(upstreamPath(kitId, path), { method: "DELETE", headers: guardHeader(request) });
}
