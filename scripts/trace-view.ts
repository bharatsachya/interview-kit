#!/usr/bin/env tsx
import { readFile } from "node:fs/promises";
import type { Span } from "@trao/contracts";
import { formatTrace } from "@trao/kernel";

/**
 * Read a trace file back as something a person can follow.
 *
 *   npm run trace -- tmp/trace.json            # the span tree, then every model call
 *   npm run trace -- tmp/trace.json --calls    # just the model calls
 *   npm run trace -- tmp/trace.json --tree     # just the tree
 *
 * The span tree answers "what did it do, in what order, and how long did each step take". This
 * answers the other question — "what did it actually say to the model, and what came back" —
 * which is only in the file when the run used `--record-prompts`.
 */

const RULE = "─".repeat(100);

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const path = args.find((arg) => !arg.startsWith("--"));
  if (path === undefined) {
    process.stderr.write("Usage: npm run trace -- <trace.json> [--calls] [--tree] [--full]\n");
    return 1;
  }

  const spans = JSON.parse(await readFile(path, "utf8")) as Span[];
  const onlyCalls = args.includes("--calls");
  const onlyTree = args.includes("--tree");
  const full = args.includes("--full");

  if (!onlyCalls) {
    process.stdout.write(`${RULE}\nSPAN TREE — ${path}\n${RULE}\n\n${formatTrace(spans)}\n\n`);
  }
  if (onlyTree) return 0;

  const calls = spans.filter((span) => span.step.startsWith("llm:"));
  if (calls.length === 0) {
    process.stdout.write(
      spans.length === 0
        ? "(empty trace)\n"
        : "No model-call spans in this trace.\n" +
            "Either the run used --fake-llm, which bypasses the gateway, or it did not use\n" +
            "--record-prompts, which is what puts the prompt and response on the span.\n",
    );
    return 0;
  }

  process.stdout.write(`${RULE}\nMODEL CALLS — ${calls.length}\n${RULE}\n`);

  let inputTotal = 0;
  let outputTotal = 0;

  for (const [index, span] of calls.entries()) {
    const attrs = span.attrs;
    const inputTokens = numberOf(attrs["input_tokens"]);
    const outputTokens = numberOf(attrs["output_tokens"]);
    inputTotal += inputTokens;
    outputTotal += outputTokens;

    process.stdout.write(
      [
        "",
        `┌ ${index + 1}/${calls.length}  ${span.step.replace(/^llm:/, "")}`,
        `│  model=${String(attrs["model"])}  ${(span.durationMs / 1000).toFixed(1)}s  ` +
          `in=${inputTokens} out=${outputTokens}  cache_hit=${String(attrs["cache_hit"])}  ` +
          `attempt=${String(attrs["attempt"])}  queued=${String(attrs["queued_ms"])}ms` +
          (attrs["rate_limited"] === true ? "  RATE-LIMITED" : "") +
          (attrs["repair_attempted"] === true ? "  REPAIRED" : ""),
        "",
      ].join("\n"),
    );

    if (attrs["repair_reason"] !== undefined) {
      process.stdout.write(`│  schema rejected the first answer: ${String(attrs["repair_reason"])}\n\n`);
    }

    writeBlock("PROMPT", attrs["prompt"], full);
    writeBlock("RESPONSE", attrs["response"], full);
    writeBlock("REPAIR PROMPT", attrs["repair_prompt"], full);
    writeBlock("REPAIR RESPONSE", attrs["repair_response"], full);

    if (attrs["prompt"] === undefined) {
      process.stdout.write("│  (prompt not recorded — rerun with --record-prompts)\n");
    }
    process.stdout.write("└\n");
  }

  process.stdout.write(
    `\n${RULE}\n${calls.length} calls  ·  ${inputTotal} input tokens  ·  ${outputTotal} output tokens` +
      `  ·  ${calls.filter((s) => s.attrs["cache_hit"] === true).length} served from cache\n${RULE}\n`,
  );

  return 0;
}

/** Truncated by default: a single extraction prompt is a whole job description. */
const PREVIEW_LINES = 40;

function writeBlock(label: string, value: unknown, full: boolean): void {
  if (typeof value !== "string" || value.length === 0) return;

  const lines = value.split("\n");
  const shown = full || lines.length <= PREVIEW_LINES ? lines : lines.slice(0, PREVIEW_LINES);

  process.stdout.write(`│  ${label}\n`);
  for (const line of shown) process.stdout.write(`│    ${line}\n`);
  if (shown.length < lines.length) {
    process.stdout.write(`│    … ${lines.length - shown.length} more lines (--full to see them)\n`);
  }
  process.stdout.write("│\n");
}

function numberOf(value: unknown): number {
  return typeof value === "number" ? value : 0;
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
