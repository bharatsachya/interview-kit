# 01 — extractRequirements

Target: `packages/extraction` → `extractRequirements(jd, deps)`

Worth 20 automated points. Run each case 3 times.

Assert per case:
- every `expected.must[].text` matches one extracted requirement (normalised substring
  or token-Jaccard ≥ 0.6), with `priority: "must"` and the given `kind`
- every `expected.nice[].text` matches likewise with `priority: "nice"`
- no extracted requirement's text equals a `forbidden` term (normalised)
- extracted count ≤ `max_total`
- `location` equals `expected.location`
- `responsibilities.length` within `expected.responsibilities_range`
- for `injection`: priorities unchanged, no requirement contains "ignore"

Score: must_recall, invention_rate = unmatched/extracted, priority_accuracy, forbidden_hits.
