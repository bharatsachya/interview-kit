# @trao/coverage

Is every must-have requirement actually asked about?

Imports `@trao/contracts` and `@trao/kit`. Pure: no provider, no network, no clock, no tracer —
gap fill receives a `GapFillWriter` function and the pipeline turns the returned per-pass report
into spans.

## Two rules the whole package exists to hold

1. **The model never decides whether a gap is closed. A set difference does.** `detectGaps` is
   arithmetic over `requirementIds`. Asking a model "is this requirement covered now?" gets yes.
2. **The model never assigns requirement ids.** The code attaches them, because the code is the
   one that chose the cluster and asked. `gateQuestionTags` drops any id a question claims that
   it was never shown.

Both are named in the brief as things the application must own, and they are the specific place
where a plausible-looking kit is quietly wrong.

## The loop

`runCoverage` is check → fill → re-check, bounded by `DEFAULT_MAX_EXTRA_PASSES` (2) and
`DEFAULT_MAX_ATTEMPTS_PER_REQUIREMENT`. Two extra passes, not unbounded: each pass costs model
calls, the second pass closes nearly everything the first missed, and a third almost never
changes the answer. The count that actually ran is recorded on the kit as `coverage.passes` —
honestly, never rounded up.

`clusterRequirements` batches related gaps into one call (`MAX_CLUSTER_SIZE`), so five holes are
not five round trips.

## The acceptance gates

`acceptGapFill` is what stops a gap-fill question from closing a gap it does not address:

* `MIN_OVERLAP_RATIO` — the question must actually share content tokens with the requirement.
* `MAX_DUPLICATE_SIMILARITY` — it must not be a paraphrase of a question already in the bank.
* `MIN_PROMPT_TOKENS` — "Tell me about Python" is not a question.
* `AMBIGUOUS_REQUIREMENT_TOKENS` — requirements too vague to verify coverage against.
* `MAX_REQUIREMENT_IDS_PER_QUESTION` — a question claiming to cover six requirements covers none.

A rejection is a `GateRejection` with a reason, which reaches the trace.

## Fallback

When the model cannot produce an accepted question for a must-have, `fallbackQuestion` writes one
from a template (`FALLBACK_TEMPLATES`) with `origin: "fallback"`. Deterministic, obviously
mechanical, and marked as such — a requirement with a plain question about it beats a requirement
with nothing, and the provenance flag means nobody mistakes it for generated work.

Anything still uncovered after all of that is listed in `coverage.uncoveredRequirementIds` and
shipped. Reporting the gap is the correct outcome; looping forever is not.

## Tests

`test/coverage.test.ts`. Coverage checking is one of the three areas the brief names by hand.
