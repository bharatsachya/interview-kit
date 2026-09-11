#!/usr/bin/env node
/**
 * Type-check every workspace against its OWN tsconfig.
 *
 * This is where the dependency rule is enforced. Each package's tsconfig declares path
 * mappings only for the packages it is allowed to import, and no package exposes a `main` or
 * `exports` field, so npm's workspace symlinks cannot be used to route around the allowlist.
 * `extraction` importing `llm` is therefore a compile error, not a code-review note.
 *
 * The root tsconfig.json is deliberately NOT checked here — it maps everything, because tsx
 * and vitest need to resolve everything at runtime.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const tsc = join(repoRoot, "node_modules", ".bin", "tsc");

if (!existsSync(tsc)) {
  console.error("typescript is not installed — run `npm install` first.");
  process.exit(1);
}

const projects = [...workspacesIn("packages"), ...workspacesIn("apps"), ...standalone("scripts")];

if (projects.length === 0) {
  console.error("no tsconfig.json found under packages/, apps/ or scripts/.");
  process.exit(1);
}

/**
 * Next generates the types for its own routes, layouts and pages, and writes them into
 * `apps/web/.next/types/` — which is gitignored, because it is build output.
 *
 * So on a clean clone `apps/web/src/app/layout.tsx` refers to a `LayoutProps` that does not
 * exist yet, and this script failed on a repository that was in no way broken. `next typegen`
 * writes those types without doing a full build; it takes a second and it makes the first
 * command a reviewer runs behave the same as the hundredth.
 */
function generateNextTypes() {
  const web = join(repoRoot, "apps", "web");
  if (!existsSync(join(web, "next.config.ts"))) return;

  const started = Date.now();
  const result = spawnSync("npx", ["--no-install", "next", "typegen"], { cwd: web, stdio: "pipe" });
  const ms = Date.now() - started;

  // Advisory, not fatal. If it fails, tsc reports the real error a moment later with a line
  // number; swallowing the run here would turn that into "typecheck failed" with no location.
  console.log(
    result.status === 0
      ? `  gen   apps/web route types  ${ms}ms`
      : `  warn  could not generate apps/web route types — tsc may report missing LayoutProps`,
  );
}

generateNextTypes();

let failed = 0;
for (const project of projects) {
  const label = relative(repoRoot, project);
  const started = Date.now();
  const result = spawnSync(tsc, ["--noEmit", "-p", project], { cwd: repoRoot, stdio: "inherit" });
  const ms = Date.now() - started;

  if (result.status === 0) {
    console.log(`  ok    ${label}  ${ms}ms`);
  } else {
    console.log(`  FAIL  ${label}  ${ms}ms`);
    failed += 1;
  }
}

if (failed > 0) {
  console.error(`\n${failed} of ${projects.length} project(s) failed to type-check.`);
  process.exit(1);
}
console.log(`\n${projects.length} project(s) type-check clean.`);

/**
 * Every workspace's tsconfig.json, plus a tsconfig.test.json where one exists.
 *
 * Only apps/web has the second. Its tsconfig.json is read by `next build` as well as by this
 * script, so it cannot include `test` — a production build has no vitest to resolve. The tests
 * are checked through the sibling config instead, which keeps them under this command rather
 * than quietly unchecked.
 */
function workspacesIn(dir) {
  const root = join(repoRoot, dir);
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) => [
      join(root, entry.name, "tsconfig.json"),
      join(root, entry.name, "tsconfig.test.json"),
    ])
    .filter(existsSync)
    .sort();
}

function standalone(dir) {
  const config = join(repoRoot, dir, "tsconfig.json");
  return existsSync(config) ? [config] : [];
}
