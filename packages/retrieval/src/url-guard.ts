import { KitError } from "@trao/contracts";

/**
 * SSRF validation.
 *
 * The application fetches URLs a user supplied. Without a guard, "company website" is an
 * instruction to make the server issue arbitrary requests from inside its own network — at
 * cloud metadata endpoints, at internal admin panels, at anything on localhost.
 *
 * ## Why ALLOW_PRIVATE_HOSTS exists
 *
 * Appendix B's batch harness serves its cases from `http://localhost:8099/acme/`, while the
 * security section says reject loopback. Both are right, for different environments. The flag
 * resolves it: **defaulted off**, turned on only for batch runs, and named in `.env.example` and
 * the README as a deliberate decision rather than an oversight. Getting this wrong fails either
 * their harness or a security review.
 */

export interface UrlGuardOptions {
  /** Off by default. Batch mode turns it on; production never does. */
  allowPrivateHosts?: boolean;
  /**
   * Injected so tests do not depend on DNS. Returns the addresses a hostname resolves to.
   * Defaults to a real lookup.
   */
  resolveHostname?: (hostname: string) => Promise<string[]>;
}

const ALLOWED_PROTOCOLS = new Set(["http:", "https:"]);

/**
 * Validate a URL and return the parsed form.
 *
 * Resolves DNS and checks the **resolved address**, not just the hostname. Checking the name
 * alone is no check at all: a public hostname can have an A record pointing at 169.254.169.254,
 * and every DNS-rebinding write-up starts exactly there.
 */
export async function assertFetchable(rawUrl: string, options: UrlGuardOptions = {}): Promise<URL> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new KitError("INVALID_INPUT", `Not a URL: ${rawUrl}`);
  }

  if (!ALLOWED_PROTOCOLS.has(url.protocol)) {
    throw new KitError("INVALID_INPUT", `Refusing protocol ${url.protocol} for ${rawUrl}`);
  }

  if (options.allowPrivateHosts === true) return url;

  const literal = parseIpLiteral(url.hostname);
  const addresses = literal !== null ? [literal] : await resolve(url.hostname, options);

  if (addresses.length === 0) {
    throw new KitError("COMPANY_UNREACHABLE", `${url.hostname} does not resolve.`, { retryable: true });
  }

  for (const address of addresses) {
    if (isPrivateAddress(address)) {
      throw new KitError("INVALID_INPUT", `Refusing to fetch ${url.hostname}: resolves to private address ${address}.`, {
        details: { hostname: url.hostname, address },
      });
    }
  }

  return url;
}

/** Non-throwing form, for ranking candidate links where a rejection is just a skip. */
export async function isFetchable(rawUrl: string, options: UrlGuardOptions = {}): Promise<boolean> {
  try {
    await assertFetchable(rawUrl, options);
    return true;
  } catch {
    return false;
  }
}

async function resolve(hostname: string, options: UrlGuardOptions): Promise<string[]> {
  if (options.resolveHostname) return options.resolveHostname(hostname);

  const { lookup } = await import("node:dns/promises");
  const results = await lookup(hostname, { all: true });
  return results.map((entry) => entry.address);
}

/** `null` when the hostname is a name rather than a literal address. */
function parseIpLiteral(hostname: string): string | null {
  const unbracketed = hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(unbracketed)) return unbracketed;
  if (unbracketed.includes(":")) return unbracketed; // IPv6 literal
  return null;
}

export function isPrivateAddress(address: string): boolean {
  const normalised = address.toLowerCase().replace(/^\[|\]$/g, "");

  if (normalised.includes(":")) return isPrivateIpv6(normalised);
  return isPrivateIpv4(normalised);
}

function isPrivateIpv4(address: string): boolean {
  const parts = address.split(".").map((part) => Number.parseInt(part, 10));
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true; // Unparseable: refuse.

  const [a, b] = parts as [number, number, number, number];

  if (a === 0) return true; // "this network"
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local, and the cloud metadata endpoint
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 100 && b >= 64 && b <= 127) return true; // carrier-grade NAT
  if (a >= 224) return true; // multicast and reserved
  return false;
}

function isPrivateIpv6(address: string): boolean {
  if (address === "::" || address === "::1") return true;
  // IPv4-mapped (::ffff:127.0.0.1) — judge it by the address it actually maps to.
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(address);
  if (mapped?.[1] !== undefined) return isPrivateIpv4(mapped[1]);

  const head = address.split(":")[0] ?? "";
  if (head.startsWith("fe8") || head.startsWith("fe9") || head.startsWith("fea") || head.startsWith("feb")) {
    return true; // fe80::/10 link-local
  }
  if (head.startsWith("fc") || head.startsWith("fd")) return true; // fc00::/7 unique local
  return false;
}
