# 02 — scoreLinks

Target: `packages/retrieval` → `scoreLinks(links, baseUrl)` → `{ hiring: ranked[], about: ranked[] }`

Pure. Exact match on the top result and on the follow decision.

Assert per case:
- `hiring[0].url` equals `expected.top_hiring`
- `about[0].url` equals `expected.top_about` (when set)
- each url in `expected.followed` is marked `follow: true`; each in `expected.not_followed` is `follow: false` with the given reason
- external hiring links are followed only when `hiring score ≥ threshold`
- URLs in `expected.deduped_to_one` collapse to a single candidate
