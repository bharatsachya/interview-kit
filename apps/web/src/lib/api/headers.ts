/**
 * The header the builder's version guard travels in, between the browser and this app's routes.
 *
 * Its own module because both halves need it and neither should import the other: `client.ts`
 * runs in the browser, `upstream.ts` runs on the server and holds the Clerk token.
 *
 * Not `If-Match`. That is the correct HTTP for a guarded write and precisely why it cannot be
 * used on a hop a CDN can see — Vercel's edge evaluates the precondition itself, against the
 * ETag on the response, and a write is the one thing guaranteed to change that ETag. Every
 * successful edit came back 412. The API still speaks `If-Match`/`ETag`; the translation happens
 * at the proxy.
 */
export const KIT_VERSION_HEADER = "x-kit-version";
