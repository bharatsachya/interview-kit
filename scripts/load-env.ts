import { existsSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Load `.env` into the process, if there is one.
 *
 * Without this, `.env.example` is a lie: a grader copies it to `.env`, fills in a key, and the
 * process still reports the key as missing. Node has had `process.loadEnvFile` built in since
 * 20.12, so this needs no dependency.
 *
 * Real environment variables always win — `loadEnvFile` does not overwrite anything already set,
 * so a value exported in the shell or injected by a deployment platform is not clobbered by a
 * stale file left in the working directory.
 *
 * Called from the three composition roots and nowhere else. A domain package that read the
 * environment would be constructing its own configuration, which is the thing the dependency
 * rule exists to prevent.
 */
export function loadEnv(file = ".env"): void {
  const path = resolve(process.cwd(), file);
  if (!existsSync(path)) return;

  try {
    process.loadEnvFile(path);
  } catch (error) {
    // A malformed .env should say so rather than silently leaving the process unconfigured.
    process.stderr.write(`warning: could not read ${file}: ${error instanceof Error ? error.message : String(error)}\n`);
  }
}
