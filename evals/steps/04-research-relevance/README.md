# 04 — filterRelevance

Target: `packages/research` → `filterRelevance(results, { company, domain })` → `{ kept[], filtered[{id, reason}] }`

Pure. Exact match on kept ids and on filter reasons.

Assert per case:
- kept ids equal `expected.kept` (order-insensitive)
- filtered ids and reasons equal `expected.filtered`
- no reddit.com / glassdoor.com / x.com URL is ever *fetched* — kept results are used as
  returned by the provider, never re-fetched
