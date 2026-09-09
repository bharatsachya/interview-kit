#!/usr/bin/env tsx
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { formatTrace } from "@trao/kernel";
import { generateKit } from "@trao/pipeline";
import { wire } from "./composition";
import { loadEnv } from "./load-env";

loadEnv();

/**
 * Headless dev runner. One case, no UI, no database.
 *
 *   npm run dev:kit -- --jd ./fixtures/senior-backend.txt \
 *                      --url https://meridian.test/ --days 5 \
 *                      --fake-llm --fake-fetch --trace-pretty
 *
 * `--fake-llm --fake-fetch` together give a full run in well under a second with zero quota.
 * That is the single biggest speed-up available in a one-day build: debugging the pipeline
 * through the interface costs a minute a time, and this costs nothing.
 *
 * Same composition root as `evaluate.ts`, for one case. Both import the identical pipeline —
 * never a parallel implementation.
 */

interface Flags {
  jd: string;
  url: string;
  days: number;
  fakeLlm: boolean;
  fakeFetch: boolean;
  noCache: boolean;
  allowPrivateHosts: boolean;
  tracePretty: boolean;
  trace: string | null;
  out: string | null;
}

async function main(): Promise<number> {
  const flags = parseFlags(process.argv.slice(2));
  const jd = await readJd(flags.jd);

  const wiring = wire({
    fakeLlm: flags.fakeLlm,
    fakeFetch: flags.fakeFetch,
    noCache: flags.noCache,
    allowPrivateHosts: flags.allowPrivateHosts,
    deterministicIds: flags.fakeLlm,
  });

  process.stderr.write(`${wiring.describe.map((line) => `  ${line}`).join("\n")}\n\n`);

  const startedAt = Date.now();
  const result = await generateKit(
    { jd, companyUrl: flags.url, days: flags.days },
    {
      llm: wiring.llm,
      fetcher: wiring.fetcher,
      search: wiring.search,
      tracer: wiring.tracer,
      clock: wiring.clock,
      ids: wiring.ids,
      budget: wiring.budget,
      // Nobody to be polite to when the pages come off the local disk.
      ...(flags.fakeFetch ? { requestsPerSecond: 1_000 } : {}),
    },
  );
  const elapsed = Date.now() - startedAt;

  if (flags.tracePretty) process.stderr.write(`${formatTrace(result.spans)}\n\n`);
  if (flags.trace !== null) await writeJson(flags.trace, result.spans);

  if (result.status === "failed") {
    process.stderr.write(`FAILED  ${result.error?.code}: ${result.error?.message}\n`);
    return 1;
  }

  const kit = result.kitJson;
  if (kit === null) return 1;

  process.stderr.write(
    [
      `ok in ${elapsed}ms`,
      `  requirements  ${kit.requirements.length} (${kit.requirements.filter((r) => r.priority === "must").length} must)`,
      `  questions     ${kit.questions.length}`,
      `  flashcards    ${kit.flashcards.length}`,
      `  schedule      ${kit.schedule.days.length}/${kit.schedule.days_available} days`,
      `  coverage      ${kit.coverage.passes} pass(es), ${kit.coverage.uncovered_requirement_ids.length} uncovered`,
      "",
    ].join("\n"),
  );

  if (flags.out !== null) {
    await writeJson(flags.out, kit);
    process.stderr.write(`  written to ${flags.out}\n`);
  } else {
    process.stdout.write(`${JSON.stringify(kit, null, 2)}\n`);
  }

  return 0;
}

function parseFlags(argv: string[]): Flags {
  const flags: Flags = {
    jd: "",
    url: "",
    days: 5,
    fakeLlm: false,
    fakeFetch: false,
    noCache: false,
    allowPrivateHosts: false,
    tracePretty: false,
    trace: null,
    out: null,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] as string;
    const next = (): string => {
      const value = argv[i + 1];
      if (value === undefined) throw new Error(`${arg} needs a value`);
      i += 1;
      return value;
    };

    switch (arg) {
      case "--jd": flags.jd = next(); break;
      case "--url": flags.url = next(); break;
      case "--days": flags.days = Number.parseInt(next(), 10); break;
      case "--fake-llm": flags.fakeLlm = true; break;
      case "--fake-fetch": flags.fakeFetch = true; break;
      case "--no-cache": flags.noCache = true; break;
      case "--allow-private-hosts": flags.allowPrivateHosts = true; break;
      case "--trace-pretty": flags.tracePretty = true; break;
      case "--trace": flags.trace = next(); break;
      case "--out": flags.out = next(); break;
      case "--help":
        process.stdout.write(USAGE);
        process.exit(0);
        break;
      default:
        throw new Error(`unknown flag ${arg}\n${USAGE}`);
    }
  }

  if (flags.jd === "") throw new Error(`--jd is required\n${USAGE}`);
  if (flags.url === "") throw new Error(`--url is required\n${USAGE}`);
  if (!Number.isInteger(flags.days) || flags.days < 1) throw new Error("--days must be a positive integer");

  // The fixture sites are served from loopback, so a fake fetch implies the flag.
  if (flags.fakeFetch) flags.allowPrivateHosts = true;

  return flags;
}

async function readJd(source: string): Promise<string> {
  if (source === "-") {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks).toString("utf8");
  }
  return readFile(source, "utf8");
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

const USAGE = `
Usage: npm run dev:kit -- --jd <file|-> --url <company-url> [options]

  --jd <file|->            job description from a file, or - for stdin
  --url <url>              company website
  --days <n>               days until the interview (default 5)

  --fake-llm               FakeLlmProvider: no network, no quota
  --fake-fetch             serve pages from ./fixtures/sites
  --no-cache               bypass the cache, to prove a cold run works
  --allow-private-hosts    permit loopback and private addresses (implied by --fake-fetch)

  --trace-pretty           print the span tree to stderr
  --trace <file>           write the spans as JSON
  --out <file>             write the kit JSON (default: stdout)
`;

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
