---
name: 06-retrieval
description: Implement company site crawling, heuristic link ranking to find hiring pages, robots.txt handling, HTML cleaning, SSRF validation with the env-gated loopback exception, and the fixture sites used by tests. Use this skill whenever working on packages/retrieval or packages/research, fetching external pages, following relative links, choosing which links are worth fetching, searching for public discussion of a company's interview process, Tavily, or validating URLs before fetching them. Trigger this whenever code is about to hardcode a path like /careers — the brief says explicitly that a fixed list of paths is not sufficient.
---

# Retrieval and research

Block H5. Fixtures built here serve the dev runner, the tests, and the batch cases.

## Crawl budget

- Max **8 pages** per company site
- Depth **2**
- **5-second** per-request timeout
- **500KB** cap per page
- ~2 requests/second, back off on failure

Skip and report a source that cannot be retrieved. Never fail the whole run over one page.

## Hiring page discovery

This is the interesting half. Companies bury hiring pages at unpredictable paths — /careers,
/jobs, a handbook, an engineering blog. **A fixed list of paths is not sufficient**, and the
brief says so directly.

Crawl, score links heuristically (anchor text, URL tokens, depth), fetch the top candidates.
**No LLM.** A scoring function is inspectable in the trace; a model call is not, and this step
is worth no points on its own.

Respect robots.txt. Record skipped URLs — honest reporting is explicitly rewarded.

## Security

- Validate external URLs before fetching. Reject private and loopback addresses **in
  production**.
- **Env-gated exception:** Appendix B's example serves from `http://localhost:8099/acme/`, so
  batch mode needs `ALLOW_PRIVATE_HOSTS=true`, defaulted off. Document this in the README as a
  deliberate decision — getting it wrong either fails their harness or fails the security
  review.
- Resolve DNS and check the resolved IP, not just the hostname.
- Restrict to expected content types and sizes.
- **Never assume a particular host, and always follow relative links.** The batch harness may
  serve from a local address; a hardcoded host assumption breaks every case at once.

## Research — public discussion

Provider: **Tavily** (1,000 credits/month, no card, returns content rather than links, which
saves a fetch-and-clean round trip). Serper is the documented alternative — write the step
against a small `SearchProvider` interface so swapping is a config change.

Brave's free tier was withdrawn. Do not use it.

**The key must be optional.** No key → `NullSearchProvider` returns empty and the step is
recorded as `skipped`, not thrown. The wiring decides; the pipeline never branches on key
presence.

## Fixture sites

`./fixtures/sites/` holds static HTML trees served by `FakeFetcher`:

- `gitlab-like/` — obvious `/handbook/hiring` deep link
- `sparse/` — homepage only, no about, no careers → the honest-brief path
- `broken/` — 404 on everything → `COMPANY_UNREACHABLE`
- `deep/` — hiring page at an unpredictable path → tests ranking, not path guessing

These double as batch test cases and exercise the two hard cases the brief says it tests
against: a two-line description, and a company with no hiring page anywhere.

## Trace attributes

- `fetch_homepage`: url, status, bytes, content_type, redirected_to
- `crawl_site`: links_found, links_scored, pages_fetched, pages_skipped, robots_blocked,
  top 5 scored links with scores
- `search_discussion`: provider, query, result_count, or `skipped: no_key`

## Tests

- SSRF: `127.0.0.1`, `10.x`, `192.168.x`, `169.254.169.254` rejected when
  `ALLOW_PRIVATE_HOSTS` is off, allowed when on.
- Relative links resolve correctly against a non-root base path.
- Crawl stops at the page budget and at depth 2.
- robots.txt disallow honoured and the skip recorded.
- Ranking puts `/handbook/hiring` above `/blog/post-42` given realistic anchor text.
- Oversized page rejected, not silently truncated.
- A 404 on one page does not abort the crawl.
- No API key → search returns empty and marks skipped, does not throw.
- Provider error → same. This step is never fatal.

All tests use `FakeFetcher` against the fixture sites. No live network.

## Done when

All four fixture sites produce sensible retrieval results, and the SSRF gate flips correctly
with the env flag.
