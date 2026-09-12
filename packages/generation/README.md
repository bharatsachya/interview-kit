# @trao/generation

The company brief, the four question categories, the derived flashcards, and the gap-fill writer.

Imports `@trao/contracts` and `@trao/kit`. Receives an `LlmProvider`; **never constructs one**.

## Four separate calls, and the graders check

`generateQuestions` fans out to `generateCategoryQuestions` four times — technical, behavioural,
system-design, company-fit — and each is a distinct `purpose`, so it gets its own span and its
own cache key. One call returning all four is the thing the brief is looking for and would be
visible in the trace immediately.

They run **concurrently**, which removes twelve to fifteen seconds of stacked round trips from a
ninety-second run. Rate limiting is unaffected: the gateway's buckets serialise the requests
themselves. Ids are assigned *after* all four settle, in category order, so a `--fake-llm` run
stays byte-identical regardless of which provider answered first.

`requirementsFor` decides what each call may see. A technical requirement never reaches the
behavioural call. System design takes only the requirements that read as architectural, and takes
none if there are none — an empty category is honest, and `generateCategoryQuestions` skips the
call entirely rather than asking a model for five questions about nothing. `responsibilitiesFor`
passes the role's actual work as *context*, never as seeds: a question grounded in a
responsibility carries no requirement id, which is true — it covers work, not a stated
requirement.

## The brief

`generateBrief` writes from the crawled pages and the discussion results. Two rules are in the
prompt because they are the ones a model ignores:

* If the material does not say what the company does, say so — do not infer it from the name.
* If nothing describes how they interview, return an **empty string** for `hiring_process`. A
  plausible invented process is worse than nothing, because the candidate prepares for it.

When there is nothing at all to summarise, `honestlyEmpty` writes the brief in code and sets
`fabricationAvoided` — no model call is made. When a hiring page *was* found and the model still
said nothing, that becomes a recorded gap rather than an unexplained blank section.

## Flashcards

`deriveFlashcards` makes **no model call**. A card is a projection of a question it already has,
which is why it can carry `questionId` and follow its source through a regeneration or an
archive.

## Gap fill

`createGapFillWriter` is the function `@trao/coverage` calls when a must-have has no question.
Note what it is not asked for: `requirement_ids`. The writer is never told to label its own
output, so it cannot mislabel it — the code attaches the id, because the code chose the cluster.

## Steering a rewrite

`steerLines` renders the free text a user typed in the composer when asking for a rewrite. It is
fenced with `untrustedBlock` even though it came from the signed-in user — a posting pasted off a
site can be re-pasted into that field, and an instruction block trusted for one input is a hole
for every input that can reach it. The wrapper grants exactly one power (change the emphasis,
difficulty and subject matter of *this section*) and refuses the rest.

## Checking what the model asserted

`checkClaims` compares the prose a call produced against the material that call was given, and
reports the **names** and **numbers** nothing supports. It exists because extraction had a
grounding check from the start and the brief did not — an invented requirement was dropped, an
invented fact about the company shipped.

It is not `checkGrounding`. A requirement is a phrase lifted from a document, so token coverage is
the right test; a brief is a summary that rewords by design, and the same test would flag every
good sentence in it. Names and numbers are what cannot be reworded and what a candidate would
prepare against.

Nothing is removed — the count and a sample go on the span. That keeps a false positive cheap,
which is what makes it safe to run over question text too, where invention is partly the point.
Its limit is that it tests presence, not entailment: `EXPLAIN` against a requirement that says
"query tuning" is flagged, which is why question-side claims are recorded and never acted on.

## Tests

`test/generation.test.ts` — including that the four calls are four calls, that they overlap in
time, and that no category's prompt contains another category's requirement ids.
`test/claims.test.ts` — mostly cases the check must stay *quiet* on, because its failure mode is
noise. `evals/steps/15-claim-grounding` is the regression suite; one of its cases found a real
hole the unit tests had missed.
