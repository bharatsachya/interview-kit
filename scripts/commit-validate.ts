#!/usr/bin/env tsx
import { stagedFiles } from "./lib/git";
import { BOLD, DIM, GREEN, RESET, ok } from "./lib/output";
import {
  checkLargeFiles,
  checkLockfiles,
  checkMergeMarkers,
  checkWhitespaceAndEof,
} from "./lib/checks-staged";
import { checkEveryWorkspaceTracked, checkFrozenCommand, checkNoIgnoredSource } from "./lib/checks-repo";
import { checkSecrets } from "./lib/checks-tools";

/**
 * The pre-commit gate: fast, and about the change rather than the repository.
 *
 * Everything here reads the index and finishes in well under a second, because a hook that makes
 * you wait is a hook you start skipping. The slow, whole-repository work — typecheck, tests, the
 * pipeline — is in pre-push, where waiting is already expected.
 *
 * Two repository-wide checks are here anyway, and both earn the exception: an ignored source
 * file and a renamed batch command are cheap to detect and expensive to notice late. The first
 * only surfaces in a clean clone, the second only surfaces in the marking.
 */
function main(): void {
  const files = stagedFiles();
  if (files.length === 0) {
    process.stdout.write(`${DIM}No staged files. Nothing to check.${RESET}\n`);
    return;
  }

  const plural = files.length === 1 ? "" : "s";
  process.stdout.write(`${BOLD}Pre-commit${RESET} ${DIM}(${files.length} staged file${plural})${RESET}\n`);

  checkLockfiles(files);
  ok("lockfile guard");

  checkLargeFiles(files);
  ok("large file blocker");

  checkMergeMarkers(files);
  ok("merge conflict markers");

  checkWhitespaceAndEof(files);
  ok("trailing whitespace + final newline");

  checkNoIgnoredSource();
  checkEveryWorkspaceTracked();
  ok("no source hidden by .gitignore");

  checkFrozenCommand();
  ok("batch command intact");

  // Only claim it passed if it ran. A tick next to a check that was skipped is worse than no
  // check at all — it is a check the reader now believes in.
  if (checkSecrets()) ok("secrets scan");

  process.stdout.write(`\n${GREEN}${BOLD}✓ pre-commit passed${RESET}\n`);
}

main();
