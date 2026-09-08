/**
 * Cheap, local guesses at the role title and company name.
 *
 * Deliberately not a model call. The intake needs something to show back to the person the
 * instant they paste — "Got it: Senior Backend Engineer at Vaultline" — and spending a request
 * and two seconds of latency on a line the user can see and correct themselves would be waste.
 * Extraction proper happens in the pipeline, against the whole description.
 */

/** The first substantial line of a posting is its title, near enough, often enough. */
export function guessTitle(jd: string): string {
  const line = jd
    .split("\n")
    .map((candidate) => candidate.trim())
    .find((candidate) => candidate.length > 2 && candidate.length < 120);
  return line ?? "";
}

export function guessCompany(companyUrl: string): string {
  let host: string;
  try {
    host = new URL(companyUrl).hostname;
  } catch {
    return "";
  }

  const withoutWww = host.replace(/^www\./, "");
  // Drop the TLD and any second-level suffix like .co.uk, then take the remaining label.
  const label = withoutWww.split(".")[0] ?? "";
  if (label === "" || label === "localhost") return "";
  return label.charAt(0).toUpperCase() + label.slice(1);
}

/** Accepts "vaultline.com" as readily as a full URL — people type the former. */
export function normaliseCompanyUrl(input: string): string | null {
  const trimmed = input.trim();
  if (trimmed === "") return null;
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const url = new URL(withScheme);
    if (url.hostname === "" || !url.hostname.includes(".")) {
      // Loopback is legitimate — Appendix B serves from it — so allow a host with a port.
      if (!/^(localhost|127\.0\.0\.1)$/i.test(url.hostname)) return null;
    }
    return url.toString();
  } catch {
    return null;
  }
}
