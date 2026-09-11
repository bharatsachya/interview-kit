import { describe, expect, it } from "vitest";
import { KIT_VERSION_HEADER } from "../src/lib/api/headers";

/**
 * The rule this pins is a deployment fact, not a preference.
 *
 * Vercel's edge evaluates conditional requests itself. A guarded write sends the version it
 * expects to replace and the response carries the version it created — so `If-Match` against
 * `ETag` is a mismatch *by construction*, and the edge turned every successful edit into a 412
 * over a change that had already been committed.
 */
describe("the builder's version guard", () => {
  it("does not travel in a header a CDN is entitled to act on", () => {
    expect(KIT_VERSION_HEADER).not.toBe("if-match");
    expect(KIT_VERSION_HEADER).not.toBe("etag");
    expect(KIT_VERSION_HEADER.startsWith("x-")).toBe(true);
  });
});
