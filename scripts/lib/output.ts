/**
 * How a failed check reports itself.
 *
 * One shape for every failure: what broke, which rule it came from, the offending files, and a
 * fix. The last one is the point. "lint failed, see output above" is a message that makes the
 * reader do the work of finding out what to do next, and a gate that is annoying to satisfy is
 * a gate people learn to pass with `--no-verify`.
 */

export const RESET = "[0m";
export const BOLD = "[1m";
export const DIM = "[2m";
export const RED = "[31m";
export const GREEN = "[32m";
export const YELLOW = "[33m";

export interface CheckFailure {
  /** What failed, in the reader's terms. */
  name: string;
  /** The rule it comes from, when there is a written one to point at. */
  rule?: string;
  files: { path: string; detail?: string }[];
  /** What to do about it. Never optional — a failure with no fix is a complaint. */
  fix: string;
}

export function fail(failure: CheckFailure): never {
  const rule = failure.rule === undefined ? "" : `  ${DIM}(${failure.rule})${RESET}`;
  process.stderr.write(`\n${RED}${BOLD}✗ ${failure.name}${RESET}${rule}\n\n`);
  for (const item of failure.files) {
    const detail = item.detail === undefined ? "" : `  ${DIM}${item.detail}${RESET}`;
    process.stderr.write(`    ${item.path}${detail}\n`);
  }
  process.stderr.write(`\n  ${YELLOW}fix:${RESET} ${failure.fix}\n\n`);
  process.exit(1);
}

export function ok(name: string): void {
  process.stdout.write(`  ${GREEN}✓${RESET} ${name}\n`);
}

/**
 * Something is not being checked, and the reader should know rather than assume it passed.
 *
 * Distinct from a failure on purpose: a missing optional tool is a gap in the check, not a fault
 * in the code, and silently skipping is how a secrets scan comes to mean nothing.
 */
export function warn(message: string, hint?: string): void {
  process.stdout.write(`  ${YELLOW}⚠${RESET} ${message}\n`);
  if (hint !== undefined) process.stdout.write(`    ${DIM}${hint}${RESET}\n`);
}
