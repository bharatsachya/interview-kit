import { spawnSync } from "node:child_process";
import { commandExists } from "./git";
import { fail, warn } from "./output";

/**
 * Secrets, via gitleaks.
 *
 * Scans the staged content rather than the history: the point is to stop a credential entering
 * a commit, and once it is in one, rotating it is the only real remedy anyway.
 *
 * Missing gitleaks warns rather than fails. A developer without it installed still gets every
 * other check, and a hard failure here would teach them to reach for `--no-verify`, which
 * disables all of them. CI runs the same scan and does not have the option of being lenient.
 */
export function checkSecrets(): boolean {
  if (!commandExists("gitleaks")) {
    warn("gitleaks not installed — secrets scan skipped", "install: brew install gitleaks");
    return false;
  }

  const result = spawnSync(
    "gitleaks",
    ["protect", "--staged", "--redact", "-v", "--config", ".gitleaks.toml", "--no-banner"],
    { stdio: ["ignore", "inherit", "inherit"] },
  );

  if (result.status === 0) return true;
  fail({
    name: "Secrets detected (gitleaks)",
    files: [{ path: "see the gitleaks output above" }],
    fix: "Rotate the credential first — assume it is already compromised — then remove it from the staged content and re-stage.",
  });
}
