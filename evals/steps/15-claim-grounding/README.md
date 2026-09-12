# 15 — checkClaims

Target: `packages/generation` → `checkClaims(prose, sources, allowed)`

Pure. Exact: the set of unsupported claim texts must match `expected.unsupported`.

## What this step is for

Extraction has had a grounding check since it was written — `checkGrounding` refuses a
requirement whose distinctive words are not in the posting, because the rubric says **nothing is
invented**. The brief never had one. A requirement the model made up was dropped and recorded,
while a brief asserting that a company processes two billion euros a year and runs on Kafka
shipped to a candidate who was about to walk into an interview believing it.

This step covers the check that closed that gap, and — more importantly — pins the cases where it
must stay quiet. A check that cries wolf on competent prose is one nobody reads, and the failure
mode of *this* guardrail is noise, not silence.

## The line it draws

A brief is a summary. It rewords by design, so token coverage (extraction's test) would flag
every good sentence in it. So only two things are checked, and they are the two that cannot be
reworded and that a reader would act on:

* **Names** — proper nouns and technology names.
* **Numbers** — amounts, years, counts, percentages.

Assert per case:
- `unsupported.map(c => c.text)` equals `expected.unsupported`, in order
- `checked` equals `expected.checked` — zero unsupported out of zero checked is a brief nobody
  could verify, not a brief that passed, and the trace has to be able to tell them apart
- NO LLM call was made (assert fake provider call count unchanged)

## Cases

| id | Covers |
|---|---|
| `faithful-summary` | prose that rewords every sentence and invents nothing — must be silent |
| `invented-technology` | a stack the pages never mention |
| `invented-number` | a figure nothing supports, beside one that is supported |
| `sentence-initial` | ordinary words capitalised for being first — must be silent |
| `self-evident-name` | a name at the start of a sentence, caught on shape alone |
| `told-not-shown` | the company and role reach the prompt as arguments, not as pages |
| `generic-vocabulary` | `API`, `CEO`, `EU` — capitalised, generic, must be silent |
| `nothing-retrieved` | no sources at all: every name in the prose came from somewhere else |
| `repeated-claim` | the same invention three times is one claim |
