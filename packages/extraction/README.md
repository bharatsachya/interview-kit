# @trao/extraction

Job description → requirements. **Worth 20 points, the largest single item in the rubric.**

Imports `@trao/contracts` and `@trao/kit`.

## The division of labour

The model reads. The code decides what is real, what it is called, and — where the posting says
so — how important it is. Every piece of that is here rather than in the prompt, because a
requirement list is the input to everything downstream: coverage counts it, the schedule weights
by it, and a hallucinated must-have poisons the whole kit.

| Concern | Where it is decided |
|---|---|
| What the posting says | the model, once, with the JD in an `untrustedBlock` |
| Whether a requirement is actually in the text | `grounding.ts` — `checkGrounding` |
| Where in the text it came from | `spans.ts` — `locateSpan`, with a confidence floor |
| `must` vs `nice` | `sections.ts` — the posting's own headings and inline wording |
| Near-duplicates and example lists | `merge.ts` — `collapseExampleLists` |
| Whether the whole extraction is believable | `extract.ts` — `sanityCheck` |

## Grounding, and why it is a hard gate

`MIN_GROUNDING_RATIO` is the share of a requirement's content tokens that must appear in the
posting. Below it, the requirement is dropped and recorded as a `DroppedRequirement` with a
reason — visible on the trace rather than silently discarded.

This is the mechanism that makes "a thin JD produces a thin kit that says so" true. Inventing
requirements is worse than reporting there were few, because the candidate then prepares for a
job nobody advertised.

## Priority comes from the posting, not the model

`priorityFromPosting` reads the document's own structure — a "Required" heading, a "Nice to have"
heading, "bonus", "a plus", "ideally". `PRIORITY_SANITY_MIN_CHARS` guards the case where a
posting is too short for its sections to mean anything. A model asked to rate importance produces
a plausible ranking with nothing behind it; a heading is evidence.

## Example lists

"Experience with Kafka, Kinesis or RabbitMQ" is one requirement, not three, and a model reliably
returns three. `collapseExampleLists` merges them; `isBareName` is what stops "Kafka" on its own
from being treated as a requirement at all.

## Tests

`test/extract.test.ts`, with postings in `fixtures/jds/`. The eval suite's step 01 covers the
same function against ten real postings, three runs each — a property that passes 2/3 is a flaky
prompt, not a pass.
