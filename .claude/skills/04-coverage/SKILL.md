---
name: 04-coverage
description: Implement coverage gap detection, the second-pass loop, gap-fill acceptance gates, requirement clustering, and deterministic fallback questions. Use this skill whenever working on packages/coverage, uncovered_requirement_ids, the coverage passes field, checking whether every must-have requirement has a question, deciding when to stop looping, or generating a question for a requirement the model failed to cover. Trigger this whenever someone suggests letting the model decide whether a gap is closed or letting it assign its own requirement_ids — both are coverage bugs waiting to happen.
---

# Coverage — the second pass

Block H3. Mandatory test area: **coverage checking**.

## The rule that matters most

**The model never decides whether a gap is closed. Code does.**

Gap detection is a set difference: `musts − requirements referenced by any question = gaps`.
The brief names this as one of two steps that must not be handed to the model.

## The trust problem

If the model returns a question tagged `requirement_ids: ["r7"]`, a naive set difference sees
r7 covered — even when the question is about something else entirely. The model mislabels,
the checker believes it, and the kit ships with a fake pass.

**Fix: the model never assigns ids.** Gap fill calls it with **one requirement at a time** and
asks only for question text. The code attaches `requirement_ids` because the code is the one
that asked. This costs more calls than batching, which is why it applies to gap fill (where
gaps are few) rather than bulk generation.

## Acceptance gates

Before a question counts as closing a gap:

- Reject any requirement id that was not supplied (catches hallucinated ids from the bulk path).
- Reject empty, stub, or near-duplicate questions — normalise and compare against existing.
  Weak models love returning a rephrase of the previous question.
- Keyword-overlap floor against the requirement text. Not semantic, just a shared-term
  threshold — it catches "requirement was Kubernetes, question is about teamwork".

A failed gate leaves the gap open.

## Loop guards

- If a pass closes zero gaps, **stop immediately**. No point running pass 3.
- Hard cap: 2 extra passes.
- Track attempts per requirement so one stubborn requirement cannot eat the whole budget.

Record `coverage.passes` honestly.

## Clustering

One question may cover at most **3** requirements. **The code forms the cluster** — group
uncovered requirements by `kind` plus keyword overlap — then asks the model for one question
covering that coherent cluster.

A requirement that clusters with nothing gets its own question. No orphan is swept into an
unrelated bundle. Tagging one question with every remaining id passes the automated check and
fails the human review instantly.

## Deterministic fallback

After the passes exhaust, **must**-priority requirements still uncovered get a question built
in code, no model involved:

- technical → "The role requires *{text}*. Walk through your experience with it and a hard
  problem you solved."
- behavioural → "The role mentions *{text}*. Describe a time you did this and how it went."
- domain → "This role is in *{text}*. What's your background there, and what's specific about
  the domain?"

Too thin to slot in → fall back to the role title.

**Never infer from tech stack.** "React means they'll ask about hooks" is our assumption, not
the posting's. The two-line-JD test case is designed to catch invented content.

Mark these `origin: "fallback"`.

**Requirements are never generated — only questions.** The requirement list stays strictly what
extraction found in the JD.

Nice-to-haves stay in `uncovered_requirement_ids` so the field means something.

## Tests (mandatory area — write all of these)

- 7 musts, questions covering 5 → exactly the other 2 are returned.
- Nice-to-haves are reported but do not block.
- A pass closing zero gaps stops the loop immediately.
- Hard cap at 2 extra passes even when gaps remain.
- Gate: hallucinated requirement id rejected.
- Gate: near-duplicate question rejected.
- Gate: question with no keyword overlap rejected.
- Gate: a valid question accepted.
- Attempts-per-requirement tracking prevents budget exhaustion on one requirement.
- Clustering never groups more than 3, and never groups across `kind`.
- Fallback output contains no token absent from the requirement text or role title.
- A rich JD produces zero `origin: "fallback"` questions — if fallbacks appear on normal
  descriptions, extraction or generation is broken and this test is how you find out.

## Done when

All tests pass using `FakeLlmProvider`. Zero real API calls.
