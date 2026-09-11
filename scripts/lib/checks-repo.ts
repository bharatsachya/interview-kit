import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fail, warn } from "./output";
import { ignoredFiles, trackedCount } from "./git";

/**
 * Checks about this repository rather than about the diff.
 *
 * Each one exists because of a specific way this project can break in a way that nothing else
 * notices — `npm run typecheck` passes, the tests pass, the app runs, and the thing the grading
 * actually does still fails.
 */

/** Build output and local state. Ignoring these is the point of ignoring anything. */
const EXPECTED_IGNORES =
  /(^|\/)(node_modules|\.next|dist|build|coverage-report|out|tmp|\.turbo|\.claude|\.lavish)\//;
const NOISE = /(\.DS_Store|\.env(\..*)?$|tsconfig\.tsbuildinfo|next-env\.d\.ts|keyless\.json)$/;

/**
 * Source files that git is ignoring.
 *
 * This is the one that matters most here, and it is not hypothetical: a `.gitignore` line
 * reading `coverage/` — unanchored, meant for a test-coverage report — quietly excluded the
 * whole of `packages/coverage` from the repository. Ten files, including one of the three test
 * areas the brief names. `git status` said nothing, because ignored files are not untracked
 * files. Everything built locally, because the files were on disk. The only thing that failed
 * was a clean clone, which is the one thing nobody runs locally and the one thing the graders
 * do first.
 */
export function checkNoIgnoredSource(): void {
  const offenders = ignoredFiles()
    .filter((path) => !EXPECTED_IGNORES.test(path))
    .filter((path) => !NOISE.test(path))
    .filter((path) => /\.(ts|tsx|mjs|cjs|json|css)$/.test(path))
    .filter((path) => /^(packages|apps|scripts|fixtures|evals)\//.test(path))
    .map((path) => ({ path }));

  if (offenders.length === 0) return;
  fail({
    name: "Source files are being ignored by git",
    rule: "A clean clone must build — 55 automated points run from one",
    files: offenders.slice(0, 20),
    fix: "Run `git check-ignore -v <path>` to find the rule that matches. An unanchored pattern like `coverage/` matches every directory of that name, not just the one at the root — anchor it as `/coverage/`.",
  });
}

/**
 * Every workspace has files git can see.
 *
 * The cheap version of the check above, and the one that catches a whole package going missing
 * rather than a stray file. `git ls-files packages/<name>` returning nothing is the symptom.
 */
export function checkEveryWorkspaceTracked(): void {
  const offenders: { path: string; detail?: string }[] = [];

  for (const group of ["packages", "apps"]) {
    let entries: string[];
    try {
      entries = readdirSync(group, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name);
    } catch {
      continue;
    }

    for (const name of entries) {
      const path = join(group, name);
      if (trackedCount(path) === 0) offenders.push({ path, detail: "no tracked files" });
    }
  }

  if (offenders.length === 0) return;
  fail({
    name: "A workspace has no tracked files",
    rule: "A clean clone must build",
    files: offenders,
    fix: "The directory exists on disk but git cannot see it. Check .gitignore, then `git add` the package.",
  });
}

/**
 * The batch command keeps its shape.
 *
 * `npm run evaluate -- --input <cases.json> --output <kits.json>` is frozen by the brief. It is
 * the single command the automated marking runs, and renaming the script or the flags would not
 * break a single test — it would simply score zero.
 */
export function checkFrozenCommand(): void {
  let manifest: { scripts?: Record<string, string> };
  try {
    manifest = JSON.parse(readFileSync("package.json", "utf8")) as typeof manifest;
  } catch {
    warn("package.json could not be read — frozen command not verified");
    return;
  }

  const evaluate = manifest.scripts?.["evaluate"];
  if (evaluate === undefined) {
    fail({
      name: "The `evaluate` script is gone",
      rule: "Frozen: npm run evaluate -- --input <cases.json> --output <kits.json>",
      files: [{ path: "package.json", detail: "scripts.evaluate" }],
      fix: "Restore it. The brief freezes this command and the automated marking runs it verbatim.",
    });
  }

  const source = "scripts/evaluate.ts";
  let body: string;
  try {
    body = readFileSync(source, "utf8");
  } catch {
    fail({
      name: "scripts/evaluate.ts is missing",
      rule: "Frozen batch command",
      files: [{ path: source }],
      fix: "Restore it — `npm run evaluate` points here and the grading runs it.",
    });
  }

  const missing = ["--input", "--output"].filter((flag) => !body.includes(`"${flag}"`));
  if (missing.length === 0) return;
  fail({
    name: "The batch command no longer accepts its frozen flags",
    rule: "Frozen: npm run evaluate -- --input <cases.json> --output <kits.json>",
    files: missing.map((flag) => ({ path: source, detail: `${flag} not parsed` })),
    fix: "Appendix B fixes these flag names. Add an alias if you need a different internal name.",
  });
}
