#!/usr/bin/env tsx
import { readFileSync } from "node:fs";
import { validateEvaluationOutput } from "@trao/kit";
import { BOLD, DIM, GREEN, RED, RESET, YELLOW } from "./lib/output";

/**
 * Check a batch output file against Appendix B.
 *
 * Uses the repository's own validator rather than a second opinion written here. A hand-rolled
 * assertion in a CI step is a second copy of the spec that nothing keeps in step — the first
 * draft of this one asserted a top-level `results` array, which Appendix B has never had, and it
 * would have passed anything as long as it was wrong in the same way.
 *
 *   npm run check:output -- kits.json
 */
function main(): void {
  const path = process.argv[2] ?? "kits.json";

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    process.stderr.write(
      `\n${RED}${BOLD}✗ ${path} could not be read as JSON${RESET}\n\n` +
        `    ${error instanceof Error ? error.message : String(error)}\n\n` +
        `  ${YELLOW}fix:${RESET} Run the batch command first — it writes this file.\n\n`,
    );
    process.exit(1);
  }

  const result = validateEvaluationOutput(parsed);
  if (!result.ok) {
    process.stderr.write(`\n${RED}${BOLD}✗ ${path} is not Appendix B${RESET}\n\n`);
    for (const issue of result.errors.slice(0, 25)) process.stderr.write(`    ${issue}\n`);
    if (result.errors.length > 25) {
      process.stderr.write(`    ${DIM}…and ${result.errors.length - 25} more${RESET}\n`);
    }
    process.stderr.write(
      `\n  ${YELLOW}fix:${RESET} The output shape is frozen by the brief. Change the projection in ` +
        `packages/kit, never the spec.\n\n`,
    );
    process.exit(1);
  }

  const kits = result.output.kits;
  const ok = kits.filter((entry) => entry.status === "ok").length;
  const failed = kits.length - ok;

  // A failed case is a legitimate outcome — an unreachable company site is one of the fixtures —
  // so it is reported, not treated as an error. An output with no cases at all is not.
  if (kits.length === 0) {
    process.stderr.write(
      `\n${RED}${BOLD}✗ ${path} contains no kits${RESET}\n\n` +
        `  ${YELLOW}fix:${RESET} The run produced an empty envelope. Check the input file was read.\n\n`,
    );
    process.exit(1);
  }

  const detail = failed === 0 ? "" : `${DIM}, ${failed} failed${RESET}`;
  process.stdout.write(`  ${GREEN}✓${RESET} ${path} is Appendix B — ${kits.length} cases, ${ok} ok${detail}\n`);
}

main();
