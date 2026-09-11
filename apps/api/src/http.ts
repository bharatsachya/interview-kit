import type { NextFunction, Request, Response } from "express";
import type { KitRecord, KitStore } from "@trao/contracts";
import { isAuthError, type Authenticator } from "@trao/auth";
import { getKitForBuilder, type InternalKit } from "@trao/kit";

/**
 * The five things every route does the same way.
 *
 * Authenticate, prove ownership, read the expected version, answer with the builder projection,
 * fail in one shape. Each is a decision it would be possible to get subtly wrong per route, so
 * none of them is left to a route to remember.
 */

/**
 * Authenticate, then run the handler.
 *
 * Wrapping rather than `app.use` middleware so no route can be added without one: a route that
 * forgets to authenticate is a route that does not compile, because the handler signature
 * demands a `userId`.
 */
export function guarded(
  auth: Authenticator,
  handler: (req: Request, res: Response, userId: string) => Promise<void>,
): (req: Request, res: Response, next: NextFunction) => void {
  return (req, res, next) => {
    void (async () => {
      try {
        const user = await auth.authenticate(req.header("authorization"));
        await handler(req, res, user.id);
      } catch (error) {
        next(error);
      }
    })();
  };
}

/**
 * The kit, if it is this user's.
 *
 * Returns null for both "no such kit" and "not yours", because the caller must not be able to
 * tell them apart — and neither must the person on the other end of it. A kit id is a bare
 * string in a URL; answering 403 to someone who guessed one confirms it exists, which is a
 * membership oracle over every kit in the system. 404 is the honest answer to "show me a kit
 * you have no business knowing about".
 */
export async function ownedKit(
  kits: KitStore<InternalKit>,
  kitId: string,
  userId: string,
): Promise<KitRecord<InternalKit> | null> {
  const record = await kits.findById(kitId);
  if (record === null || record.userId !== userId) return null;
  return record;
}

/**
 * The version the client believes it is writing against.
 *
 * `If-Match` is the HTTP header for exactly this, and using it rather than a field in the body
 * keeps the concurrency check out of every schema and off the DELETE routes, which have no body
 * to put it in. Quotes and the weak-validator prefix are stripped: a client echoing back the
 * `ETag` it was given is the intended usage, and both `7` and `W/"7"` mean the same thing.
 *
 * Absent means no opinion, and the write proceeds. Not a loophole — a caller that never read
 * the kit has nothing to conflict with, and the builder always has an `ETag` to send.
 */
export function expectedVersion(req: Request): number | undefined {
  const header = req.header("if-match");
  if (header === undefined) return undefined;

  const value = header.trim().replace(/^W\//i, "").replace(/^"|"$/g, "");
  const parsed = Number(value);
  // A malformed If-Match is not "no opinion": it is a client that meant to guard a write. An
  // impossible version number makes the mutation refuse rather than silently overwrite.
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : -1;
}

/**
 * Answer with the builder projection and the new version.
 *
 * The `ETag` is the kit's version, quoted. It is what the next write sends back as `If-Match`,
 * so the round trip closes without the client having to dig a number out of the body — and a
 * client that ignores it entirely is exactly the "last write wins" it was before.
 */
export function sendKit(res: Response, kit: InternalKit, status = 200): void {
  res
    .status(status)
    .set("etag", `"${kit.version}"`)
    // The builder is a live document behind a proxy that would otherwise be delighted to serve
    // a stale copy back — and a stale kit in an editor means edits applied to the wrong base.
    .set("cache-control", "no-store")
    .json({ kit: getKitForBuilder(kit) });
}

export function notFound(res: Response, what = "kit"): void {
  res.status(404).json({ code: "NOT_FOUND", message: `No such ${what}.` });
}

export function versionConflict(res: Response, currentVersion: number): void {
  res.status(409).set("etag", `"${currentVersion}"`).json({
    code: "VERSION_CONFLICT",
    current_version: currentVersion,
    message: `This kit has moved on to version ${currentVersion}. Refetch it and reapply the change.`,
  });
}

/** The 401 body. The code is the whole point: it tells the UI whether to offer a way back. */
export function unauthenticated(res: Response, error: unknown): void {
  const code = isAuthError(error) ? error.code : "UNAUTHENTICATED";
  res.status(401).json({
    code,
    message:
      code === "SESSION_EXPIRED"
        ? "Your session has expired. Sign in again to continue."
        : "Sign in to continue.",
  });
}
