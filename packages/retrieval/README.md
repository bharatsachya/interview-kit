# @trao/retrieval

Fetching a company site and deciding which of its pages are worth reading.

Imports `@trao/contracts` only. **No LLM anywhere in this package** — link ranking is a scoring
function precisely so the trace can show why each page was chosen.

## Why not a fixed list of paths

The brief says explicitly that hardcoding `/careers`, `/about`, `/jobs` is not sufficient.
Real sites put hiring behind `/company/join-us`, `/life`, or an ATS on another domain entirely.

So `discovery.ts` collects candidates from the page itself — anchors, JSON-LD, framework state
blobs (`__NEXT_DATA__` and friends, which is how a React site that renders nothing server-side
still yields links) and sitemaps — and `ranking.ts` scores them. `scoreLink` returns a breakdown
per scorer, and the crawl records it on the span, so "why did it read *that* page" has an answer
you can read rather than a model you have to trust.

`ATS_HOSTS` handles the case where the hiring page is on Greenhouse or Lever: same employer,
different registrable domain, which `isSameSite` would otherwise reject.

## The crawl, in two hops

`crawlSite` reads the homepage, ranks everything it links to, and fetches the winners. Then it
does it again — with what those pages link to.

The second hop is the one that matters and it was missing: `maxDepth` was an accepted option that
the crawl explicitly discarded, so every page came back at depth 1. That loses the material a
homepage never mentions. A homepage links "Careers"; the careers page links "How we interview",
which is the page actually worth reading. No amount of scoring reaches it, because the scorer was
never shown it.

The second pass is a genuine **re-rank**, not a repeat: it knows something the first could not —
*which page each link was found on*. A link discovered on a page the hiring scorer chose carries
a bonus, because "Our process" is a weak anchor from a homepage and a strong one from the careers
page. The bonus is small on purpose: it reorders links already worth considering and cannot
promote one that scored nothing, or the crawl would fetch the careers page's privacy policy.

Same-site only at depth 2 — one hop off the domain is already the rule for an ATS, and following
an external page's external links is a crawl of somebody else's site. `pages_second_hop` on the
trace says how many came from it.

`crawlSite` is bounded by a depth cap, a page cap, a byte cap, a per-request timeout and a
requests-per-second limit. It parses and honours `robots.txt`, and it reports every URL it did
*not* fetch with a `SkipReason` — a crawl that quietly drops pages is a crawl you cannot debug.

`html.ts` does the cleaning: `cleanText` strips script, style, nav and footer noise before any of
it reaches a prompt; `extractLinks` and `pageTitle` do the rest.

## SSRF

`url-guard.ts` is the one that matters for security. `assertFetchable` rejects non-HTTP schemes,
credentials in the URL, and any host that resolves to a private or loopback address — checked
after DNS resolution, because `evil.com` can resolve to `127.0.0.1`.

`ALLOW_PRIVATE_HOSTS` is the deliberate escape hatch, and it exists because **Appendix B's own
example serves fixtures from `http://localhost:8099/acme/`**. It defaults on in batch mode and
off everywhere else.

## Fixture sites

`FakeFetcher` + `fixtureMounts` serve `fixtures/sites/*` from disk with no network at all. The
sites are chosen to be awkward on purpose: `spa` renders nothing server-side, `nextjs` hides its
links in framework state, `deep` needs three hops, `sparse` has almost nothing to find,
`gitlab-like` has a `robots.txt` that must be obeyed, `ats` and `greenhouse` put hiring on
another host.

## Tests

`test/crawler.test.ts` (ranking, depth, robots, skip reasons) and `test/url-guard.test.ts`.
