import { readFile } from "node:fs/promises";
import { join, normalize, sep } from "node:path";
import { KitError, type FetchOptions, type FetchResult, type HttpFetcher } from "@trao/contracts";

/**
 * Serves the static trees under `fixtures/sites/`.
 *
 * What `--fake-fetch` wires in, and what every retrieval test runs against: no network, no
 * flakiness, and four sites chosen to cover the cases the brief says it tests — an obvious deep
 * link, a site with nothing on it, a site that 404s, and hiring material at a path no fixed list
 * would guess.
 *
 * Mounts are prefix → directory, so a site can be served from a sub-path. That is not a
 * convenience: Appendix B's harness serves from `http://localhost:8099/acme/`, and a fetcher
 * that only handled origin-rooted sites would let a relative-link bug through to the graders.
 */

export interface FakeFetcherOptions {
  /** Absolute path to `fixtures/sites`. */
  root: string;
  /** URL prefix → directory name under `root`. Longest matching prefix wins. */
  mounts: Record<string, string>;
  /** Extra files keyed by absolute URL, for oversized or odd-content-type cases. */
  overrides?: Record<string, { status?: number; contentType?: string; body: string }>;
}

export class FakeFetcher implements HttpFetcher {
  readonly requested: string[] = [];

  constructor(private readonly options: FakeFetcherOptions) {}

  async fetch(url: string, perRequest: FetchOptions = {}): Promise<FetchResult> {
    this.requested.push(url);

    const override = this.options.overrides?.[url];
    if (override !== undefined) {
      const body = override.body;
      const bytes = Buffer.byteLength(body);
      if (perRequest.maxBytes !== undefined && bytes > perRequest.maxBytes) {
        throw new KitError("INVALID_INPUT", `${url} exceeds the ${perRequest.maxBytes} byte cap.`);
      }
      return {
        url,
        finalUrl: url,
        status: override.status ?? 200,
        contentType: override.contentType ?? "text/html; charset=utf-8",
        body,
        bytes,
      };
    }

    const mount = this.#mountFor(url);
    if (mount === null) return notFound(url);

    const filePath = this.#filePathFor(url, mount);
    if (filePath === null) return notFound(url);

    let body: string;
    try {
      body = await readFile(filePath, "utf8");
    } catch {
      return notFound(url);
    }

    const bytes = Buffer.byteLength(body);
    if (perRequest.maxBytes !== undefined && bytes > perRequest.maxBytes) {
      throw new KitError("INVALID_INPUT", `${url} exceeds the ${perRequest.maxBytes} byte cap.`);
    }

    return {
      url,
      finalUrl: url,
      status: 200,
      contentType: filePath.endsWith(".txt") ? "text/plain; charset=utf-8" : "text/html; charset=utf-8",
      body,
      bytes,
    };
  }

  #mountFor(url: string): { prefix: string; dir: string } | null {
    let best: { prefix: string; dir: string } | null = null;
    for (const [prefix, dir] of Object.entries(this.options.mounts)) {
      if (!url.startsWith(prefix)) continue;
      if (best === null || prefix.length > best.prefix.length) best = { prefix, dir };
    }
    return best;
  }

  #filePathFor(url: string, mount: { prefix: string; dir: string }): string | null {
    const relative = new URL(url).pathname.slice(new URL(mount.prefix).pathname.length).replace(/^\/+/, "");

    const candidate =
      relative === "" || relative.endsWith("/")
        ? join(relative, "index.html")
        : /\.[a-z0-9]+$/i.test(relative)
          ? relative
          : `${relative}.html`;

    // A fixture path is still a path: `../../etc/passwd` must not escape the fixture root.
    const resolved = normalize(join(this.options.root, mount.dir, candidate));
    const base = normalize(join(this.options.root, mount.dir)) + sep;
    return resolved.startsWith(base) ? resolved : null;
  }
}

function notFound(url: string): FetchResult {
  return {
    url,
    finalUrl: url,
    status: 404,
    contentType: "text/html; charset=utf-8",
    body: "<!doctype html><html><body><h1>404</h1></body></html>",
    bytes: 52,
  };
}

/** The standard mount set for the four fixture sites, plus the Appendix B sub-path shape. */
export function fixtureMounts(): Record<string, string> {
  return {
    "https://meridian.test/": "gitlab-like",
    "https://calder.test/": "sparse",
    "https://gone.test/": "broken",
    "https://northwind.test/": "deep",
    "http://localhost:8099/acme/": "acme",
  };
}
