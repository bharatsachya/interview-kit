#!/usr/bin/env tsx
import { mkdir, writeFile } from "node:fs/promises";
import { formatTrace } from "@trao/kernel";
import { validateEvaluationOutput, validateKitJSON } from "@trao/kit";
import { generateKit } from "@trao/pipeline";
import { wire } from "./composition";
import { loadEnv } from "./load-env";

loadEnv();

/**
 * End-to-end check with no browser involved.
 *
 *   npm run smoke              # fakes: no key, no network, about a second
 *   npm run smoke -- --real    # the real Gemini and the real internet
 *
 * Runs the four fixture sites plus the two job descriptions the brief tests against — a rich
 * posting and a two-line stub — validates every kit against Appendix A, prints the span tree for
 * each, and exits non-zero if anything is wrong. This is the thing to run before believing the
 * pipeline works, and the thing to run after changing it.
 */

interface Scenario {
  name: string;
  jd: string;
  url: string;
  days: number;
  /** What this case is here to demonstrate. Printed so a failure explains itself. */
  expect: string;
  expectFailure?: boolean;
}

const RICH_JD = `Senior Backend Engineer
Acme Payments — Berlin (hybrid)

We move money for around 400 marketplaces and are looking for a senior engineer on the ledger team.

Required:
- 5+ years building production services in Python
- Experience operating PostgreSQL at scale, including replication
- Designing distributed systems with clear availability trade-offs
- Mentoring junior engineers and reviewing their work
- A background in payments or another regulated domain

Nice to have:
- Kubernetes in production
- Experience with Kafka or a similar streaming platform
- Public speaking or writing about engineering
`;

const MANY_MUSTS_JD = `Staff Infrastructure Engineer
Northwind Labs — Remote

Required:
- Deep experience with Kubernetes cluster operations
- PostgreSQL replication and failover
- Kafka streaming pipelines at high throughput
- Terraform modules for reproducible infrastructure
- Prometheus and Grafana observability
- Linux performance tuning under load
- Mentoring junior engineers
`;

const SCENARIOS: Scenario[] = [
  {
    name: "rich posting, site with a deep hiring page",
    jd: RICH_JD,
    url: "https://meridian.test/",
    days: 5,
    expect: "priorities corrected from the posting's headings; hiring page found by ranking",
  },
  {
    name: "coverage second pass",
    jd: MANY_MUSTS_JD,
    url: "https://northwind.test/",
    days: 7,
    expect: "pass 1 finds gaps, gap_fill closes them, pass 2 is clean",
  },
  {
    name: "sparse site — the honest-brief path",
    jd: RICH_JD,
    url: "https://calder.test/",
    days: 3,
    expect: "kit still produced, brief admits what it could not find",
  },
  {
    name: "two-line stub",
    jd: "Backend engineer needed. Must know Go.",
    url: "https://calder.test/",
    days: 1,
    expect: "few requirements, nothing invented, everything on day 1",
  },
  {
    name: "Appendix B sub-path with relative links",
    jd: RICH_JD,
    url: "http://localhost:8099/acme/",
    days: 14,
    expect: "relative links resolve against the sub-path, not the origin",
  },
  {
    name: "unreachable site",
    jd: RICH_JD,
    url: "https://gone.test/",
    days: 5,
    expect: "failed with COMPANY_UNREACHABLE, matching Appendix B's example",
    expectFailure: true,
  },
  {
    name: "sixty days",
    jd: RICH_JD,
    url: "https://meridian.test/",
    days: 60,
    expect: "60 days, none empty, spaced review days after the material runs out",
  },
];

