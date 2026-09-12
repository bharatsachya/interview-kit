# fixtures

Everything that lets the build run with no API key, no network and no database.

## `fake-llm-responses.ts`

The canned response table `FakeLlmProvider` answers from, keyed by `purpose` —
`extract_requirements`, `generate_brief`, `generate_questions:technical`, `gap_fill`, and so on.

It is what makes `--fake-llm` a *full* run rather than a stub: the responses are shaped like real
model output, so extraction's grounding check, the question gates and the coverage loop all
actually execute against them. Combined with `SequentialIdGenerator` the output is
byte-identical between runs, which is what lets the eval suite diff it.

## `sites/`

Static HTML served by `FakeFetcher` through `fixtureMounts`, with no network at all. Each site
exists to be awkward in one specific way:

| Site | The problem it poses |
|---|---|
| `acme` | the ordinary case — a real `/careers` under `/about` |
| `sparse` | almost nothing to find; the brief has to say so rather than invent |
| `deep` | the hiring page is three hops in |
| `spa` | renders nothing server-side, and has a `sitemap.xml` to be found instead |
| `nextjs` | links live in framework state (`__NEXT_DATA__`), not in anchors |
| `gitlab-like` | a `robots.txt` with real rules that must be obeyed |
| `ats` / `greenhouse` | hiring is on another registrable domain — same employer, different host |

Together they are the argument against a hardcoded path list, which the brief says explicitly is
not sufficient.

## `jds/`

Real job descriptions, used by the extraction tests and as `--jd` input to `npm run dev:kit`.

## `cases.json`

A ready-made Appendix B input, so `npm run evaluate -- --input fixtures/cases.json --output
kits.json` works immediately from a clean clone.
