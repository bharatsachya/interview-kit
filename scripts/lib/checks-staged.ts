import { fail } from "./output";
import { isTextLikely, stagedBlobContent, stagedBlobSize } from "./git";

const MAX_FILE_BYTES = 1024 * 1024;

/**
 * This repository is npm. One lockfile, and it is `package-lock.json`.
 *
 * A second lockfile is not a style preference — it means somebody's install resolved a different
 * dependency graph than `npm ci` will, and the clean clone the grading depends on is the one
 * place that difference shows up.
 */
const FOREIGN_LOCKFILES = new Set(["yarn.lock", "pnpm-lock.yaml", "bun.lock", "bun.lockb"]);

export function checkLockfiles(files: string[]): void {
  const offenders = files.filter((path) => FOREIGN_LOCKFILES.has(path.split("/").pop() ?? ""));
  if (offenders.length === 0) return;
  fail({
    name: "Foreign lockfile staged",
    rule: "npm only — `npm ci` is what the graders run",
    files: offenders.map((path) => ({ path })),
    fix: "Delete it and keep package-lock.json. If you installed with another package manager, re-run `npm install`.",
  });
}

export function checkLargeFiles(files: string[]): void {
  const offenders = files
    .map((path) => ({ path, size: stagedBlobSize(path) }))
    .filter((entry) => entry.size > MAX_FILE_BYTES)
    .map((entry) => ({ path: entry.path, detail: `${(entry.size / 1024 / 1024).toFixed(2)} MB` }));

  if (offenders.length === 0) return;
  fail({
    name: "Large file blocker (>1 MB)",
    files: offenders,
    fix: "A file this size is usually a build artefact, a dump or a binary. Add it to .gitignore, or commit it deliberately with `--no-verify` if it really belongs in history.",
  });
}

export function checkMergeMarkers(files: string[]): void {
  const offenders: { path: string; detail?: string }[] = [];

  for (const path of files) {
    if (!isTextLikely(path)) continue;
    const content = stagedBlobContent(path);
    if (content === null) continue;

    const lines = content.split("\n");
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index] ?? "";
      if (line.startsWith("<<<<<<< ") || line.startsWith(">>>>>>> ")) {
        offenders.push({ path, detail: `line ${index + 1}` });
        break;
      }
    }
  }

  if (offenders.length === 0) return;
  fail({
    name: "Merge conflict markers",
    files: offenders,
    fix: "Finish resolving the conflict and remove the marker lines before committing.",
  });
}

/**
 * Trailing whitespace and a missing final newline.
 *
 * Small, and worth a gate precisely because it is small: these are the changes that show up as
 * noise in every later diff, attached to lines nobody meant to touch.
 */
export function checkWhitespaceAndEof(files: string[]): void {
  const offenders: { path: string; detail?: string }[] = [];

  for (const path of files) {
    if (!isTextLikely(path)) continue;
    const content = stagedBlobContent(path);
    if (content === null || content.length === 0) continue;

    if (!content.endsWith("\n")) {
      offenders.push({ path, detail: "no newline at end of file" });
      continue;
    }

    const lines = content.slice(0, -1).split("\n");
    const dirty = lines.findIndex((line) => /[ \t]+$/.test(line));
    if (dirty !== -1) offenders.push({ path, detail: `trailing whitespace, line ${dirty + 1}` });
  }

  if (offenders.length === 0) return;
  fail({
    name: "Trailing whitespace or missing final newline",
    files: offenders,
    fix: "Strip the trailing spaces and end the file with a newline, then re-stage.",
  });
}
