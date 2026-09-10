# Step-by-step evals

One folder per pipeline step. Each `cases.json` is an array of cases with `input` and
`expected`. Each folder's README says which function it targets and what to assert.

Pure steps (02, 03, 04, 07, 08, 09, 10, 11, 12) are exact: expected output must match.
LLM steps (01, 05, 06) assert properties, and should be run 3 times each — a property
that passes 2/3 is a flaky prompt, not a pass.

Run order matters only for the first time: fix 01 before trusting anything downstream,
because every later step consumes its output.

| Step | Function | Type | Cases |
|---|---|---|---|
| 01 | extractRequirements | LLM | 10 postings |
| 02 | scoreLinks | pure | 5 |
| 03 | classifyContent | pure | 8 |
| 04 | filterRelevance | pure | 4 |
| 05 | generateBrief | LLM | 4 |
| 06 | generateQuestions | LLM+fake | 3 |
| 07 | applyGates + findGaps | pure | 7 |
| 08 | coverageLoop | pure+fake | 4 |
| 09 | buildFallbackQuestion | pure | 4 |
| 10 | deriveFlashcards | pure | 5 |
| 11 | allocateSchedule + repair | pure | 7 |
| 12 | toKitJSON | pure | 3 |

A step is done when every case passes and the trace for that step records the attrs
the case names.
