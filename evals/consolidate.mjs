#!/usr/bin/env node
/**
 * Assemble the authoritative run for each step into out/evals/final/.
 *
 * Several steps were re-run after a harness fix or a quota wall; this records which run each
 * step's numbers come from, and copies that run's results and trace verbatim. Nothing is
 * deleted — the source run directories stay where they are.
 */
import { cpSync, mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

const ROOT = "out/evals";
const FINAL = join(ROOT, "final");

/** step id → [source run directory, why that run is the authoritative one] */
const SOURCES = {
  "01": ["llm-01-merged", "3 passes merged from llm-01-alt-model + llm-01-alt-model-r2, run on gemini-flash-lite-latest. The configured quality model returned 429 for every request all session — see llm-20260909T2120 and llm-01-rerun for that evidence"],
  "02": ["pure-20260909T211916", "first run"],
  "03": ["pure-20260909T211916", "first run"],
  "04": ["pure-20260909T211916", "first run"],
  "05": ["llm-20260909T2120", "first run"],
  "06": ["llm-20260909T2120", "first run"],
  "07": ["pure-20260909T211916", "first run"],
  "08": ["pure-08-rerun2", "re-run after fixing a harness bug: the stub schema had no safeParse, so every gap-fill draft was discarded before the gate saw it"],
  "09": ["pure-20260909T211916", "first run"],
  "10": ["pure-20260909T211916", "first run"],
  "11": ["pure-11-rerun", "re-run after gating the front-loading assertion on expected.max_difficulty_by_day, which the step README conditions it on"],
  "12": ["pure-20260909T211916", "first run"],
};

mkdirSync(FINAL, { recursive: true });
const steps = [];

for (const [id, [runDir, provenance]] of Object.entries(SOURCES)) {
  const base = join(ROOT, runDir);
  if (!existsSync(base)) throw new Error(`missing run directory ${base}`);
  const dirName = readdirSync(base).find((d) => d.startsWith(`step-${id}-`));
  if (dirName === undefined) throw new Error(`no step-${id}-* inside ${base}`);

  const target = join(FINAL, dirName);
  cpSync(join(base, dirName), target, { recursive: true });

  const results = JSON.parse(readFileSync(join(target, "results.json"), "utf8"));
  writeFileSync(join(target, "PROVENANCE.txt"), `source run: ${runDir}\nreason: ${provenance}\n`);

  steps.push({
    step: results.step,
    name: results.name,
    target: results.target,
    kind: results.kind,
    adapter: results.adapter ?? null,
    source_run: runDir,
    provenance,
    totals: results.totals,
    duration_ms: results.durationMs,
    cases: results.cases.map((c) => ({
      id: c.id,
      pass_rate: c.pass_rate,
      passed: c.passed,
      runs: c.runs,
      first_failure: c.first_failure ?? null,
      scores: c.scores ?? null,
    })),
  });
}

const summary = {
  generated_at: new Date().toISOString(),
  note: "One entry per pipeline step. `source_run` names the sibling directory the numbers came from; those directories are kept.",
  steps,
  totals: {
    steps: steps.length,
    cases: steps.reduce((n, s) => n + s.totals.cases, 0),
    fully_passing: steps.reduce((n, s) => n + s.totals.fully_passing, 0),
  },
};
writeFileSync(join(FINAL, "summary.json"), JSON.stringify(summary, null, 2));

for (const s of steps) {
  console.log(`${s.step}  ${s.name.padEnd(32)} ${String(s.totals.fully_passing).padStart(2)}/${String(s.totals.cases).padEnd(2)}  ${s.kind.padEnd(13)} ← ${s.source_run}`);
}
console.log(`\n${summary.totals.fully_passing}/${summary.totals.cases} cases fully passing across ${summary.totals.steps} steps`);
console.log(`Written to ${FINAL}`);
