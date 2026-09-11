/**
 * A long URL, shortened to the part worth reading.
 *
 * CSS truncation cuts at whatever character the box ends on, which on a company URL means the
 * scheme and `www.` survive — the two least informative things in it — and the host gets clipped
 * halfway through. `https://www.digitalxnode.com/jobs/data-scientist-ai-ml/` becomes
 * `https://www.digitalxnod…`, which names nothing.
 *
 * So the noise is dropped first and the budget spent on the host, which is what identifies the
 * company, with as much path as still fits. Only the middle of the path is elided, so both ends
 * stay: the section it is under and the page it is.
 */
export function glimpseUrl(raw: string, max = 34): string {
  const trimmed = raw.trim();
  if (trimmed === "") return "";

  const withoutScheme = trimmed.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "");
  const withoutWww = withoutScheme.replace(/^www\./i, "");
  const tidy = withoutWww.replace(/\/+$/, "");

  if (tidy.length <= max) return tidy;

  const slash = tidy.indexOf("/");
  // No path to spend the budget on — a very long hostname. Keep the end, which carries the
  // registrable domain, rather than the start, which on these is usually a subdomain.
  if (slash === -1) return `…${tidy.slice(tidy.length - (max - 1))}`;

  const host = tidy.slice(0, slash);
  if (host.length >= max - 2) return `${host.slice(0, max - 1)}…`;

  const path = tidy.slice(slash);
  const room = max - host.length - 1;
  const head = Math.ceil((room - 1) / 2);
  const tail = room - 1 - head;
  return `${host}${path.slice(0, head)}…${tail > 0 ? path.slice(path.length - tail) : ""}`;
}
