import { spawnSync } from "node:child_process";

/**
 * Reading the index, not the working tree.
 *
 * Every staged check reads blobs out of the index rather than files off disk, because those are
 * two different things the moment somebody stages half a file. Checking the working tree would
 * pass a commit whose staged content is broken, and fail one whose staged content is fine —
 * both of which teach people to distrust the hook.
 */

function git(args: string[]): { status: number; stdout: string } {
  // 32 MB, not the 1 MB default. `ls-files --ignored` over a repo with node_modules installed
  // produces megabytes, and an overflowing spawnSync returns an empty stdout rather than an
  // error — which made the ignored-source check pass by having nothing to look at.
  const result = spawnSync("git", args, { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
  return { status: result.status ?? 1, stdout: result.stdout ?? "" };
}

/** Paths staged for commit. Added, copied, modified or renamed — never deleted. */
export function stagedFiles(): string[] {
  const { stdout } = git(["diff", "--cached", "--name-only", "--diff-filter=ACMR"]);
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/** The staged bytes of a file, or null when it cannot be read as text. */
export function stagedBlobContent(path: string): string | null {
  const result = spawnSync("git", ["show", `:${path}`], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
  if (result.status !== 0 || typeof result.stdout !== "string") return null;
  return result.stdout;
}

export function stagedBlobSize(path: string): number {
  const { status, stdout } = git(["cat-file", "-s", `:${path}`]);
  if (status !== 0) return 0;
  const size = Number.parseInt(stdout.trim(), 10);
  return Number.isFinite(size) ? size : 0;
}

const BINARY_EXTENSIONS = new Set([
  "png", "jpg", "jpeg", "gif", "webp", "ico", "pdf", "zip", "gz", "tgz",
  "woff", "woff2", "ttf", "eot", "mp4", "mov", "wasm",
]);

/** Cheap guess. A wrong guess costs a skipped text check, never a corrupted read. */
export function isTextLikely(path: string): boolean {
  const extension = path.split(".").pop()?.toLowerCase() ?? "";
  return !BINARY_EXTENSIONS.has(extension);
}

export function commandExists(command: string): boolean {
  return spawnSync("command", ["-v", command], { shell: true, stdio: "ignore" }).status === 0;
}

/** Files that exist on disk and that git is ignoring. The `--exclude-standard` is what makes it honest. */
export function ignoredFiles(): string[] {
  // Scoped to the source trees and with dependency directories excluded at the git level rather
  // than filtered afterwards. Filtering afterwards means first transporting every path under
  // node_modules through a pipe, which is both slow and the thing that overflowed the buffer.
  const { stdout } = git([
    "ls-files",
    "--others",
    "--ignored",
    "--exclude-standard",
    "--",
    "packages",
    "apps",
    "scripts",
    "fixtures",
    "evals",
    ":(exclude)**/node_modules/**",
  ]);
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/** How many tracked files live under a path. Zero for a directory git cannot see. */
export function trackedCount(path: string): number {
  const { stdout } = git(["ls-files", path]);
  return stdout.split("\n").filter((line) => line.trim().length > 0).length;
}
