#!/usr/bin/env tsx
import { spawnSync } from "node:child_process";
import { BOLD, DIM, GREEN, RED, RESET, YELLOW } from "./lib/output";
import { checkEveryWorkspaceTracked, checkNoIgnoredSource } from "./lib/checks-repo";

/**
 * The pre-push gate: the whole repository, and the things only a whole run can tell you.
 *
 * Every step runs even after one fails, and the summary at the end lists all of them. Stopping
 * at the first failure means fixing one thing, waiting, and finding the next — three times over
 * for what one run already knew.
 *
 * The smoke run is the step worth the seconds. `npm run typecheck` proves the code compiles and
 * `npm test` proves the units behave, but neither runs the pipeline end to end or validates the
 * output against Appendix B, and that output is what the marking reads.
 */
interface StepResult {
  name: string;
  status: "pass" | "fail";
  detail?: string;
}

function runStep(name: string, command: string, args: string[]): StepResult {
  process.stdout.write(`\n${BOLD}▶ ${name}${RESET} ${DIM}(${command} ${args.join(" ")})${RESET}\n`);
  const result = spawnSync(command, args, { stdio: "inherit" });
  return result.status === 0
    ? { name, status: "pass" }
    : { name, status: "fail", detail: `exit ${result.status ?? "?"}` };
}

function guard(name: string, check: () => void): StepResult {
  process.stdout.write(`\n${BOLD}▶ ${name}${RESET}\n`);
  try {
    check();
    return { name, status: "pass" };
  } catch (error) {
    return { name, status: "fail", detail: error instanceof Error ? error.message : String(error) };
  }
}

function main(): void {
  const results: StepResult[] = [
    // Cheapest first, and the one a clean clone would otherwise be the first to notice.
    guard("clean-clone integrity", () => {
      checkNoIgnoredSource();
      checkEveryWorkspaceTracked();
    }),
    runStep("typecheck (every workspace against its own tsconfig)", "npm", ["run", "typecheck"]),
    runStep("tests", "npm", ["test"]),
    runStep("smoke (pipeline end to end, Appendix B validated)", "npm", ["run", "smoke"]),
  ];

  process.stdout.write(`\n${BOLD}Pre-push summary${RESET}\n`);
  for (const result of results) {
    const mark = result.status === "pass" ? `${GREEN}✓${RESET}` : `${RED}✗${RESET}`;
    const detail = result.detail === undefined ? "" : `  ${DIM}${result.detail}${RESET}`;
    process.stdout.write(`  ${mark} ${result.name}${detail}\n`);
  }

  const failed = results.filter((result) => result.status === "fail");
  if (failed.length > 0) {
    const plural = failed.length === 1 ? "" : "s";
    process.stderr.write(
      `\n${RED}${BOLD}✗ pre-push failed${RESET} — fix the ${failed.length} failing step${plural} above.\n` +
        `  ${YELLOW}urgent?${RESET} ${DIM}git push --no-verify${RESET} pushes anyway; CI still runs every one of these.\n\n`,
    );
    process.exit(1);
  }

  process.stdout.write(`\n${GREEN}${BOLD}✓ pre-push passed${RESET}\n`);
}

main();
