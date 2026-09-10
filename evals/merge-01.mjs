#!/usr/bin/env node
/**
 * Step 01 was run in two invocations (1 pass, then 2 passes) to stay inside the free-tier
 * quota. This merges them into the single 3-run record the step README asks for, recomputing
 * pass rates, per-assertion rates and mean scores across all three.
 */
import { mkdirSync, readFileSync, writeFileSync, cpSync } from "node:fs";
import { join } from "node:path";

const DIR = "step-01-extractrequirements";
const parts = ["out/evals/llm-01-alt-model", "out/evals/llm-01-alt-model-r2"].map((d) =>
  JSON.parse(readFileSync(join(d, DIR, "results.json"), "utf8")),
);

const byId = new Map();
for (const part of parts) {
  for (const outcome of part.outcomes) {
    const existing = byId.get(outcome.id);
    if (existing === undefined) byId.set(outcome.id, { id: outcome.id, runs: [...outcome.runs] });
    else existing.runs.push(...outcome.runs);
  }
}

const cases = [];
for (const outcome of byId.values()) {
  const runs = outcome.runs.length;
  const passed = outcome.runs.filter((r) => r.pass).length;

  const names = new Map();
  for (const run of outcome.runs) {
    for (const a of run.assertions) {
      const e = names.get(a.name) ?? { pass: 0, total: 0 };
      e.total += 1;
      if (a.pass) e.pass += 1;
      names.set(a.name, e);
    }
  }
  const rates = {};
  for (const [name, e] of names) if (e.pass < e.total) rates[name] = `${e.pass}/${e.total}`;

  const scored = outcome.runs.filter((r) => r.scores);
  const scores = {};
  for (const key of Object.keys(scored[0]?.scores ?? {})) {
    scores[key] = Number((scored.reduce((s, r) => s + (r.scores[key] ?? 0), 0) / scored.length).toFixed(3));
  }

  const firstFailure = outcome.runs.find((r) => !r.pass)?.assertions.find((a) => !a.pass);
  cases.push({
    id: outcome.id,
    runs,
    passed,
    pass_rate: Number((passed / runs).toFixed(3)),
    flaky: passed > 0 && passed < runs,
    ...(firstFailure ? { first_failure: firstFailure.detail ? `${firstFailure.name} — ${firstFailure.detail}` : firstFailure.name } : {}),
    ...(Object.keys(rates).length ? { assertion_pass_rates: rates } : {}),
    scores,
  });
}

const merged = {
  ...parts[0],
  cases,
  totals: { cases: cases.length, fully_passing: cases.filter((c) => c.passed === c.runs).length, runs: cases.reduce((n, c) => n + c.runs, 0) },
  durationMs: parts.reduce((n, p) => n + p.durationMs, 0),
  merged_from: ["out/evals/llm-01-alt-model (1 pass)", "out/evals/llm-01-alt-model-r2 (2 passes)"],
  model_note:
    "Run with GEMINI_MODEL_QUALITY=gemini-flash-lite-latest. The configured quality model (gemini-flash-latest → gemini-3.8-flash) refused every request with a free-tier 429 for the whole session; see out/evals/llm-01-rerun. These numbers are therefore a floor, measured on a weaker model than extraction is meant to use.",
  outcomes: [...byId.values()],
};

const out = join("out/evals/llm-01-merged", DIR);
mkdirSync(out, { recursive: true });
writeFileSync(join(out, "results.json"), JSON.stringify(merged, null, 2));
cpSync(join("out/evals/llm-01-alt-model-r2", DIR, "trace.json"), join(out, "trace.json"));
cpSync(join("out/evals/llm-01-alt-model-r2", DIR, "trace.txt"), join(out, "trace.txt"));

for (const c of cases) {
  console.log(`${c.id.padEnd(28)} ${c.passed}/${c.runs}  recall=${c.scores.must_recall} invention=${c.scores.invention_rate} priority=${c.scores.priority_accuracy} forbidden=${c.scores.forbidden_hits}`);
}
console.log(`\n${merged.totals.fully_passing}/${merged.totals.cases} cases fully passing over 3 runs each`);
