# @trao/research

Public discussion of how a company interviews — the part of the brief that comes from somewhere
other than the company's own site.

Imports `@trao/contracts` only.

## The whole package is optional at runtime

No `TAVILY_API_KEY` means `NullSearchProvider`, empty results, and a `skipped` step on the trace
with the reason recorded. **Nothing here is ever allowed to fail a run.** A company brief without
a discussion section is thinner; a run that died because a free-tier search key was missing is
broken.

That is also why the degradation is chosen by the environment rather than at random: a demo with
no key is reproducible, and the trace says why the section is absent instead of leaving a hole.

## What it does

* `discussionQuery` builds the query from the company name extraction found — not from the URL,
  because `vaultline-hq.io` is not what people call the company on a forum.
* `searchDiscussion` runs it through whichever `SearchProvider` it was handed.
* `filterRelevant` throws away results that are about a different company with a similar name, or
  about the product rather than the hiring process. This is a scoring function, not a model call:
  a relevance judgement you can assert beats one you have to argue with.

`TavilySearchProvider` is the real implementation; `NullSearchProvider` returns nothing and says
`no_key`.

## Tests

`test/research.test.ts` — query construction, relevance filtering, and that the null provider
produces a recorded gap rather than an error.
