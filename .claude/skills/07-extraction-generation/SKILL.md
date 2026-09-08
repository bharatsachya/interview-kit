---
name: 07-extraction-generation
description: Implement requirement extraction from the job description, the company brief, per-category question generation, and derived flashcards. Use this skill whenever working on packages/extraction or packages/generation, parsing a job description into requirements, deciding must vs nice priority, writing prompts for technical behavioural system-design or company-fit questions, generating the company brief, or creating flashcards. Trigger this whenever question generation is about to happen in a single call — the four categories must be four separate calls and the graders check for it.
---

# Extraction and generation

Block H6. Extraction alone is worth **20 points** — the single largest item.

## Extraction — 20 points

JD → `r1..rn`, each with:
- `text` — a phrase from the posting, not a paraphrase
- `kind` — technical | behavioural | domain
- `priority` — must | nice

**Priority comes from how the posting words it.** A "required" line and a "bonus points for"
line are not the same thing. This is the specific thing the rubric names.

**Invent nothing.** The rubric says the must-haves are found, marked correctly, and nothing is
invented. A two-line stub JD must produce few requirements and say so — a thin description
produces a thin kit. Inventing requirements is explicitly worse than reporting there were few.

Also extract `location` if present, empty string otherwise. It is a required Appendix A field.

## Sequencing — this is graded

The brief: the kit must come from a sequence of deliberate steps that respond to what was
actually found, not one prompt returning everything.

- Pasted text needs no retrieval at all.
- A homepage needs crawling before it is useful.
- A hiring-process page, once found, **changes what questions make sense** — a company that
  publishes a take-home followed by a system design round should produce a different kit from
  one that says nothing. Feed hiring-process findings into question generation.
- "Five years of React" leads to technical questions; "mentoring junior engineers" leads to
  behavioural ones. **The two must not come from the same call with the same instructions.**

## Question generation — four separate calls

One call per category: technical, behavioural, system-design, company-fit. Each seeded **only**
with the requirements belonging to it, plus hiring-process context.

This is directly checked. A test must assert `FakeLlmProvider` received four calls with four
distinct prompts, and that a technical requirement never routes into the behavioural call.

Each question carries `requirement_ids`, `category`, `prompt`, `answer_outline`, `difficulty`
(1–3).

## Company brief

Built from crawl + search results only. If nothing was found, **the brief says so honestly**
rather than fabricating. A company you can find nothing about produces an honest brief — the
rubric rewards this more than handling the easy cases well.

Record `sources` and `pages_used` truthfully.

## Flashcards — derived, no LLM

`deriveFlashcards()` is pure and makes **zero** model calls: front from the question prompt,
back from the answer outline, `requirement_ids` carried over. This costs nothing, guarantees
coverage, and keeps quota for extraction.

Practice mode runs on these and is scored, so keep the derivation sensible — front should read
as a prompt, not a truncated paragraph.

## Trace attributes

- `extract_requirements`: jd_chars, requirement_count, must_count, nice_count
- `generate_brief`: sources_used, had_hiring_page, output_chars
- `generate_questions`: **one child span per category** with category, requirements_in,
  questions_out — this is the visible proof categories are generated separately
- `derive_flashcards`: count

## Tests

- A JD with "Required:" and "Nice to have:" sections marks priorities correctly.
- A two-line stub returns few requirements and invents none — assert every requirement's text
  appears in the input.
- Every requirement gets a unique stable id; `kind` is always one of the three allowed values.
- Malformed model output triggers one repair attempt, then fails cleanly.
- Four separate calls with four distinct prompts for the four categories.
- A technical requirement never appears in the behavioural call's input.
- `deriveFlashcards` makes zero LLM calls and carries `requirement_ids` over.
- A sparse fixture site produces an honest brief, not a fabricated one.

All against `FakeLlmProvider`. Wire against fakes first, real provider second.

## Done when

Extraction is right on both a rich JD and a two-line stub, and the four-separate-calls test
passes.
