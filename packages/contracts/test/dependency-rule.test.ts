import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Guards the mechanism, not the outcome.
 *
 * The dependency rule is enforced by `npm run typecheck`, which runs tsc once per package
 * against a tsconfig whose `paths` list only the packages that one is allowed to import. That
 * allowlist is only real while no package exposes a `main` or `exports` field: npm workspaces
 * symlinks every @trao/* package into the root node_modules, and either field would let
 * TypeScript resolve any package from any package and quietly bypass the whole scheme.
 *
 * A future package.json written from habit would break the enforcement without breaking a
 * single build. This test is what notices.
 */

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

function workspacePackages(): { name: string; dir: string; manifest: Record<string, unknown> }[] {
  return readdirSync(join(repoRoot, "packages"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const dir = join(repoRoot, "packages", entry.name);
      const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as Record<string, unknown>;
      return { name: entry.name, dir, manifest };
    });
}

describe("the dependency rule", () => {
  const packages = workspacePackages();

  it("has packages to check", () => {
    expect(packages.length).toBeGreaterThan(0);
  });

  it.each(packages.map((p) => p.name))("%s exposes no main or exports field", (name) => {
    const manifest = packages.find((p) => p.name === name)?.manifest ?? {};
    expect(manifest["main"], "would let node_modules resolution bypass the tsconfig allowlist").toBeUndefined();
    expect(manifest["exports"], "would let node_modules resolution bypass the tsconfig allowlist").toBeUndefined();
  });

  it.each(packages.map((p) => p.name))("%s type-checks against its own tsconfig, not the root one", (name) => {
    const pkg = packages.find((p) => p.name === name);
    const tsconfig = JSON.parse(readFileSync(join(pkg?.dir ?? "", "tsconfig.json"), "utf8")) as {
      extends?: string;
      compilerOptions?: { paths?: Record<string, string[]> };
    };
    expect(tsconfig.extends).toBe("../../tsconfig.base.json");
    expect(tsconfig.compilerOptions?.paths, "must declare an explicit allowlist, even an empty one").toBeDefined();
  });

  it("gives contracts an empty allowlist — it imports nothing, ever", () => {
    const contracts = packages.find((p) => p.name === "contracts");
    const tsconfig = JSON.parse(readFileSync(join(contracts?.dir ?? "", "tsconfig.json"), "utf8")) as {
      compilerOptions?: { paths?: Record<string, string[]> };
    };
    expect(Object.keys(tsconfig.compilerOptions?.paths ?? {})).toEqual([]);
  });
});
