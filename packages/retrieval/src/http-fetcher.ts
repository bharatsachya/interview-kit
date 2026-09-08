import { KitError, type FetchOptions, type FetchResult, type HttpFetcher } from "@trao/contracts";
import { assertFetchable, type UrlGuardOptions } from "./url-guard";
import { DEFAULT_MAX_BYTES, DEFAULT_TIMEOUT_MS, USER_AGENT } from "./crawler";

/**
 * The real fetcher: `fetch`, a timeout, a size cap and a content-type check.
 *
 * Every URL passes the SSRF guard first, including redirect targets — a server that answers a
 * public URL with `302 http://169.254.169.254/` would otherwise walk straight through a guard
 * that only checked the address we started with.
 */

export interface HttpFetcherOptions extends UrlGuardOptions {
  timeoutMs?: number;
  maxBytes?: number;
  userAgent?: string;
  /** Injected only so the tests can drive it without a network. */
  fetchImpl?: typeof fetch;
}

const ACCEPTED_TYPES = ["text/html", "application/xhtml", "text/plain"];

export class LiveHttpFetcher implements HttpFetcher {
  constructor(private readonly options: HttpFetcherOptions = {}) {}

  async fetch(url: string, perRequest: FetchOptions = {}): Promise<FetchResult> {
    const maxBytes = perRequest.maxBytes ?? this.options.maxBytes ?? DEFAULT_MAX_BYTES;
    const timeoutMs = perRequest.timeoutMs ?? this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const doFetch = this.options.fetchImpl ?? globalThis.fetch;

    const validated = await assertFetchable(url, this.options);

    let response: Response;
    try {
      response = await doFetch(validated, {
        redirect: "follow",
        signal: AbortSignal.timeout(timeoutMs),
        headers: { "user-agent": this.options.userAgent ?? USER_AGENT, accept: "text/html,text/plain" },
      });
    } catch (error) {
      throw new KitError("COMPANY_UNREACHABLE", `Could not reach ${url}: ${describe(error)}`, {
        retryable: true,
        cause: error,
      });
    }

    // Re-check after redirects. This is the hole in most hand-rolled SSRF guards.
    if (response.url !== "" && response.url !== validated.toString()) {
      await assertFetchable(response.url, this.options);
    }

    const contentType = response.headers.get("content-type") ?? "";
    if (response.status < 400 && contentType !== "" && !ACCEPTED_TYPES.some((type) => contentType.includes(type))) {
      throw new KitError("INVALID_INPUT", `Refusing content type ${contentType} from ${url}`);
    }

    // Trust the header when it is present, then verify while reading — a wrong or absent
    // Content-Length must not be a way to hand us 50MB.
    const declared = Number.parseInt(response.headers.get("content-length") ?? "", 10);
    if (Number.isFinite(declared) && declared > maxBytes) {
      throw new KitError("INVALID_INPUT", `${url} is ${declared} bytes, which exceeds the ${maxBytes} cap.`);
    }

    const body = await readCapped(response, maxBytes, url);

    return {
      url,
      finalUrl: response.url === "" ? validated.toString() : response.url,
      status: response.status,
      contentType,
      body,
      bytes: Buffer.byteLength(body),
    };
  }
}

/**
 * Read up to the cap and **reject** past it, rather than truncating.
 *
 * Half a page silently passed to a summariser produces a confident brief built on a fragment.
 * Refusing is the honest outcome, and the crawl records the skip.
 */
async function readCapped(response: Response, maxBytes: number, url: string): Promise<string> {
  if (response.body === null) return "";

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        throw new KitError("INVALID_INPUT", `${url} exceeds the ${maxBytes} byte cap.`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  return new TextDecoder().decode(Buffer.concat(chunks));
}

function describe(error: unknown): string {
  if (error instanceof Error) return error.name === "TimeoutError" ? "timed out" : error.message;
  return String(error);
}