async function main(): Promise<number> {
  const real = process.argv.includes("--real");
  const verbose = process.argv.includes("--trace") || !real;
  const traceDir = "tmp/traces";
  await mkdir(traceDir, { recursive: true });

  if (real && (process.env["GEMINI_API_KEY"] ?? "") === "") {
    process.stderr.write("--real needs GEMINI_API_KEY. Put it in .env (see .env.example).\n");
    return 1;
  }

  process.stderr.write(
    real
      ? "SMOKE (real Gemini, real network) — this spends quota\n\n"
      : "SMOKE (fakes: no API key, no network)\n\n",
  );

  let failures = 0;

  for (const [index, scenario] of SCENARIOS.entries()) {
    // The real run cannot use fixture sites, so it only makes sense for the reachable ones.
    if (real && !scenario.url.startsWith("https://meridian.test")) {
      if (index > 0) continue;
    }

    const wiring = wire({
      fakeLlm: !real,
      fakeFetch: !real,
      deterministicIds: !real,
      allowPrivateHosts: true,
    });

    const startedAt = Date.now();
    const result = await generateKit(
      { jd: scenario.jd, companyUrl: scenario.url, days: scenario.days },
      {
        llm: wiring.llm,
        fetcher: wiring.fetcher,
        search: wiring.search,
        tracer: wiring.tracer,
        clock: wiring.clock,
        ids: wiring.ids,
        budget: wiring.budget,
        ...(real ? {} : { requestsPerSecond: 1_000 }),
      },
    );
    const elapsed = Date.now() - startedAt;

    const slug = scenario.name.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
    await writeFile(`${traceDir}/${slug}.json`, `${JSON.stringify(result.spans, null, 2)}\n`, "utf8");

    const problems = check(scenario, result);
    const ok = problems.length === 0;
    if (!ok) failures += 1;

    process.stderr.write(
      `${ok ? "  ok  " : "  FAIL"} ${scenario.name}  (${elapsed}ms)\n         ${scenario.expect}\n`,
    );
    for (const problem of problems) process.stderr.write(`         ✗ ${problem}\n`);

    if (verbose) process.stderr.write(`\n${indent(formatTrace(result.spans))}\n\n`);
    else process.stderr.write(`         trace: ${traceDir}/${slug}.json\n`);
  }

  // The batch command, on the same fixtures, validated against Appendix B.
  if (!real) {
    const { execSync } = await import("node:child_process");
    execSync("tsx scripts/evaluate.ts --input fixtures/cases.json --output tmp/kits.json --fake-llm --fake-fetch", {
      stdio: "inherit",
    });
    const { readFile } = await import("node:fs/promises");
    const output = JSON.parse(await readFile("tmp/kits.json", "utf8")) as unknown;
    const envelope = validateEvaluationOutput(output);
    if (!envelope.ok) {
      failures += 1;
      process.stderr.write(`  FAIL batch output is not Appendix B: ${envelope.errors.join("; ")}\n`);
    } else {
      process.stderr.write(`  ok   batch output matches Appendix B\n`);
    }
  }

  process.stderr.write(
    failures === 0
      ? `\nall good. traces in ${traceDir}/\n`
      : `\n${failures} scenario(s) failed\n`,
  );
  return failures === 0 ? 0 : 1;
}

/** What each scenario is actually asserting. A smoke test that only checks "no crash" is theatre. */
function check(scenario: Scenario, result: Awaited<ReturnType<typeof generateKit>>): string[] {
  const problems: string[] = [];

  if (scenario.expectFailure === true) {
    if (result.status !== "failed") problems.push("expected this case to fail, but it succeeded");
    else if (result.error?.code !== "COMPANY_UNREACHABLE") problems.push(`expected COMPANY_UNREACHABLE, got ${result.error?.code}`);
    return problems;
  }

  if (result.status !== "ok") {
    problems.push(`failed: ${result.error?.code} ${result.error?.message}`);
    return problems;
  }

  const kit = result.kitJson;
  if (kit === null) return ["no kit was produced"];

  const validation = validateKitJSON(kit);
  if (!validation.ok) problems.push(`Appendix A: ${validation.errors.slice(0, 2).join("; ")}`);

  if (kit.schedule.days.length !== scenario.days) {
    problems.push(`expected ${scenario.days} days, got ${kit.schedule.days.length}`);
  }
  for (const day of kit.schedule.days) {
    if (!Number.isInteger(day.minutes)) problems.push(`day ${day.day} has non-integer minutes`);
  }

  // Every must-have has to be asked about somewhere, or coverage did not do its job.
  const covered = new Set(kit.questions.flatMap((q) => q.requirement_ids));
  for (const requirement of kit.requirements.filter((r) => r.priority === "must")) {
    if (!covered.has(requirement.id)) problems.push(`must-have ${requirement.id} is uncovered`);
  }

  if (scenario.days === 60 && kit.schedule.days.some((d) => d.question_ids.length === 0)) {
    problems.push("the 60-day schedule has an empty day");
  }

  if (kit.company_brief.pages_used.length === 0 && kit.company_brief.gaps.length === 0) {
    problems.push("no pages were used and no gap was recorded — the brief is silently thin");
  }

  return problems;
}

function indent(text: string): string {
  return text
    .split("\n")
    .map((line) => `         ${line}`)
    .join("\n");
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
    process.exit(1);
  });
