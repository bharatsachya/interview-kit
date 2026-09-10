#!/usr/bin/env node
/**
 * Brings the whole app up with one command: the Express API and the Next front end.
 *
 * Fake by default. The Gemini free tier is 20 requests per day *per model* — not a rate limit
 * you wait out, a daily wall — and one real run spends six of them. Working on the interface
 * against the real model burns the day's budget before lunch, so `npm run dev` uses the canned
 * responses and fixture sites, and `npm run dev:real` is the deliberate opt-in.
 *
 * Both children share this process's stdio, so their logs interleave in one terminal, and
 * killing this kills both — a front end left pointing at a dead API is the exact failure this
 * script exists to stop happening by hand.
 */

import { spawn } from "node:child_process";

const real = process.argv.includes("--real");

/** Kept in step with API_ORIGIN in apps/web/.env.local — the two are one setting in two files. */
const API_PORT = process.env.PORT ?? "8787";
const WEB_PORT = process.env.WEB_PORT ?? "3001";

const children = [];

function run(name, command, args, env) {
  const child = spawn(command, args, {
    stdio: "inherit",
    env: { ...process.env, ...env },
    shell: process.platform === "win32",
  });
  child.on("exit", (code, signal) => {
    // One half dying takes the other with it. A Next server still serving a page whose every
    // request 502s looks like a front-end bug and is not one.
    if (!shuttingDown) {
      process.stderr.write(`\n${name} exited (${signal ?? code}). Stopping the rest.\n`);
      stop(code ?? 1);
    }
  });
  children.push(child);
  return child;
}

let shuttingDown = false;
function stop(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) child.kill("SIGTERM");
  setTimeout(() => process.exit(code), 300);
}

for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => stop(0));

process.stderr.write(
  [
    "",
    `  api   http://127.0.0.1:${API_PORT}   ${real ? "gemini + live fetch" : "fake model + fixture sites"}`,
    `  web   http://localhost:${WEB_PORT}`,
    real ? "  spending real Gemini quota — 20 requests per day, per model." : "",
    "",
  ]
    .filter(Boolean)
    .join("\n") + "\n",
);

run("api", "npm", ["run", real ? "api" : "api:fake"], { PORT: API_PORT });
run("web", "npm", ["--workspace", "apps/web", "run", "dev", "--", "--port", WEB_PORT], {});
