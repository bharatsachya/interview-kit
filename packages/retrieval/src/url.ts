/**
 * URL normalisation, for deduplication.
 *
 * `/careers`, `/careers/` and `/careers?utm_source=nav` are one page and one place in the page
 * budget. Before this, a homepage that linked to its careers page from the nav, the footer and a
 * banner spent three of eight fetches on the same document — and the trace showed three
 * candidates where there was one.
 */

/** Parameters that identify where a click came from, never which page it lands on. */
const TRACKING_PARAMS =
  /^(utm_[a-z_]+|gclid|fbclid|msclkid|mc_[a-z]+|_hs[a-z]+|ref|referrer|source|campaign|igshid|si|spm|trk|trk_[a-z]+)$/i;

/**
 * A canonical form for comparison. Not for display, and not for fetching — fetch the URL you
 * were given, then normalise whatever it redirected to.
 */
export function normaliseUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return raw.trim();
  }

  url.hash = "";
  url.hostname = url.hostname.toLowerCase().replace(/^www\./, "");
  url.protocol = url.protocol.toLowerCase();

  // Default ports are noise: https://a.test:443/x and https://a.test/x are one page.
  if ((url.protocol === "https:" && url.port === "443") || (url.protocol === "http:" && url.port === "80")) {
    url.port = "";
  }

  for (const key of [...url.searchParams.keys()]) {
    if (TRACKING_PARAMS.test(key)) url.searchParams.delete(key);
  }
  // Stable order, so ?a=1&b=2 and ?b=2&a=1 agree.
  url.searchParams.sort();

  // A trailing slash is a formatting choice, except at the root where it is the path.
  url.pathname = url.pathname.replace(/\/index\.html?$/i, "/").replace(/(.)\/+$/, "$1");

  return url.toString();
}

export function hostOf(raw: string): string {
  try {
    return new URL(raw).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

/**
 * Same site, allowing for the subdomain a company keeps its careers pages on.
 *
 * `careers.acme.com` is Acme; `acme.greenhouse.io` is a third party that happens to host Acme's
 * jobs. The first is same-site, the second is an external hop with its own rules.
 */
export function isSameRegistrableSite(candidate: string, reference: string): boolean {
  const a = hostOf(candidate);
  const b = hostOf(reference);
  if (a === "" || b === "") return false;
  if (a === b) return true;
  return a.endsWith(`.${b}`) || b.endsWith(`.${a}`);
}
