# 03 — classifyContent

Target: `packages/retrieval` → `classifyContent(cleanedText)` → `{ hiring: 0..1, about: 0..1 }`

Pure. Threshold-based.

Assert per case:
- `hiring >= 0.5` iff `expected.is_hiring_page`
- `about >= 0.5` iff `expected.is_about_page`
- when `expected.headings_preserved` is set, the cleaned text passed in contains those
  `## ` lines (this checks the extractor upstream, not the classifier)
