# Claude Code prompt — build the step runner

Read evals/README.md and every evals/steps/*/README.md.

Build `evals/run-step.ts`:

    npm run eval:step -- 07            # run one step
    npm run eval:step -- all           # run every step in order
    npm run eval:step -- 01 --repeat 3 # LLM steps: run N times, report pass rate per case

For each step it loads cases.json, calls the target function named in that step's README
with `input`, and checks every assertion listed in that README against `expected`. Pure
steps must pass 100%. LLM steps (01, 05, 06) report per-case pass rate over the repeats;
anything under 3/3 is listed as flaky.

Output: a table per step (case id, pass/fail, first failing assertion), then a summary line
per step. Write results to evals/results/steps-<timestamp>.json. Exit non-zero if any pure
step fails or any LLM case is below 2/3.

Rules:
- Pure steps run with FakeLlmProvider and FakeFetcher only. If a pure step makes a network
  or LLM call, fail the step with reason "impure".
- LLM steps use the real provider, through the gateway, with the cache DISABLED, so the
  repeat runs measure the prompt and not the cache.
- Step 08 drives the FakeLlmProvider with `input.fake_responses` in order, and asserts the
  fake was called with one requirement per call.
- Step 09 asserts the fake provider's call count is unchanged after the call.
- Requirement matching for step 01 uses normalised substring OR token-Jaccard ≥ 0.6; each
  gold requirement may match at most one extracted requirement.

Do not modify any cases.json to make a step pass. If a case's expectation looks wrong,
say so and stop.

Step 13 loads evals/steps/13-builder-regeneration/_fixtures/base-kit.json as the starting
kit for every case, applies `input.operations` in order through the same functions the API
routes call (never a test-only path), scripts FakeLlmProvider with `input.fake_responses`,
and asserts on both the internal result and toKitJSON(result). "untouched" means deep-equal
to the base fixture record.

Step 14 boots the Express app against the memory adapter with a fake Clerk verifier that
maps tokens "user-a" / "user-b" to user ids and "user-a-expired" to an expired session.
