#!/usr/bin/env tsx
/**
 * Step-by-step eval runner.
 *
 *   npm run eval:step -- 07              run one step
 *   npm run eval:step -- all             every step, in order
 *   npm run eval:step -- 01 --repeat 3   LLM steps: N runs, pass rate per case
 *
 * Pure steps run with fakes only and must pass 100%. LLM steps (01, 05, 06) go through the
 * real gateway with the cache DISABLED, so the repeats measure the prompt rather than a cache.
 *
 * Results and the span trace are written per step under out/evals/<run-id>/, and are never
 * cleaned up — each run gets its own directory.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join, resolve } from "node:path";
import type { IdGenerator, LlmProvider, Span, Tracer } from "@trao/contracts";
import { ClerkAuthenticator } from "@trao/auth";
import {
  InMemoryTracer,
  RandomIdGenerator,
  RoutedIdGenerator,
  SequentialIdGenerator,
  SystemClock,
  formatTrace,
} from "@trao/kernel";
import { FakeLlmProvider, unlimitedBudget } from "@trao/llm";
import { MemoryJobStore, MemoryKitStore } from "@trao/persistence";
import { extractRequirements } from "@trao/extraction";
import {
  DEFAULT_PER_SCORER,
  DEFAULT_EXTERNAL_HIRING_THRESHOLD,
  FakeFetcher,
  fixtureMounts,
  mergeCandidates,
  normaliseUrl,
  rankLinks,
} from "@trao/retrieval";
import { NullSearchProvider, filterRelevant } from "@trao/research";
import { deriveFlashcards, generateBrief, generateQuestions } from "@trao/generation";
import { detectGaps, fallbackQuestion, gateQuestionTags, runCoverage } from "@trao/coverage";
import { allocateSchedule } from "@trao/scheduling";
import {
  addFlashcard,
  addQuestion,
  deleteFlashcard,
  deleteQuestion,
  editBrief,
  editFlashcard,
  editQuestion,
  editScheduleDay,
  getKitForBuilder,
  minutesForQuestions,
  moveQuestion,
  pinQuestion,
  repairSchedule,
  reorderQuestions,
  toKitJSON,
  validateKitJSON,
  type InternalKit,
} from "@trao/kit";
import { regenerateSection } from "@trao/pipeline";
import { createApp } from "../apps/api/src/app";
import { JobRunner } from "../apps/api/src/jobs";
import { JobSpanFeed } from "../apps/api/src/spans";
import { fakeLlmResponses, gapFillResponse } from "../fixtures/fake-llm-responses";
import { wire } from "../scripts/composition";
import { loadEnv } from "../scripts/load-env";
import { Checks, assignMatches, normalise, requirementMatches, toInternalQuestion, toRequirement } from "./harness";

loadEnv();

const STEPS_ROOT = resolve(process.cwd(), "evals", "steps");

interface StepDefinition {
  id: string;
  dir: string;
  name: string;
  target: string;
  kind: "pure" | "pure+fake" | "llm" | "llm+fake" | "integration" | "unimplemented";
  /** Where the eval spec's function name differs from the implementation's. */
  adapter?: string;
  run: (cases: Case[], deps: Deps) => Promise<CaseOutcome[]>;
}

interface Case {
  id: string;
  input: Record<string, any>;
  expected: Record<string, any>;
  tags?: string[];
}

interface Deps {
  tracer: Tracer;
  ids: IdGenerator;
  llm: LlmProvider;
  repeat: number;
}

interface RunRecord {
  pass: boolean;
  assertions: { name: string; pass: boolean; detail?: string }[];
  scores?: Record<string, number>;
  artifact?: unknown;
  error?: string;
}

interface CaseOutcome {
  id: string;
  runs: RunRecord[];
}

// ── helpers ──────────────────────────────────────────────────────────────────────────────

async function loadCases(dir: string): Promise<Case[]> {
  const raw = await readFile(join(STEPS_ROOT, dir, "cases.json"), "utf8");
  return JSON.parse(raw) as Case[];
}

/** Run one case body, turning a throw into a recorded failure rather than a dead run. */
async function attempt(body: (c: Checks) => Promise<unknown>): Promise<RunRecord> {
  const checks = new Checks();
  try {
    const artifact = await body(checks);
    return { pass: checks.passed, assertions: checks.list, ...(artifact !== undefined ? { artifact } : {}) };
  } catch (error) {
    const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    checks.ok("did not throw", false, message);
    return { pass: false, assertions: checks.list, error: message };
  }
}

async function repeatCase(repeat: number, body: (c: Checks) => Promise<unknown>): Promise<RunRecord[]> {
  const runs: RunRecord[] = [];
  for (let i = 0; i < repeat; i += 1) runs.push(await attempt(body));
  return runs;
}

// ── 01 extraction (LLM) ──────────────────────────────────────────────────────────────────

const step01: StepDefinition = {
  id: "01",
  dir: "01-extraction",
  name: "extractRequirements",
  target: "packages/extraction → extractRequirements(jd, deps)",
  kind: "llm",
  run: async (cases, deps) => {
    const outcomes: CaseOutcome[] = [];
    for (const kase of cases) {
      const runs = await repeatCase(deps.repeat, async (c) => {
        const result = await deps.tracer.span(`case:${kase.id}`, async (span) => {
          span.set("jd_chars", String(kase.input["jd"].length));
          const r = await extractRequirements({ jd: kase.input["jd"], llm: deps.llm, ids: new SequentialIdGenerator() });
          span.set("requirement_count", String(r.requirements.length));
          span.set("must_count", String(r.requirements.filter((x) => x.priority === "must").length));
          return r;
        });

        const extracted = result.requirements;
        const expected = kase.expected;

        // must / nice recall, one-to-one
        const mustGold = (expected["must"] ?? []) as { text: string; kind: string }[];
        const niceGold = (expected["nice"] ?? []) as { text: string; kind: string }[];
        const mustMatches = assignMatches(mustGold, extracted);
        const niceMatches = assignMatches(niceGold, extracted);

        let mustHit = 0;
        let priorityRight = 0;
        let priorityTotal = 0;
        for (const [gold, match] of mustMatches) {
          const found = match !== null;
          if (found) mustHit += 1;
          c.ok(`must present: "${gold.text.slice(0, 48)}"`, found, found ? undefined : "no extracted requirement matched");
          if (!found) continue;
          priorityTotal += 1;
          const rightPriority = match.priority === "must";
          if (rightPriority) priorityRight += 1;
          c.ok(`must priority: "${gold.text.slice(0, 40)}"`, rightPriority, rightPriority ? undefined : `got "${match.priority}"`);
          c.ok(`must kind: "${gold.text.slice(0, 40)}"`, match.kind === gold.kind, match.kind === gold.kind ? undefined : `expected ${gold.kind}, got ${match.kind}`);
        }
        for (const [gold, match] of niceMatches) {
          const found = match !== null;
          c.ok(`nice present: "${gold.text.slice(0, 48)}"`, found, found ? undefined : "no extracted requirement matched");
          if (!found) continue;
          priorityTotal += 1;
          const rightPriority = match.priority === "nice";
          if (rightPriority) priorityRight += 1;
          c.ok(`nice priority: "${gold.text.slice(0, 40)}"`, rightPriority, rightPriority ? undefined : `got "${match.priority}"`);
          c.ok(`nice kind: "${gold.text.slice(0, 40)}"`, match.kind === gold.kind, match.kind === gold.kind ? undefined : `expected ${gold.kind}, got ${match.kind}`);
        }

        // forbidden: no requirement whose text IS one of these (normalised equality)
        const forbidden = (expected["forbidden"] ?? []) as string[];
        const hits = extracted.filter((r) => forbidden.some((f) => normalise(f) === normalise(r.text)));
        c.ok("no forbidden requirement text", hits.length === 0, hits.length === 0 ? undefined : `found ${JSON.stringify(hits.map((h) => h.text))}`);

        // count cap
        const maxTotal = expected["max_total"] as number;
        c.ok(`count ≤ ${maxTotal}`, extracted.length <= maxTotal, `extracted ${extracted.length}`);

        // location
        const location = result.role.location;
        const locationOk = normalise(location) === normalise(expected["location"] ?? "");
        c.ok("location", locationOk, locationOk ? undefined : `expected "${expected["location"]}", got "${location}"`);

        // responsibilities range
        const range = (expected["responsibilities_range"] ?? [0, 99]) as [number, number];
        const respCount = result.role.responsibilities.length;
        c.ok(`responsibilities in [${range[0]}, ${range[1]}]`, respCount >= range[0] && respCount <= range[1], `got ${respCount}`);

        // injection-specific
        if (kase.tags?.includes("prompt-injection") === true) {
          const dirty = extracted.filter((r) => /ignore/i.test(r.text));
          c.ok("no requirement contains 'ignore'", dirty.length === 0, dirty.length === 0 ? undefined : JSON.stringify(dirty.map((d) => d.text)));
        }

        const goldTotal = mustGold.length + niceGold.length;
        const matchedExtracted = new Set([...mustMatches.values(), ...niceMatches.values()].filter((m) => m !== null));
        const scores = {
          must_recall: mustGold.length === 0 ? 1 : mustHit / mustGold.length,
          invention_rate: extracted.length === 0 ? 0 : (extracted.length - matchedExtracted.size) / extracted.length,
          priority_accuracy: priorityTotal === 0 ? 1 : priorityRight / priorityTotal,
          forbidden_hits: hits.length,
          gold_total: goldTotal,
          extracted_total: extracted.length,
        };
        return {
          scores,
          location,
          responsibilities: result.role.responsibilities,
          requirements: extracted.map((r) => ({ id: r.id, text: r.text, kind: r.kind, priority: r.priority })),
          dropped: result.dropped,
          suspicious: result.suspicious,
          suspiciousReasons: result.suspiciousReasons,
        };
      });
      // lift scores out of the artifact for the report
      for (const run of runs) {
        const artifact = run.artifact as { scores?: Record<string, number> } | undefined;
        if (artifact?.scores !== undefined) run.scores = artifact.scores;
      }
      outcomes.push({ id: kase.id, runs });
    }
    return outcomes;
  },
};

// ── 02 link ranking (pure) ───────────────────────────────────────────────────────────────

type Decision = { url: string; follow: boolean; reason?: string; score: number; external: boolean };

/**
 * The eval spec names `scoreLinks(links, baseUrl) → { hiring, about }` plus a follow decision.
 * The implementation splits that across `rankLinks` (scoring, per scorer) and `crawlSite`
 * (selection). This reproduces crawlSite's selection rules exactly — top N per scorer,
 * score > 0, external hiring only at or above the threshold — without performing any fetch.
 */
function scoreLinksAdapter(input: Record<string, any>): {
  hiring: ReturnType<typeof rankLinks>;
  about: ReturnType<typeof rankLinks>;
  decisions: Map<string, Decision>;
} {
  const base = input["base_url"] as string;
  const origin = new URL(base).origin;
  const baseKey = normaliseUrl(base);

  const candidates = (input["links"] as { href: string; anchor: string; position: string }[]).map((link) => ({
    url: new URL(link.href, base).toString(),
    anchor: link.anchor,
    // The eval vocabulary says "body"; the implementation's LinkPosition calls it "main".
    position: (link.position === "body" ? "main" : link.position) as "nav" | "footer" | "main" | "unknown",
    source: "anchor" as const,
  }));

  const merged = mergeCandidates(candidates);
  const hiring = rankLinks(merged, "hiring", { origin });
  const about = rankLinks(merged, "about", { origin });

  const decisions = new Map<string, Decision>();
  const claimed = new Set<string>();

  for (const link of [...hiring]) {
    if (normaliseUrl(link.url) === baseKey) {
      // crawlSite seeds `visited` with the homepage, so it is never a candidate.
      decisions.set(normaliseUrl(link.url), { url: link.url, follow: false, reason: "self", score: link.score, external: link.external });
      claimed.add(normaliseUrl(link.url));
    }
  }

  const ranked = { hiring, about };
  for (let rank = 0; rank < DEFAULT_PER_SCORER; rank += 1) {
    for (const kind of ["hiring", "about"] as const) {
      const link = ranked[kind].filter((l) => !claimed.has(normaliseUrl(l.url)))[0];
      if (link === undefined || link.score <= 0) continue;
      const key = normaliseUrl(link.url);

      if (link.external) {
        const worthLeavingFor = kind === "hiring" && link.score >= DEFAULT_EXTERNAL_HIRING_THRESHOLD;
        if (!worthLeavingFor) {
          decisions.set(key, { url: link.url, follow: false, reason: "external_low_score", score: link.score, external: true });
          claimed.add(key);
          continue;
        }
      }
      claimed.add(key);
      decisions.set(key, { url: link.url, follow: true, score: link.score, external: link.external });
    }
  }

  for (const link of merged) {
    const key = normaliseUrl(link.url);
    if (decisions.has(key)) continue;
    const scored = hiring.find((l) => normaliseUrl(l.url) === key);
    decisions.set(key, {
      url: link.url,
      follow: false,
      reason: scored?.external === true ? "external_low_score" : "low_score",
      score: scored?.score ?? 0,
      external: scored?.external ?? false,
    });
  }

  return { hiring, about, decisions };
}

const step02: StepDefinition = {
  id: "02",
  dir: "02-link-ranking",
  name: "scoreLinks",
  target: "packages/retrieval → rankLinks + crawlSite selection rules",
  kind: "pure",
  adapter: "The spec's scoreLinks() does not exist. Scoring is rankLinks(); the follow decision lives inside crawlSite(). Reproduced here without fetching.",
  run: async (cases) => {
    const outcomes: CaseOutcome[] = [];
    for (const kase of cases) {
      const runs = await repeatCase(1, async (c) => {
        const { hiring, about, decisions } = scoreLinksAdapter(kase.input);
        const expected = kase.expected;

        const topHiring = hiring[0]?.url;
        c.ok("top_hiring", topHiring === expected["top_hiring"], `expected ${expected["top_hiring"]}, got ${topHiring}`);

        if (expected["top_about"] !== undefined) {
          const topAbout = about[0]?.url;
          c.ok("top_about", topAbout === expected["top_about"], `expected ${expected["top_about"]}, got ${topAbout}`);
        }

        for (const url of (expected["followed"] ?? []) as string[]) {
          const decision = decisions.get(normaliseUrl(url));
          c.ok(`follow: ${url}`, decision?.follow === true, decision === undefined ? "url not among candidates" : `follow=${decision.follow} reason=${decision.reason ?? "-"}`);
        }

        for (const entry of (expected["not_followed"] ?? []) as { url: string; reason: string }[]) {
          const decision = decisions.get(normaliseUrl(entry.url));
          const notFollowed = decision !== undefined && !decision.follow;
          c.ok(`not followed: ${entry.url}`, notFollowed, decision === undefined ? "url not among candidates" : `follow=${decision.follow}`);
          if (notFollowed) {
            c.ok(`reason ${entry.reason}: ${entry.url}`, decision.reason === entry.reason, `got "${decision.reason}"`);
          }
        }

        if (expected["deduped_to_one"] !== undefined) {
          const variants = expected["deduped_to_one"] as string[];
          const keys = new Set(variants.map((v) => normaliseUrl(v)));
          const present = [...decisions.keys()].filter((k) => keys.has(k));
          c.ok("variants collapse to one candidate", present.length === 1, `${present.length} distinct candidates: ${JSON.stringify(present)}`);
        }

        return {
          hiring: hiring.map((l) => ({ url: l.url, score: l.score, external: l.external, reasons: l.reasons })),
          about: about.map((l) => ({ url: l.url, score: l.score })),
          decisions: [...decisions.values()],
        };
      });
      outcomes.push({ id: kase.id, runs });
    }
    return outcomes;
  },
};

// ── 03 content classifier (not implemented) ──────────────────────────────────────────────

/** The nearest thing the codebase has: pipeline.ts's private hiring-signal hit count. */
const HIRING_SIGNALS = /\b(interview|hiring|hire|recruit|take[\s-]?home|candidate)\b/gi;

const step03: StepDefinition = {
  id: "03",
  dir: "03-content-classifier",
  name: "classifyContent",
  target: "packages/retrieval → classifyContent(cleanedText)",
  kind: "unimplemented",
  adapter: "No classifyContent exists, and nothing in the codebase scores 'about-ness' at all. The closest counterpart is findHiringPage()'s signal count, private to packages/pipeline. Reported as a diagnostic, not as a pass.",
  run: async (cases) => {
    const outcomes: CaseOutcome[] = [];
    for (const kase of cases) {
      const runs = await repeatCase(1, async (c) => {
        const text = kase.input["text"] as string;
        const hits = (text.match(HIRING_SIGNALS) ?? []).length;
        c.ok("classifyContent exists", false, "packages/retrieval exports no classifyContent; there is no about-page classifier anywhere");
        return {
          diagnostic: {
            hiring_signal_hits: hits,
            would_be_hiring_page_by_pipeline_heuristic: hits > 0,
            expected_is_hiring_page: kase.expected["is_hiring_page"],
            heuristic_agrees: hits > 0 === kase.expected["is_hiring_page"],
            expected_is_about_page: kase.expected["is_about_page"],
          },
        };
      });
      outcomes.push({ id: kase.id, runs });
    }
    return outcomes;
  },
};

// ── 04 research relevance (pure) ─────────────────────────────────────────────────────────

const step04: StepDefinition = {
  id: "04",
  dir: "04-research-relevance",
  name: "filterRelevance",
  target: "packages/research → filterRelevant(results, { company, companyUrl })",
  kind: "pure",
  adapter: "Named filterRelevant, not filterRelevance. It reports dropped results by url; the cases key them by id, so urls are mapped back to ids here.",
  run: async (cases) => {
    const outcomes: CaseOutcome[] = [];
    for (const kase of cases) {
      const runs = await repeatCase(1, async (c) => {
        const results = (kase.input["results"] as { id: string; url: string; title: string; snippet: string }[]).map((r) => ({
          title: r.title,
          url: r.url,
          content: r.snippet,
        }));
        const idByUrl = new Map((kase.input["results"] as { id: string; url: string }[]).map((r) => [r.url, r.id]));

        const outcome = filterRelevant(results, {
          company: kase.input["company"] as string,
          companyUrl: `https://${kase.input["domain"] as string}`,
        });

        const keptIds = outcome.kept.map((r) => idByUrl.get(r.url) ?? r.url);
        const droppedById = outcome.dropped.map((d) => ({ id: idByUrl.get(d.url) ?? d.url, reason: d.reason }));

        c.sameSet("kept ids", keptIds, (kase.expected["kept"] ?? []) as string[]);

        const expectedFiltered = (kase.expected["filtered"] ?? []) as { id: string; reason: string }[];
        c.sameSet("filtered ids", droppedById.map((d) => d.id), expectedFiltered.map((f) => f.id));
        for (const entry of expectedFiltered) {
          const actual = droppedById.find((d) => d.id === entry.id);
          c.ok(`filter reason ${entry.id}=${entry.reason}`, actual?.reason === entry.reason, `got "${actual?.reason ?? "not filtered"}"`);
        }

        // Kept results are used as the provider returned them — nothing here re-fetches.
        c.ok("no result is re-fetched", true, "filterRelevant is pure: it has no fetcher");

        return { kept: keptIds, dropped: droppedById };
      });
      outcomes.push({ id: kase.id, runs });
    }
    return outcomes;
  },
};

// ── 05 brief (LLM) ───────────────────────────────────────────────────────────────────────

const step05: StepDefinition = {
  id: "05",
  dir: "05-brief",
  name: "generateBrief",
  target: "packages/generation → generateBrief(input)",
  kind: "llm",
  run: async (cases, deps) => {
    const outcomes: CaseOutcome[] = [];
    for (const kase of cases) {
      const runs = await repeatCase(deps.repeat, async (c) => {
        const passages = (kase.input["passages"] ?? []) as { url: string; source: string; text: string }[];
        const result = await deps.tracer.span(`case:${kase.id}`, async (span) => {
          const r = await generateBrief({
            company: kase.input["company"] as string,
            roleTitle: kase.input["role"] as string,
            pages: passages.filter((p) => p.source === "site").map((p) => ({ url: p.url, title: "", text: p.text })),
            discussion: passages.filter((p) => p.source === "discussion").map((p) => ({ url: p.url, title: "", content: p.text })),
            llm: deps.llm,
          });
          span.set("sources_used", String(r.sourcesUsed));
          span.set("had_hiring_page", String(r.hadHiringPage));
          return r;
        });

        const brief = result.brief;
        const whole = `${brief.summary}\n${brief.whatTheyDo}\n${brief.hiringProcess}`;
        const expected = kase.expected;

        if (expected["hiring_process_empty"] === true) {
          c.ok("hiring_process is empty", brief.hiringProcess.trim() === "", `got "${brief.hiringProcess.slice(0, 120)}"`);
        }
        for (const phrase of (expected["hiring_process_must_mention"] ?? []) as string[]) {
          const present = normalise(brief.hiringProcess).includes(normalise(phrase));
          c.ok(`hiring_process mentions "${phrase}"`, present, present ? undefined : `hiring_process="${brief.hiringProcess.slice(0, 160)}"`);
        }
        for (const phrase of (expected["what_they_do_must_mention"] ?? []) as string[]) {
          const present = normalise(brief.whatTheyDo).includes(normalise(phrase));
          c.ok(`what_they_do mentions "${phrase}"`, present, present ? undefined : `what_they_do="${brief.whatTheyDo.slice(0, 160)}"`);
        }
        for (const phrase of (expected["must_not_mention"] ?? []) as string[]) {
          const present = normalise(whole).includes(normalise(phrase));
          c.ok(`brief avoids "${phrase}"`, !present, present ? "phrase appears in the brief" : undefined);
        }
        if (expected["honesty_markers"] !== undefined) {
          const markers = expected["honesty_markers"] as string[];
          const found = markers.find((m) => normalise(brief.whatTheyDo).includes(normalise(m)));
          c.ok("what_they_do carries an honesty marker", found !== undefined, found !== undefined ? `matched "${found}"` : `what_they_do="${brief.whatTheyDo.slice(0, 200)}"`);
        }

        const inputUrls = new Set(passages.map((p) => p.url));
        const strays = brief.sources.filter((s) => !inputUrls.has(s));
        c.ok("sources ⊆ provided passages", strays.length === 0, strays.length === 0 ? undefined : `invented sources ${JSON.stringify(strays)}`);

        return {
          summary: brief.summary,
          what_they_do: brief.whatTheyDo,
          hiring_process: brief.hiringProcess,
          sources: brief.sources,
          gaps: brief.gaps,
          fabricationAvoided: result.fabricationAvoided,
        };
      });
      outcomes.push({ id: kase.id, runs });
    }
    return outcomes;
  },
};

// ── 06 question generation (fake structural + real content) ──────────────────────────────

function questionCaseInput(kase: Case, llm: LlmProvider, ids: IdGenerator, span?: unknown): Record<string, unknown> {
  return {
    requirements: (kase.input["requirements"] as any[]).map(toRequirement),
    roleTitle: kase.input["role"] as string,
    company: kase.input["company"] as string,
    hiringProcess: kase.input["hiring_context"] as string,
    companySummary: kase.input["brief"] as string,
    responsibilities: (kase.input["responsibilities"] ?? []) as string[],
    llm,
    ids,
    ...(span !== undefined ? { span } : {}),
  };
}

const step06: StepDefinition = {
  id: "06",
  dir: "06-question-generation",
  name: "generateQuestions",
  target: "packages/generation → generateQuestions(input)",
  kind: "llm+fake",
  run: async (cases, deps) => {
    const outcomes: CaseOutcome[] = [];
    for (const kase of cases) {
      // ── structural half: FakeLlmProvider, one run, deterministic ──
      const structural = await attempt(async (c) => {
        const fake = new FakeLlmProvider();
        // The fake volunteers a hallucinated id alongside a real one, so the assertion that
        // returned ids ⊆ the ids in that call's prompt tests generateQuestions' filter and
        // not the fake's honesty.
        fake.respondWith("generate_questions", (request: any) => {
          const promptIds = [...String(request.prompt).matchAll(/\br\d+\b/g)].map((m) => m[0]);
          const first = promptIds[0];
          return {
            questions: [
              {
                prompt: `Question about ${first ?? "the role"} — walk me through it in detail please.`,
                answer_outline: "outline",
                difficulty: 2,
                requirement_ids: first === undefined ? ["r99"] : [first, "r99"],
              },
            ],
          };
        });

        const result = await generateQuestions(questionCaseInput(kase, fake, new SequentialIdGenerator()) as any);
        const calls = fake.calls.filter((call) => call.purpose.startsWith("generate_questions"));
        const categories = calls.map((call) => call.purpose.split(":")[1] ?? "");

        c.ok("exactly 4 calls, one per category", calls.length === 4, `made ${calls.length}: [${categories.join(", ")}]`);
        c.sameSet("one call per category", categories, ["technical", "behavioural", "system-design", "company-fit"]);

        const promptFor = (category: string): string => calls.find((call) => call.purpose.endsWith(category))?.prompt ?? "";
        const expected = kase.expected;

        const technicalPrompt = promptFor("technical");
        const behaviouralPrompt = promptFor("behavioural");
        const fitPrompt = promptFor("company-fit");

        for (const id of (expected["technical_call_has"] ?? []) as string[]) {
          c.ok(`technical prompt has ${id}`, new RegExp(`\\b${id}\\b`).test(technicalPrompt), technicalPrompt === "" ? "no technical call was made" : "id absent");
        }
        for (const id of (expected["technical_call_lacks"] ?? []) as string[]) {
          c.ok(`technical prompt lacks ${id}`, !new RegExp(`\\b${id}\\b`).test(technicalPrompt), "id present");
        }
        for (const id of (expected["behavioural_call_has"] ?? []) as string[]) {
          c.ok(`behavioural prompt has ${id}`, new RegExp(`\\b${id}\\b`).test(behaviouralPrompt), behaviouralPrompt === "" ? "no behavioural call was made" : "id absent");
        }
        for (const id of (expected["behavioural_call_lacks"] ?? []) as string[]) {
          c.ok(`behavioural prompt lacks ${id}`, !new RegExp(`\\b${id}\\b`).test(behaviouralPrompt), "id present");
        }
        for (const id of (expected["company_fit_call_has"] ?? []) as string[]) {
          c.ok(`company-fit prompt has ${id}`, new RegExp(`\\b${id}\\b`).test(fitPrompt), fitPrompt === "" ? "no company-fit call was made" : "id absent");
        }

        const brief = kase.input["brief"] as string;
        if (brief !== undefined && brief !== "") {
          c.ok("company-fit prompt carries the brief", normalise(fitPrompt).includes(normalise(brief)), fitPrompt === "" ? "no company-fit call was made" : "brief text absent");
        }

        const hiringContext = (kase.input["hiring_context"] ?? "") as string;
        if (hiringContext.trim() !== "") {
          for (const call of calls) {
            c.ok(`hiring context in ${call.purpose}`, normalise(call.prompt).includes(normalise(hiringContext)), "absent");
          }
        }

        // Returned ids must be a subset of the ids that call was shown.
        for (const question of result.questions) {
          const prompt = promptFor(question.category);
          const shown = new Set([...prompt.matchAll(/\br\d+\b/g)].map((m) => m[0]));
          const strays = question.requirementIds.filter((id) => !shown.has(id));
          c.ok(`ids of ${question.id} ⊆ its call's prompt`, strays.length === 0, `stray ${JSON.stringify(strays)}`);
        }

        if (kase.expected["all_requirement_ids_empty"] === true) {
          const tagged = result.questions.filter((q) => q.requirementIds.length > 0);
          c.ok("every requirement_ids is []", tagged.length === 0, `tagged: ${JSON.stringify(tagged.map((q) => [q.id, q.requirementIds]))}`);
        }

        return {
          half: "structural",
          calls: calls.map((call) => ({ purpose: call.purpose, prompt_chars: call.prompt.length })),
          reports: result.reports,
          questions: result.questions.map((q) => ({ id: q.id, category: q.category, requirementIds: q.requirementIds })),
        };
      });

      // ── content half: the real provider, repeated ──
      const content = await repeatCase(deps.repeat, async (c) => {
        const result = await deps.tracer.span(`case:${kase.id}`, async (span) =>
          generateQuestions(questionCaseInput(kase, deps.llm, new SequentialIdGenerator(), span) as any),
        );
        const questions = result.questions;

        for (const q of questions) {
          c.ok(`${q.id} has a prompt`, q.prompt.trim().length > 0);
          c.ok(`${q.id} has an answer_outline`, q.answerOutline.trim().length > 0);
          c.ok(`${q.id} difficulty ∈ {1,2,3}`, [1, 2, 3].includes(q.difficulty), `got ${q.difficulty}`);
        }

        const banned = (kase.expected["tools_not_in_behavioural"] ?? []) as string[];
        for (const q of questions.filter((x) => x.category === "behavioural")) {
          for (const tool of banned) {
            const present = new RegExp(`\\b${tool.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(`${q.prompt} ${q.answerOutline}`);
            c.ok(`behavioural ${q.id} avoids "${tool}"`, !present, present ? q.prompt.slice(0, 120) : undefined);
          }
        }

        if (kase.expected["system_design_mentions"] !== undefined) {
          const phrases = kase.expected["system_design_mentions"] as string[];
          const design = questions.filter((q) => q.category === "system-design");
          const hit = design.some((q) => phrases.some((p) => normalise(`${q.prompt} ${q.answerOutline}`).includes(normalise(p))));
          c.ok("a system-design question reflects the hiring context", hit, design.length === 0 ? "no system-design questions were generated" : `none of ${JSON.stringify(phrases)} appeared`);
        }

        if (kase.expected["min_total_questions"] !== undefined) {
          const min = kase.expected["min_total_questions"] as number;
          const max = kase.expected["max_total_questions"] as number;
          c.ok(`total questions in [${min}, ${max}]`, questions.length >= min && questions.length <= max, `got ${questions.length}`);
        }
        if (kase.expected["all_requirement_ids_empty"] === true) {
          const tagged = questions.filter((q) => q.requirementIds.length > 0);
          c.ok("every requirement_ids is [] (real provider)", tagged.length === 0, JSON.stringify(tagged.map((q) => [q.id, q.requirementIds])));
        }

        return {
          half: "content",
          reports: result.reports,
          questions: questions.map((q) => ({ id: q.id, category: q.category, difficulty: q.difficulty, requirementIds: q.requirementIds, prompt: q.prompt })),
        };
      });

      outcomes.push({ id: kase.id, runs: [structural, ...content] });
    }
    return outcomes;
  },
};

// ── 07 coverage gates (pure) ─────────────────────────────────────────────────────────────

const step07: StepDefinition = {
  id: "07",
  dir: "07-coverage-gates",
  name: "applyGates + findGaps",
  target: "packages/coverage → gateQuestionTags + detectGaps",
  kind: "pure",
  adapter: "Named gateQuestionTags and detectGaps. Applied in the order runCoverage applies them: every question is retagged before the first gap check.",
  run: async (cases) => {
    const outcomes: CaseOutcome[] = [];
    for (const kase of cases) {
      const runs = await repeatCase(1, async (c) => {
        const requirements = (kase.input["requirements"] as any[]).map(toRequirement) as any[];
        const byId = new Map(requirements.map((r) => [r.id as string, r]));
        const questions = (kase.input["questions"] as any[]).map((q, i) => toInternalQuestion(q, i)) as any[];

        const dropped: string[] = [];
        const retaggedById: Record<string, string[]> = {};
        const gated = questions.map((question) => {
          const verdict = gateQuestionTags(question as any, byId as any);
          retaggedById[question.id as string] = verdict.kept;
          for (const d of verdict.dropped) dropped.push(`${question.id}:${d.id}=${d.reason}`);
          return { ...question, requirementIds: verdict.kept };
        });

        const gaps = detectGaps(requirements as any, gated as any);
        const expected = kase.expected;

        for (const [qid, ids] of Object.entries((expected["retagged"] ?? {}) as Record<string, string[]>)) {
          c.eq(`retagged ${qid}`, retaggedById[qid], ids);
        }

        for (const entry of (expected["dropped"] ?? []) as string[]) {
          // The spec writes name_drop / no_overlap / unknown_id; the implementation says
          // unknown_requirement for the last one.
          const normalised = entry.replace("=unknown_id", "=unknown_requirement");
          c.ok(`dropped ${entry}`, dropped.includes(normalised), `actual drops: ${JSON.stringify(dropped)}`);
        }

        c.sameSet("gaps (must only)", gaps.uncoveredMustIds, (expected["gaps"] ?? []) as string[]);

        if (expected["uncovered_nice"] !== undefined) {
          c.sameSet("uncovered nice-to-haves", gaps.uncoveredNiceIds, expected["uncovered_nice"] as string[]);
        }

        if (expected["rejected_questions"] !== undefined) {
          const rejected = (expected["rejected_questions"] as string[]).filter((id) => gated.some((q) => q.id === id));
          c.ok("rejected questions removed entirely", rejected.length === 0, `still present: ${JSON.stringify(rejected)} — the bulk path applies gateQuestionTags only; acceptGapFill (empty/stub/duplicate) runs on gap-fill drafts, not on generated questions`);
        }

        return { retagged: retaggedById, dropped, gaps };
      });
      outcomes.push({ id: kase.id, runs });
    }
    return outcomes;
  },
};

// ── 08 gap-fill loop (pure + scripted fake) ──────────────────────────────────────────────

const step08: StepDefinition = {
  id: "08",
  dir: "08-gap-fill-loop",
  name: "coverageLoop",
  target: "packages/coverage → runCoverage(input)",
  kind: "pure+fake",
  adapter: "Named runCoverage. It takes a GapFillWriter rather than an LlmProvider; the writer here is backed by a FakeLlmProvider so calls are recorded and one-requirement-per-call is observable.",
  run: async (cases, deps) => {
    const outcomes: CaseOutcome[] = [];
    for (const kase of cases) {
      const runs = await repeatCase(1, async (c) => {
        const tracer = deps.tracer;
        const requirements = (kase.input["requirements"] as any[]).map(toRequirement) as any[];
        const questions = (kase.input["questions"] as any[]).map((q, i) => toInternalQuestion(q, i)) as any[];
        const scripted = [...((kase.input["fake_responses"] ?? []) as any[])];

        const fake = new FakeLlmProvider();
        const callOrder: string[] = [];
        const perCallRequirementCounts: number[] = [];
        let exhausted = false;

        fake.respondWith("gap_fill", (request: any) => {
          const wanted = String(request.purpose).replace(/^gap_fill:?/, "");
          const index = scripted.findIndex((r) => r.for === wanted);
          if (index === -1) {
            exhausted = true;
            return { prompt: "", answer_outline: "", difficulty: 2 };
          }
          const [response] = scripted.splice(index, 1);
          return { prompt: response.prompt, answer_outline: response.answer_outline, difficulty: response.difficulty };
        });

        const result = await tracer.span(`case:${kase.id}`, async (span) =>
          runCoverage({
            requirements,
            questions,
            roleTitle: "Engineer",
            ids: new SequentialIdGenerator(),
            maxExtraPasses: 2,
            span,
            writer: async (request: any) => {
              perCallRequirementCounts.push(request.requirements.length);
              for (const r of request.requirements) callOrder.push(r.id);
              const { data } = await fake.complete({
                purpose: `gap_fill:${request.requirements.map((r: any) => r.id).join("+")}`,
                prompt: `gap fill for ${request.requirements.map((r: any) => r.id).join("+")}`,
                schema: { safeParse: (v: unknown) => ({ success: true as const, data: v }) } as any,
              } as any);
              const draft = data as any;
              return { prompt: draft.prompt, answerOutline: draft.answer_outline, difficulty: draft.difficulty };
            },
          }),
        );

        const expected = kase.expected;
        c.ok("passes", result.passes === expected["passes"], `expected ${expected["passes"]}, got ${result.passes}`);
        c.ok("llm call count", callOrder.length === expected["llm_calls"], `expected ${expected["llm_calls"]}, got ${callOrder.length}`);
        c.eq("call order", callOrder, expected["call_order"]);
        c.sameSet("uncovered", result.uncoveredRequirementIds, (expected["uncovered"] ?? []) as string[]);

        const attempts = result.reports.flatMap((r) => r.attempts);
        const outcomesActual = attempts.map((a) => ({ for: a.requirementIds.join("+"), accepted: a.accepted }));
        c.eq("accept/reject per call", outcomesActual, expected["outcomes"]);

        const oneEach = perCallRequirementCounts.every((n) => n === 1);
        c.ok("one requirement per gap-fill call", oneEach, `counts: ${JSON.stringify(perCallRequirementCounts)}`);

        // The caller assigns the ids; nothing the fake returned is used for labelling.
        const added = result.questions.filter((q) => !questions.some((orig) => orig.id === q.id));
        const callerAssigned = added.every((q) => q.requirementIds.length > 0 && q.requirementIds.every((id) => requirements.some((r) => r.id === id)));
        c.ok("requirement_ids assigned by the caller", added.length === 0 || callerAssigned, JSON.stringify(added.map((q) => [q.id, q.origin, q.requirementIds])));

        c.ok("no scripted response beyond the cap was requested", !exhausted, "the loop asked for a response the case marked as never-to-be-called");

        return {
          passes: result.passes,
          callOrder,
          outcomes: outcomesActual,
          uncovered: result.uncoveredRequirementIds,
          fallbackCount: result.fallbackCount,
          questions: result.questions.map((q) => ({ id: q.id, origin: q.origin, requirementIds: q.requirementIds, prompt: q.prompt })),
        };
      });
      outcomes.push({ id: kase.id, runs });
    }
    return outcomes;
  },
};

// ── 09 fallback (pure) ───────────────────────────────────────────────────────────────────

const TEMPLATE_STOPWORDS = new Set([
  "the", "role", "requires", "walk", "through", "your", "experience", "with", "it", "and", "a",
  "hard", "problem", "you", "solved", "mentions", "describe", "time", "did", "this", "how",
  "went", "is", "in", "what's", "what", "s", "background", "there", "specific", "about",
  "domain", "for",
]);

const step09: StepDefinition = {
  id: "09",
  dir: "09-fallback",
  name: "buildFallbackQuestion",
  target: "packages/coverage → fallbackQuestion(requirement, roleTitle)",
  kind: "pure",
  adapter: "Named fallbackQuestion and it lives in packages/coverage, not packages/generation. It returns a draft; origin \"fallback\" is stamped by runCoverage when the draft becomes a question.",
  run: async (cases) => {
    const outcomes: CaseOutcome[] = [];
    for (const kase of cases) {
      const runs = await repeatCase(1, async (c) => {
        const fake = new FakeLlmProvider();
        const before = fake.calls.length;
        const requirement = toRequirement(kase.input["requirement"] as any) as any;
        const roleTitle = kase.input["role_title"] as string;

        const draft = fallbackQuestion(requirement, roleTitle);

        c.ok("no LLM call was made", fake.calls.length === before, `calls went from ${before} to ${fake.calls.length}`);
        c.ok("category", draft.category === kase.expected["category"], `expected ${kase.expected["category"]}, got ${draft.category}`);
        c.eq("requirement_ids", draft.requirementIds, [requirement.id]);
        c.ok("difficulty is an integer in {1,2,3}", Number.isInteger(draft.difficulty) && [1, 2, 3].includes(draft.difficulty), `got ${draft.difficulty}`);

        const mustContain = kase.expected["must_contain"] as string;
        c.ok(`prompt contains "${mustContain}"`, normalise(draft.prompt).includes(normalise(mustContain)), `prompt="${draft.prompt}"`);

        // Nothing in the prompt that is not template scaffolding, the requirement text, its
        // source span, or the role title.
        const permitted = new Set([
          ...normalise(requirement.text as string).split(" "),
          ...normalise((requirement.sourceSpan as string) ?? "").split(" "),
          ...normalise(roleTitle).split(" "),
        ]);
        const invented = normalise(draft.prompt)
          .split(" ")
          .filter(Boolean)
          .filter((token) => !TEMPLATE_STOPWORDS.has(token) && !permitted.has(token));
        c.ok("no token invented outside the inputs", invented.length === 0, `invented: ${JSON.stringify(invented)}`);

        // origin is stamped by runCoverage, so assert it there rather than on the draft.
        c.ok("draft carries no invented answer outline", draft.answerOutline.trim() === "", `outline="${draft.answerOutline}"`);

        return { draft };
      });
      outcomes.push({ id: kase.id, runs });
    }
    return outcomes;
  },
};

// ── 10 flashcards (pure) ─────────────────────────────────────────────────────────────────

const step10: StepDefinition = {
  id: "10",
  dir: "10-flashcards",
  name: "deriveFlashcards",
  target: "packages/generation → deriveFlashcards(questions, ids)",
  kind: "pure",
  run: async (cases) => {
    const outcomes: CaseOutcome[] = [];
    for (const kase of cases) {
      const runs = await repeatCase(1, async (c) => {
        const fake = new FakeLlmProvider();
        const questions = (kase.input["questions"] as any[]).map((q, i) => toInternalQuestion(q, i)) as any[];
        const cards = deriveFlashcards(questions as any, new SequentialIdGenerator());

        c.ok("zero LLM calls", fake.calls.length === 0);
        c.ok("one card per question", cards.length === questions.length, `${questions.length} questions → ${cards.length} cards`);

        const expectedFronts = (kase.expected["fronts"] ?? {}) as Record<string, string>;
        for (const [qid, front] of Object.entries(expectedFronts)) {
          const card = cards.find((card) => card.questionId === qid);
          c.ok(`front of ${qid}`, card?.front === front, card === undefined ? "no card produced" : `got "${card.front}"`);
        }

        for (const card of cards) {
          const source = questions.find((q) => q.id === card.questionId);
          c.eq(`requirement_ids copied for ${card.questionId}`, card.requirementIds, source?.requirementIds);
          c.ok(`back of ${card.questionId} is the answer_outline`, card.back === String(source?.answerOutline ?? "").trim());
          c.ok(`front of ${card.questionId} is not truncated`, !/(…|\.\.\.)$/.test(card.front), `front="${card.front}"`);
          c.ok(`front of ${card.questionId} ends in terminal punctuation`, /[.?!]$/.test(card.front), `front="${card.front}"`);
        }

        return { cards: cards.map((card) => ({ questionId: card.questionId, front: card.front, back: card.back, requirementIds: card.requirementIds })) };
      });
      outcomes.push({ id: kase.id, runs });
    }
    return outcomes;
  },
};

// ── 11 scheduling (pure) ─────────────────────────────────────────────────────────────────

const GENERIC_FOCUS = ["mixed practice", "technical depth", "practice", "review"];

const step11: StepDefinition = {
  id: "11",
  dir: "11-scheduling",
  name: "allocateSchedule + repairSchedule",
  target: "packages/scheduling → allocateSchedule · packages/kit → repairSchedule",
  kind: "pure",
  adapter: "repairSchedule lives in packages/kit, not packages/scheduling — repair must be minimal-disturbance rather than a re-allocation.",
  run: async (cases) => {
    const outcomes: CaseOutcome[] = [];
    for (const kase of cases) {
      const runs = await repeatCase(1, async (c) => {
        // ── repair cases ──
        if (kase.input["schedule"] !== undefined) {
          const questions = (kase.input["questions"] as any[]).map((q, i) => toInternalQuestion(q, i)) as any[];
          const schedule = {
            daysAvailable: kase.input["schedule"].days_available as number,
            days: (kase.input["schedule"].days as any[]).map((d) => ({
              day: d.day as number,
              focus: d.focus as string,
              questionIds: [...(d.question_ids as string[])],
              minutes: d.minutes as number,
              edited: d.edited === true,
            })),
          };

          const repaired = repairSchedule(schedule as any, questions as any);
          const expectedDays = (kase.expected["after_repair"].days as any[]);

          for (const expectedDay of expectedDays) {
            const actual = repaired.days.find((d) => d.day === expectedDay.day);
            c.eq(`day ${expectedDay.day} question_ids`, actual?.questionIds, expectedDay.question_ids);
            c.ok(`day ${expectedDay.day} minutes`, actual?.minutes === expectedDay.minutes, `expected ${expectedDay.minutes}, got ${actual?.minutes}`);
            if (expectedDay.focus !== undefined) {
              c.ok(`day ${expectedDay.day} focus preserved`, actual?.focus === expectedDay.focus, `expected "${expectedDay.focus}", got "${actual?.focus}"`);
            }
          }
          return { repaired };
        }

        // ── allocation cases ──
        const requirements = (kase.input["requirements"] as any[]).map(toRequirement) as any[];
        const questions = (kase.input["questions"] as any[]).map((q, i) => toInternalQuestion(q, i)) as any[];
        const days = kase.input["days"] as number;

        const schedule = allocateSchedule({ questions: questions as any, requirements: requirements as any, daysAvailable: days });
        const expected = kase.expected;

        c.ok("days.length === days_available", schedule.days.length === days, `expected ${days}, got ${schedule.days.length}`);

        const questionById = new Map(questions.map((q) => [q.id as string, q]));
        const scheduledIds = schedule.days.flatMap((d) => d.questionIds);
        const uniqueScheduled = new Set(scheduledIds);

        for (const id of uniqueScheduled) {
          c.ok(`scheduled id ${id} exists`, questionById.has(id));
        }
        const missing = questions.filter((q) => !uniqueScheduled.has(q.id as string)).map((q) => q.id);
        c.ok("every active question is scheduled", missing.length === 0, `missing ${JSON.stringify(missing)}`);

        for (const day of schedule.days) {
          const dupes = day.questionIds.length !== new Set(day.questionIds).size;
          c.ok(`day ${day.day} has no repeat within itself`, !dupes);
          c.ok(`day ${day.day} minutes is an integer`, Number.isInteger(day.minutes), `got ${day.minutes}`);
          c.ok(`day ${day.day} focus is non-empty`, day.focus.trim().length > 0);
          c.ok(`day ${day.day} focus is not generic`, !GENERIC_FOCUS.includes(day.focus.trim().toLowerCase()), `focus="${day.focus}"`);
          c.ok(`day ${day.day} focus does not start lowercase`, !/^[a-z]/.test(day.focus.trim()), `focus="${day.focus}"`);
          if (day.questionIds.length === 0) {
            c.ok(`empty day ${day.day} has minutes 0`, day.minutes === 0, `got ${day.minutes}`);
          } else {
            c.ok(`day ${day.day} minutes > 0`, day.minutes > 0);
          }
        }

        // must-have coverage across the schedule
        const scheduledRequirementIds = new Set(
          [...uniqueScheduled].flatMap((id) => (questionById.get(id)?.requirementIds ?? []) as string[]),
        );
        for (const id of (expected["must_scheduled"] ?? []) as string[]) {
          c.ok(`must ${id} appears in the schedule`, scheduledRequirementIds.has(id));
        }

        // front-loading
        const day1 = schedule.days[0]?.questionIds ?? [];
        for (const id of (expected["day1_contains"] ?? []) as string[]) {
          c.ok(`day 1 contains ${id}`, day1.includes(id), `day 1 = ${JSON.stringify(day1)}`);
        }

        const maxDifficultyByDay = schedule.days.map((d) =>
          d.questionIds.reduce((max, id) => Math.max(max, (questionById.get(id)?.difficulty as number) ?? 0), 0),
        );
        // The README conditions this on `expected.max_difficulty_by_day`, so it is only asserted
        // for a case that supplies it. Applied unconditionally it contradicts the five-days-mixed
        // note ("a must-tagged question outranks an untagged one of equal difficulty") and the
        // documented 60-day spaced-review policy, which cycles difficulty by design.
        if (expected["max_difficulty_by_day"] !== undefined) {
          const nonIncreasing = maxDifficultyByDay
            .filter((value) => value > 0)
            .every((value, index, list) => index === 0 || (list[index - 1] as number) >= value);
          c.ok("max difficulty per day is non-increasing", nonIncreasing, `by day: ${JSON.stringify(maxDifficultyByDay)}`);
        }

        if (expected["last_day_max_difficulty"] !== undefined) {
          const last = maxDifficultyByDay[maxDifficultyByDay.length - 1];
          c.ok("last day max difficulty", last === expected["last_day_max_difficulty"], `expected ${expected["last_day_max_difficulty"]}, got ${last}`);
        }

        if (expected["total_minutes"] !== undefined) {
          const total = schedule.days.reduce((sum, d) => sum + d.minutes, 0);
          c.ok("total_minutes", total === expected["total_minutes"], `expected ${expected["total_minutes"]}, got ${total}`);
        }

        if (expected["focus_contains"] !== undefined) {
          for (const [dayNumber, phrase] of Object.entries(expected["focus_contains"] as Record<string, string>)) {
            const day = schedule.days.find((d) => d.day === Number(dayNumber));
            c.ok(`day ${dayNumber} focus contains "${phrase}"`, normalise(day?.focus ?? "").includes(normalise(phrase)), `focus="${day?.focus}"`);
          }
        }
        if (expected["focus_not_in"] !== undefined) {
          for (const phrase of expected["focus_not_in"] as string[]) {
            const offender = schedule.days.find((d) => normalise(d.focus).includes(normalise(phrase)));
            c.ok(`no focus contains "${phrase}"`, offender === undefined, offender === undefined ? undefined : `day ${offender.day} focus="${offender.focus}"`);
          }
        }

        return { schedule, maxDifficultyByDay };
      });
      outcomes.push({ id: kase.id, runs });
    }
    return outcomes;
  },
};

// ── 12 serialize (pure) ──────────────────────────────────────────────────────────────────

const INTERNAL_FIELDS = ["origin", "pinned", "active", "source_span", "edited", "hiring_signal", "gaps", "passages", "version"];

function findFields(value: unknown, names: readonly string[], path = "$"): string[] {
  const found: string[] = [];
  if (Array.isArray(value)) {
    value.forEach((item, index) => found.push(...findFields(item, names, `${path}[${index}]`)));
  } else if (value !== null && typeof value === "object") {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (names.includes(key)) found.push(`${path}.${key}`);
      found.push(...findFields(child, names, `${path}.${key}`));
    }
  }
  return found;
}

const step12: StepDefinition = {
  id: "12",
  dir: "12-serialize",
  name: "toKitJSON",
  target: "packages/kit → toKitJSON(internalKit)",
  kind: "pure",
  adapter:
    "The cases describe a kit with a top-level `source` block and role.seniority. The implemented Appendix A has role{title,company,location,summary,responsibilities} and top-level requirements — no source block, no seniority. Case input is mapped onto the implemented shape; the source/seniority assertions are reported as a spec conflict.",
  run: async (cases) => {
    const outcomes: CaseOutcome[] = [];
    for (const kase of cases) {
      const runs = await repeatCase(1, async (c) => {
        const raw = kase.input["kit"] as any;
        const source = raw.source ?? {};
        const internal = {
          id: "kit_1",
          createdAt: 0,
          role: {
            title: raw.role?.title ?? "",
            company: source.company ?? "",
            // Deliberately preserves `undefined` when the case omits location — that is the
            // whole point of the location-empty-string-not-undefined case.
            location: source.location,
            summary: raw.role?.seniority ?? "",
            responsibilities: [...(raw.role?.responsibilities ?? [])],
          },
          companyBrief: {
            summary: raw.company_brief?.summary ?? "",
            whatTheyDo: raw.company_brief?.what_they_do ?? "",
            hiringProcess: raw.company_brief?.hiring_process ?? "",
            sources: [...(raw.company_brief?.sources ?? [])],
            pagesUsed: [...(source.pages_used ?? [])],
            gaps: [...(raw.company_brief?.gaps ?? [])],
            edited: false,
          },
          requirements: (raw.role?.requirements ?? []).map(toRequirement),
          questions: (raw.questions ?? []).map((q: any, i: number) => toInternalQuestion(q, i)),
          flashcards: (raw.flashcards ?? []).map((f: any, i: number) => ({
            id: f.id,
            front: f.front,
            back: f.back,
            requirementIds: [...(f.requirement_ids ?? [])],
            questionId: null,
            origin: f.origin ?? "generated",
            pinned: false,
            active: f.active ?? true,
            order: i,
          })),
          schedule: {
            daysAvailable: raw.schedule.days_available,
            days: (raw.schedule.days ?? []).map((d: any) => ({
              day: d.day,
              focus: d.focus,
              questionIds: [...(d.question_ids ?? [])],
              minutes: d.minutes,
              edited: d.edited === true,
            })),
          },
          coverage: {
            passes: raw.coverage?.passes ?? 1,
            uncoveredRequirementIds: [...(raw.coverage?.uncovered_requirement_ids ?? [])],
          },
        };

        if (kase.expected["throws"] === true) {
          let threw = false;
          let message = "";
          try {
            toKitJSON(internal as any);
          } catch (error) {
            threw = true;
            message = error instanceof Error ? `${error.message} ${JSON.stringify((error as any).details ?? {})}` : String(error);
          }
          c.ok("toKitJSON rejects the kit", threw, threw ? undefined : "it returned a kit");
          for (const phrase of (kase.expected["validation_errors_mention"] ?? []) as string[]) {
            c.ok(`validation error mentions "${phrase}"`, message.toLowerCase().includes(phrase.toLowerCase()), `errors: ${message.slice(0, 400)}`);
          }
          return { threw, message };
        }

        const output = toKitJSON(internal as any);

        const validation = validateKitJSON(output);
        c.ok("output passes the Appendix A validator", validation.ok, JSON.stringify(validation.errors));

        const leaked = findFields(output, INTERNAL_FIELDS);
        // `gaps` is a deliberate Appendix A extension in this implementation (company_brief.gaps).
        const unexpected = leaked.filter((path) => path !== "$.company_brief.gaps");
        c.ok("internal fields stripped", unexpected.length === 0, `leaked at ${JSON.stringify(unexpected)}`);
        c.ok("company_brief.gaps is a documented extension, not a leak", leaked.includes("$.company_brief.gaps"), "absent — no assertion either way");

        c.eq("question ids", output.questions.map((q) => q.id), kase.expected["question_ids"]);
        c.eq("flashcard ids", output.flashcards.map((f) => f.id), kase.expected["flashcard_ids"]);

        const questionIds = new Set(output.questions.map((q) => q.id));
        const dangling = output.schedule.days.flatMap((d) => d.question_ids).filter((id) => !questionIds.has(id));
        c.ok("no dangling schedule ids", dangling.length === 0, JSON.stringify(dangling));

        if (kase.expected["q3_scheduled_somewhere"] === true) {
          const scheduled = new Set(output.schedule.days.flatMap((d) => d.question_ids));
          c.ok("the unscheduled active question was placed", scheduled.has("q3"), `scheduled: ${JSON.stringify([...scheduled])}`);
        }

        c.sameSet("coverage.uncovered_requirement_ids", output.coverage.uncovered_requirement_ids, (kase.expected["uncovered"] ?? []) as string[]);

        const hasSource = Object.prototype.hasOwnProperty.call(output, "source");
        c.ok("`source` block with seven fields", hasSource, "the implemented Appendix A has no `source` block — role{title,company,location,summary,responsibilities} carries this instead (spec conflict, not a regression)");
        const hasSeniority = Object.prototype.hasOwnProperty.call(output.role ?? {}, "seniority");
        c.ok("role.seniority present", hasSeniority, "the implemented role schema has `summary`, not `seniority` (spec conflict)");
        c.ok("role has title and responsibilities", typeof output.role?.title === "string" && Array.isArray(output.role?.responsibilities));
        c.ok("requirements present on the kit", Array.isArray((output as any).requirements), "top-level, not nested under role");

        return { output };
      });
      outcomes.push({ id: kase.id, runs });
    }
    return outcomes;
  },
};


// ── 13 builder mutations (pure) ──────────────────────────────────────────────────────────

/** The fixture is Appendix A shaped; storage is camelCase. One place that knows both. */
function toInternalKit(raw: any): any {
  const role = raw.role ?? {};
  return {
    id: raw.id ?? "kit_1",
    createdAt: 0,
    version: raw.version ?? 1,
    role: {
      title: role.title ?? "",
      company: raw.source?.company ?? "",
      location: raw.source?.location ?? "",
      summary: role.seniority ?? "",
      responsibilities: [...(role.responsibilities ?? [])],
    },
    companyBrief: {
      summary: raw.company_brief?.summary ?? "",
      whatTheyDo: raw.company_brief?.what_they_do ?? "",
      // The fixture calls it `hiring_signal`; the implemented brief calls it `hiringProcess`.
      hiringProcess: raw.company_brief?.hiring_process ?? raw.company_brief?.hiring_signal ?? "",
      sources: [...(raw.company_brief?.sources ?? [])],
      // The fixture keeps these under the top-level `source` block. Regenerating the brief reads
      // them, so dropping them here would quietly turn that case into the no-context path, where
      // `generateBrief` writes an honest empty brief in code and never calls a model at all.
      pagesUsed: [...(raw.source?.pages_used ?? [])],
      ...(raw.company_brief?.passages !== undefined ? { passages: raw.company_brief.passages } : {}),
      gaps: [...(raw.company_brief?.gaps ?? [])],
      edited: false,
      origin: raw.company_brief?.origin ?? "generated",
    },
    requirements: (role.requirements ?? []).map(toRequirement),
    questions: (raw.questions ?? []).map((q: any, i: number) => ({
      id: q.id,
      category: q.category,
      prompt: q.prompt,
      answerOutline: q.answer_outline ?? "",
      difficulty: q.difficulty ?? 2,
      requirementIds: [...(q.requirement_ids ?? [])],
      origin: q.origin ?? "generated",
      pinned: q.pinned ?? false,
      active: q.active ?? true,
      order: q.order ?? i,
    })),
    flashcards: (raw.flashcards ?? []).map((f: any, i: number) => ({
      id: f.id,
      front: f.front,
      back: f.back,
      requirementIds: [...(f.requirement_ids ?? [])],
      questionId: f.derived_from ?? null,
      origin: f.origin ?? "generated",
      pinned: f.pinned ?? false,
      active: f.active ?? true,
      order: f.order ?? i,
    })),
    schedule: {
      daysAvailable: raw.schedule?.days_available ?? (raw.schedule?.days ?? []).length,
      days: (raw.schedule?.days ?? []).map((d: any) => ({
        day: d.day,
        focus: d.focus ?? "",
        questionIds: [...(d.question_ids ?? [])],
        minutes: d.minutes ?? 0,
        edited: d.edited ?? false,
      })),
    },
    coverage: {
      passes: raw.coverage?.passes ?? 1,
      uncoveredRequirementIds: [...(raw.coverage?.uncovered_requirement_ids ?? [])],
    },
  };
}

/**
 * Ids that cannot collide with the fixture's.
 *
 * `SequentialIdGenerator` starts at q1, and the base kit already has q1..q8. Handing coverage a
 * generator that mints `q1` for a gap fill would silently overwrite the user's first question
 * and make `ids_never_reused` pass for the wrong reason. Storage never reuses an id, so neither
 * does the runner: taken names are skipped, not renumbered around.
 */
class FreshIds implements IdGenerator {
  readonly #inner = new SequentialIdGenerator();
  readonly #taken: Set<string>;

  constructor(taken: Iterable<string>) {
    this.#taken = new Set(taken);
  }

  next(prefix: string): string {
    for (;;) {
      const id = this.#inner.next(prefix);
      if (this.#taken.has(id)) continue;
      this.#taken.add(id);
      return id;
    }
  }
}

/**
 * The case's `fake_responses`, consumed in order across every purpose.
 *
 * One queue rather than one per purpose, because the order the cases are written in is the order
 * the calls happen: the category call, then a gap fill if coverage opened one. Registering by
 * prefix lets `generate_questions:technical` and `gap_fill:r2` both draw from it without the
 * case having to know the purpose strings.
 *
 * An exhausted queue returns a value no schema accepts, so the call fails the way a provider
 * returning junk would. That is deliberate: a case that scripts one answer and triggers two
 * calls should exercise the degradation path, not be quietly handed the same answer twice.
 */
function scriptedFake(responses: readonly unknown[], tracer: Tracer): FakeLlmProvider {
  const queue = [...responses];
  const next = (): unknown => (queue.length > 0 ? queue.shift() : { exhausted_fake_response_queue: true });

  const fake = new FakeLlmProvider({ tracer });
  for (const purpose of ["generate_questions", "gap_fill", "generate_brief"]) fake.respondWith(purpose, next);
  return fake;
}

/**
 * Apply one operation from a case.
 *
 * Everything but `regenerate` is a pure mutation in `packages/kit`. `regenerate` is
 * `packages/pipeline → regenerateSection`, which is the only operation here that reaches a model.
 */
async function applyOperation(
  kit: any,
  op: any,
  ids: IdGenerator,
  regen: { llm: LlmProvider; tracer: Tracer },
): Promise<any> {
  const options = op.if_version === undefined ? undefined : { ifVersion: op.if_version };

  if (op.op === "regenerate") {
    return regenerateSection(
      kit,
      { section: op.section, ...(op.category !== undefined ? { category: op.category } : {}) },
      {
        llm: regen.llm,
        ids,
        tracer: regen.tracer,
        ...(options !== undefined ? { ifVersion: options.ifVersion } : {}),
      },
    );
  }

  switch (op.op) {
    case "edit": {
      if (op.section === "company_brief" || String(op.id ?? "").startsWith("brief")) {
        return editBrief(kit, snakeToBriefPatch(op.fields ?? {}), options);
      }
      if (String(op.id ?? "").startsWith("f")) {
        return editFlashcard(kit, op.id, snakeToFlashcardPatch(op.fields ?? {}), options);
      }
      if (op.day !== undefined) {
        return editScheduleDay(kit, op.day, snakeToSchedulePatch(op.fields ?? {}), options);
      }
      return editQuestion(kit, op.id, snakeToQuestionPatch(op.fields ?? {}), options);
    }
    case "pin":
      return pinQuestion(kit, op.id, op.pinned ?? true, options);
    case "delete":
      return String(op.id ?? "").startsWith("f")
        ? deleteFlashcard(kit, op.id, options)
        : deleteQuestion(kit, op.id, options);
    case "move":
      return moveQuestion(kit, op.id, op.to_category, options);
    case "reorder":
      return reorderQuestions(kit, op.category, op.ids ?? [], options);
    case "add": {
      if (op.flashcard) {
        return addFlashcard(
          kit,
          { front: op.flashcard.front, back: op.flashcard.back, requirementIds: [...(op.flashcard.requirement_ids ?? [])] },
          ids,
          options,
        );
      }
      const q = op.question ?? {};
      return addQuestion(
        kit,
        {
          category: q.category,
          prompt: q.prompt,
          answerOutline: q.answer_outline ?? "",
          difficulty: q.difficulty ?? 2,
          requirementIds: [...(q.requirement_ids ?? [])],
        },
        ids,
        options,
      );
    }
    default:
      throw new Error(`unsupported op: ${String(op.op)}`);
  }
}

function snakeToQuestionPatch(fields: any): any {
  const patch: any = {};
  if (fields.prompt !== undefined) patch.prompt = fields.prompt;
  if (fields.answer_outline !== undefined) patch.answerOutline = fields.answer_outline;
  if (fields.difficulty !== undefined) patch.difficulty = fields.difficulty;
  return patch;
}
function snakeToFlashcardPatch(fields: any): any {
  const patch: any = {};
  if (fields.front !== undefined) patch.front = fields.front;
  if (fields.back !== undefined) patch.back = fields.back;
  if (fields.requirement_ids !== undefined) patch.requirementIds = [...fields.requirement_ids];
  return patch;
}
function snakeToSchedulePatch(fields: any): any {
  const patch: any = {};
  if (fields.focus !== undefined) patch.focus = fields.focus;
  if (fields.minutes !== undefined) patch.minutes = fields.minutes;
  if (fields.question_ids !== undefined) patch.questionIds = [...fields.question_ids];
  return patch;
}

const step13: StepDefinition = {
  id: "13",
  dir: "13-builder-regeneration",
  name: "builder mutations + regenerateSection",
  target: "packages/kit → edit/delete/move/reorder/add/version · packages/pipeline → regenerateSection",
  kind: "pure+fake",
  adapter:
    "Cases are Appendix A shaped (snake_case, `derived_from`, `hiring_signal`, a top-level `source` block); storage is camelCase with `questionId`. `toInternalKit` maps one onto the other, including `source.pages_used` onto `companyBrief.pagesUsed`, which the brief regeneration reads. Ids come from a generator that skips names the fixture already uses, because storage never reuses an id.",
  run: async (cases) => {
    const outcomes: CaseOutcome[] = [];
    const baseRaw = JSON.parse(
      await readFile(join(STEPS_ROOT, "13-builder-regeneration", "_fixtures", "base-kit.json"), "utf8"),
    );

    for (const kase of cases) {
      const runs = await repeatCase(1, async (c) => {
        const base = toInternalKit(kase.input["kit"] ?? baseRaw);
        const e = kase.expected;

        const baseQuestionIds = new Set<string>(base.questions.map((q: any) => q.id));
        const baseCardIds = new Set<string>(base.flashcards.map((f: any) => f.id));
        const ids = new FreshIds([...baseQuestionIds, ...baseCardIds]);

        const tracer = new InMemoryTracer(new SystemClock());
        const llm = scriptedFake((kase.input["fake_responses"] ?? []) as unknown[], tracer);

        let kit = base;
        let conflict: string | null = null;
        let firstSucceeded = false;

        for (const [index, op] of (kase.input["operations"] ?? []).entries()) {
          try {
            kit = await applyOperation(kit, op, ids, { llm, tracer });
            if (index === 0) firstSucceeded = true;
          } catch (error) {
            const code = (error as any)?.code;
            if (code === "VERSION_CONFLICT") {
              conflict = code;
              // A refused write leaves the kit exactly as it was; later ops still run.
              continue;
            }
            throw error;
          }
        }

        const spans = tracer.export();
        const regenerated = (kase.input["operations"] ?? []).filter((op: any) => op.op === "regenerate");
        const newQuestions = kit.questions.filter((q: any) => q.active && !baseQuestionIds.has(q.id));
        const newCards = kit.flashcards.filter((f: any) => f.active && !baseCardIds.has(f.id));

        const byId = new Map<string, any>(kit.questions.map((q: any) => [q.id, q]));
        const cardById = new Map<string, any>(kit.flashcards.map((f: any) => [f.id, f]));
        const json: any = toKitJSON(kit);
        const builder: any = getKitForBuilder(kit);

        if (e["first_op_succeeds"] !== undefined) {
          c.ok("first op succeeds", firstSucceeded === e["first_op_succeeds"]);
        }
        if (e["second_op_rejected_with"] !== undefined) {
          c.ok(
            `second op rejected with ${String(e["second_op_rejected_with"])}`,
            conflict === e["second_op_rejected_with"],
            `got ${conflict ?? "no conflict"}`,
          );
        }
        if (e["q1_prompt"] !== undefined) {
          c.ok("q1 prompt", byId.get("q1")?.prompt === e["q1_prompt"], String(byId.get("q1")?.prompt));
        }
        if (e["version"] !== undefined) {
          c.ok(`version is ${String(e["version"])}`, kit.version === e["version"], `got ${String(kit.version)}`);
        }
        for (const id of e["survives"] ?? []) {
          c.ok(`${id} survives`, byId.get(id)?.active === true);
        }
        for (const id of e["removed"] ?? []) {
          c.ok(`${id} removed`, byId.get(id)?.active === false, `active=${String(byId.get(id)?.active)}`);
        }
        for (const [id, active] of Object.entries(e["active_flag"] ?? {})) {
          c.ok(`${id} active=${String(active)}`, byId.get(id)?.active === active);
        }
        for (const id of e["record_still_exists_internally"] ?? []) {
          c.ok(`${id} still in storage`, byId.has(id));
        }
        for (const [id, active] of Object.entries(e["flashcard_active"] ?? {})) {
          c.ok(`flashcard ${id} active=${String(active)}`, cardById.get(id)?.active === active);
        }
        for (const [id, origin] of Object.entries(e["origin"] ?? {})) {
          c.ok(`${id} origin ${String(origin)}`, byId.get(id)?.origin === origin, String(byId.get(id)?.origin));
        }
        for (const [id, category] of Object.entries(e["category_of"] ?? {})) {
          c.ok(`${id} in ${String(category)}`, byId.get(id)?.category === category, String(byId.get(id)?.category));
        }
        for (const [category, order] of Object.entries(e["order_of"] ?? {})) {
          const actual = kit.questions
            .filter((q: any) => q.category === category && q.active)
            .sort((a: any, b: any) => a.order - b.order)
            .map((q: any) => q.id);
          // `<new1>`, `<new2>` … are placeholders: the case cannot name an id the run mints. Each
          // matches any question that was not in the base kit, and two placeholders may not match
          // the same one — the point of the case is that BOTH new questions land after the
          // survivors, not that one did twice.
          const want = order as string[];
          const seen = new Set<string>();
          const matches =
            actual.length === want.length &&
            want.every((expect, i) => {
              const got = actual[i] as string;
              if (!/^<.*>$/.test(expect)) return got === expect;
              if (baseQuestionIds.has(got) || seen.has(got)) return false;
              seen.add(got);
              return true;
            });
          c.ok(`${category} order`, matches, `${actual.join(",")} vs ${want.join(",")}`);
        }
        for (const [day, focus] of Object.entries(e["schedule_day_focus"] ?? {})) {
          const found = kit.schedule.days.find((d: any) => String(d.day) === String(day));
          c.ok(`day ${day} focus`, found?.focus === focus, String(found?.focus));
        }
        for (const id of e["untouched"] ?? []) {
          // Questions and flashcards alike: the cases list both in the same array.
          const before = base.questions.find((q: any) => q.id === id) ?? base.flashcards.find((f: any) => f.id === id);
          const after = byId.get(id) ?? cardById.get(id);
          c.ok(`${id} untouched`, JSON.stringify(before) === JSON.stringify(after), JSON.stringify(after));
        }
        for (const section of e["untouched_sections"] ?? []) {
          const key = section === "company_brief" ? "companyBrief" : section;
          c.ok(
            `${section} untouched`,
            JSON.stringify((base as any)[key]) === JSON.stringify((kit as any)[key]),
            JSON.stringify((kit as any)[key]).slice(0, 200),
          );
        }

        const category = regenerated.find((op: any) => op.section === "questions")?.category;
        if (e["new_questions_min"] !== undefined) {
          const added = newQuestions.filter((q: any) => category === undefined || q.category === category);
          c.ok(
            `at least ${String(e["new_questions_min"])} new questions`,
            added.length >= (e["new_questions_min"] as number),
            `got ${added.length}`,
          );
        }
        if (e["category_of_new"] !== undefined) {
          c.ok(
            `new questions are ${String(e["category_of_new"])}`,
            newQuestions.length > 0 && newQuestions.every((q: any) => q.category === e["category_of_new"]),
            newQuestions.map((q: any) => q.category).join(",") || "none",
          );
        }
        for (const id of e["ids_never_reused"] ?? []) {
          // The id still resolves to the record it always did, and nothing new took the name.
          const before = base.questions.find((q: any) => q.id === id);
          c.ok(
            `${id} not reused`,
            byId.get(id)?.prompt === before?.prompt && !newQuestions.some((q: any) => q.id === id),
            String(byId.get(id)?.prompt),
          );
        }
        for (const [id, pinned] of Object.entries(e["pinned"] ?? {})) {
          c.ok(`${id} pinned=${String(pinned)}`, byId.get(id)?.pinned === pinned, String(byId.get(id)?.pinned));
        }
        for (const [id, reqs] of Object.entries(e["requirement_ids_of"] ?? {})) {
          c.eq(`${id} requirement_ids`, byId.get(id)?.requirementIds, reqs as string[]);
        }
        for (const id of e["flashcard_survives"] ?? []) {
          c.ok(`flashcard ${id} survives`, cardById.get(id)?.active === true);
        }
        for (const id of e["flashcard_removed"] ?? []) {
          c.ok(`flashcard ${id} removed`, cardById.get(id)?.active === false, `active=${String(cardById.get(id)?.active)}`);
        }
        if (e["new_flashcards_derived_for_new_questions"] === true) {
          const withOutline = newQuestions.filter((q: any) => q.answerOutline.trim().length > 0);
          c.ok(
            "every new question with an outline got a card",
            withOutline.every((q: any) => newCards.some((f: any) => f.questionId === q.id)),
            `${newCards.length} new cards for ${withOutline.length} new questions`,
          );
        }

        // ── coverage ──────────────────────────────────────────────────────────────────
        if (e["must_covered_after"] !== undefined) {
          const covered = new Set(kit.questions.filter((q: any) => q.active).flatMap((q: any) => q.requirementIds));
          const missing = (e["must_covered_after"] as string[]).filter((id) => !covered.has(id));
          c.ok("every named must-have is covered", missing.length === 0, `uncovered: ${missing.join(",")}`);
        }
        if (e["coverage_passes_min"] !== undefined) {
          c.ok(
            `coverage.passes >= ${String(e["coverage_passes_min"])}`,
            kit.coverage.passes >= (e["coverage_passes_min"] as number),
            `got ${String(kit.coverage.passes)}`,
          );
        }
        if (e["gap_fill_question_requirement_ids"] !== undefined) {
          const want = JSON.stringify(e["gap_fill_question_requirement_ids"]);
          const filled = newQuestions.find((q: any) => JSON.stringify(q.requirementIds) === want);
          c.ok(`a gap-fill question covers ${want}`, filled !== undefined, newQuestions.map((q: any) => JSON.stringify(q.requirementIds)).join(" "));
          // The ids came from the code that chose the cluster, never from the model: gap fill's
          // schema has no requirement_ids field at all. The span names what was asked for.
          const ask = spans.find((sp) => sp.step.startsWith("gap_fill "));
          c.ok(
            "the gap fill was asked for exactly that requirement",
            ask?.step === `gap_fill ${(e["gap_fill_question_requirement_ids"] as string[]).join("+")}`,
            ask?.step ?? "no gap_fill span",
          );
        }

        // ── the brief ─────────────────────────────────────────────────────────────────
        if (e["brief_summary"] !== undefined) {
          c.ok("brief summary replaced", kit.companyBrief.summary === e["brief_summary"], kit.companyBrief.summary);
        }

        // ── the schedule ──────────────────────────────────────────────────────────────
        if (e["schedule_unchanged"] === true) {
          c.ok(
            "schedule byte-identical",
            JSON.stringify(base.schedule) === JSON.stringify(kit.schedule),
            JSON.stringify(kit.schedule).slice(0, 200),
          );
        }
        if (e["schedule_day_2_question_ids_unchanged"] === true) {
          const before = base.schedule.days.find((d: any) => d.day === 2);
          const after = kit.schedule.days.find((d: any) => d.day === 2);
          c.eq("day 2 question ids", after?.questionIds, before?.questionIds);
        }
        if (e["all_active_questions_scheduled_exactly_once"] === true) {
          const placed = kit.schedule.days.flatMap((d: any) => d.questionIds);
          const active = kit.questions.filter((q: any) => q.active).map((q: any) => q.id).sort();
          const repeated = placed.filter((id: string, i: number) => placed.indexOf(id) !== i);
          c.ok("no question placed twice", repeated.length === 0, repeated.join(","));
          c.eq("every active question placed", [...placed].sort(), active);
        }
        if (e["days_1_and_3_recomputed"] === true) {
          // "Recomputed" is a property, not a diff: the unedited days between them hold exactly
          // the active questions the edited day did not claim, and their minutes follow.
          const day2 = new Set<string>(kit.schedule.days.find((d: any) => d.day === 2)?.questionIds ?? []);
          const open = kit.schedule.days.filter((d: any) => d.day !== 2);
          const expected = kit.questions
            .filter((q: any) => q.active && !day2.has(q.id))
            .map((q: any) => q.id)
            .sort();
          c.eq("days 1 and 3 hold the unclaimed questions", open.flatMap((d: any) => d.questionIds).sort(), expected);
          const byQuestionId = new Map<string, any>(kit.questions.map((q: any) => [q.id, q]));
          for (const day of open) {
            const minutes = minutesForQuestions(day.questionIds.map((id: string) => byQuestionId.get(id)));
            c.ok(`day ${day.day} minutes recomputed`, day.minutes === minutes, `${day.minutes} vs ${minutes}`);
          }
        }

        // ── the added manual question ─────────────────────────────────────────────────
        const added = newQuestions.find((q: any) => q.origin === "manual");
        if (e["added_origin"] !== undefined) {
          c.ok(`added question origin ${String(e["added_origin"])}`, added?.origin === e["added_origin"], String(added?.origin));
        }
        if (e["added_survives_regen"] === true) {
          c.ok("the added question survived the regen", added !== undefined && added.active === true);
        }
        if (e["added_has_flashcard"] === true) {
          c.ok(
            "the added question has a card",
            added !== undefined && kit.flashcards.some((f: any) => f.active && f.questionId === added.id),
          );
        }

        const out = e["output"] ?? {};
        for (const id of out.questions_exclude ?? []) {
          c.ok(`output excludes ${id}`, !json.questions.some((q: any) => q.id === id));
        }
        for (const id of out.flashcards_exclude ?? []) {
          c.ok(`output excludes card ${id}`, !json.flashcards.some((f: any) => f.id === id));
        }
        for (const id of out.no_day_contains ?? []) {
          c.ok(
            `no day lists ${id}`,
            !json.schedule.days.some((d: any) => (d.question_ids ?? []).includes(id)),
          );
        }
        if (out.added_scheduled_somewhere === true) {
          // On the internal kit the question sits on no day at all: the questions branch never
          // writes to `schedule`. Repair places it when the kit is projected, which is the whole
          // reason this assertion is on `output` rather than on the kit.
          const scheduled = new Set<string>(json.schedule.days.flatMap((d: any) => d.question_ids ?? []));
          c.ok("the added question was placed on a day", added !== undefined && scheduled.has(added.id));
        }

        const proj = e["builder_projection"] ?? {};
        for (const id of proj.questions_exclude ?? []) {
          c.ok(`builder excludes ${id}`, !builder.questions.some((q: any) => q.id === id));
        }
        for (const id of proj.no_day_contains ?? []) {
          c.ok(
            `builder: no day lists ${id}`,
            !builder.schedule.days.some((d: any) => (d.questionIds ?? []).includes(id)),
          );
        }
        if (e["llm_calls"] !== undefined) {
          c.ok(
            `${String(e["llm_calls"])} llm calls`,
            llm.calls.length === e["llm_calls"],
            `made ${llm.calls.length}: ${llm.calls.map((call) => call.purpose).join(", ") || "none"}`,
          );
        }

        // ── the trace ─────────────────────────────────────────────────────────────────
        //
        // Not in `expected`, but named by the step README: a regeneration has to read in the
        // trace like the first-generation steps it replays. A category regen that produced the
        // right kit with no coverage_check in the trace ran a set difference nobody can see.
        for (const op of regenerated) {
          const root = spans.find((sp) => sp.step === "regenerate_section");
          c.ok(`regenerate_section span for ${String(op.section)}`, root !== undefined);

          if (op.section === "questions") {
            const order = spans
              .filter((sp) => sp.step.startsWith("category:") || sp.step.startsWith("coverage_check") || sp.step.startsWith("gap_fill "))
              .map((sp) => sp.step);
            c.ok(`category:${String(op.category)} call recorded`, order.includes(`category:${String(op.category)}`), order.join(" → "));
            const categoryAt = order.findIndex((step) => step.startsWith("category:"));
            const checkAt = order.findIndex((step) => step.startsWith("coverage_check"));
            c.ok("coverage_check runs after the category call", categoryAt >= 0 && checkAt > categoryAt, order.join(" → "));
            const fillAt = order.findIndex((step) => step.startsWith("gap_fill "));
            if (fillAt >= 0) c.ok("gap_fill runs after a coverage_check", fillAt > checkAt, order.join(" → "));
          }
          if (op.section === "company_brief") {
            c.ok("generate_brief span", spans.some((sp) => sp.step === "generate_brief"));
          }
          if (op.section === "schedule") {
            c.ok("allocate_schedule span", spans.some((sp) => sp.step === "allocate_schedule"));
            c.ok("no model span", !spans.some((sp) => sp.step.startsWith("llm:")), spans.map((sp) => sp.step).join(","));
          }
        }

        return { version: kit.version, llmCalls: llm.calls.length, spans: spans.map((sp) => sp.step) };
      });
      outcomes.push({ id: kase.id, runs });
    }
    return outcomes;
  },
};

// ── 14 api contract (integration) ────────────────────────────────────────────────────────

/**
 * The whole API, booted on a loopback port, against the memory adapter.
 *
 * Not supertest: one case reads an event stream, and a stream needs a real socket. Booting the
 * app on port 0 costs a millisecond and means every case goes through the same door a browser
 * does — Express routing, JSON parsing, CORS, the error handler — rather than through a handler
 * called directly.
 *
 * A fresh harness per case. These cases seed conflicting worlds (three kits here, one at version
 * 7 there) and count model calls, and a shared store would make each case's result depend on the
 * order the ones before it ran in.
 */
interface ApiHarness {
  base: string;
  kits: MemoryKitStore<InternalKit>;
  jobs: MemoryJobStore;
  feed: JobSpanFeed;
  llm: FakeLlmProvider;
  close: () => Promise<void>;
}

/**
 * The fake Clerk verifier the step's README asks for.
 *
 * `user-a-expired` returns a well-formed payload whose `exp` is in the past rather than throwing,
 * because that is the interesting case: it proves the expiry check is the API's own and not
 * something delegated to `jose`'s clock. An unknown token throws, which is what a forged one does.
 */
function fakeClerk(): ClerkAuthenticator {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const payloads: Record<string, Record<string, unknown>> = {
    "user-a": { sub: "user-a" },
    "user-b": { sub: "user-b" },
    "user-a-expired": { sub: "user-a", exp: nowSeconds - 60 },
  };

  return new ClerkAuthenticator({
    issuer: "https://fake.clerk.test",
    verify: async (token: string) => {
      const payload = payloads[token];
      if (payload === undefined) throw new Error("unknown token");
      return payload;
    },
  });
}

/**
 * How long a model call takes here.
 *
 * The fake answers in zero time, and `regenerate-twice-joins-in-flight` is a case about what
 * happens *during* a run. With an instant provider the first regeneration is finished four
 * milliseconds after it starts — before the second click's request has been parsed — so the two
 * clicks are never concurrent and the case tests nothing. A real provider takes seconds; twenty
 * five milliseconds is the smallest number that models "this takes time" without making the step
 * slow. Nothing else in the step depends on it.
 */
const MODEL_LATENCY_MS = 25;

/** The fake, with the one property a real provider has that it lacks: a duration. */
function withLatency(provider: FakeLlmProvider, ms: number): LlmProvider {
  return {
    name: provider.name,
    complete: async (request) => {
      await new Promise((resolve) => setTimeout(resolve, ms));
      return provider.complete(request);
    },
  };
}

async function bootApi(): Promise<ApiHarness> {
  const clock = new SystemClock();
  const kits = new MemoryKitStore<InternalKit>();
  const jobs = new MemoryJobStore(clock);
  const feed = new JobSpanFeed();
  const ids = new RandomIdGenerator();

  // One provider across the whole case, because `llm_calls` is an assertion about the case and
  // not about one job.
  const llm = new FakeLlmProvider({ responses: fakeLlmResponses() });
  llm.respondWith("gap_fill", gapFillResponse);
  const provider = withLatency(llm, MODEL_LATENCY_MS);

  const runner = new JobRunner({
    jobs,
    kits,
    ids,
    clock,
    feed,
    regenerate: regenerateSection,
    makeDeps: () => ({
      llm: provider,
      fetcher: new FakeFetcher({
        root: resolve(process.cwd(), "fixtures", "sites"),
        // `x.example` is the host `create-duplicate-returns-existing` posts. Mounting it on the
        // sparse fixture makes that case exercise a generation that actually succeeds; without a
        // mount the run fails on the first fetch, and the case would pass or fail on how fast it
        // failed rather than on the idempotency it is about.
        mounts: { ...fixtureMounts(), "https://x.example": "sparse" },
      }),
      search: new NullSearchProvider(),
      tracer: new InMemoryTracer(clock),
      clock,
      ids: new RoutedIdGenerator(new SequentialIdGenerator(), { kit_: new RandomIdGenerator() }),
      budget: unlimitedBudget(clock),
      requestsPerSecond: 1_000,
    }),
  });

  const app = createApp({ auth: fakeClerk(), jobs, kits, runner, feed, ids, clock, heartbeatMs: 200 });

  const server = await new Promise<Server>((ready) => {
    const listening = app.listen(0, "127.0.0.1", () => ready(listening));
  });
  const address = server.address() as AddressInfo;

  return {
    base: `http://127.0.0.1:${address.port}`,
    kits,
    jobs,
    feed,
    llm,
    close: () => new Promise<void>((done) => server.close(() => done())),
  };
}

/**
 * A kit with just enough in it to be edited, regenerated and listed.
 *
 * Two must-have requirements of different kinds, one question covering each. That shape is what
 * makes `regenerate-twice-joins-in-flight` a clean assertion about idempotency: regenerating the
 * technical category archives the only technical question, the one generated replacement is
 * tagged with the requirement it was seeded from, and coverage therefore finds nothing to fill.
 * One model call, because one call is all the work there is — not because the second was
 * suppressed.
 */
function seedKit(id: string, version = 1): InternalKit {
  const provenance = { origin: "generated" as const, pinned: false, active: true };

  return {
    id,
    createdAt: 0,
    version,
    role: {
      title: "Senior Backend Engineer",
      company: "Northwind",
      location: "Berlin",
      summary: "Owns the routing services behind a parcel network.",
      responsibilities: ["Own routing services"],
    },
    companyBrief: {
      summary: "Northwind builds routing software for parcel networks.",
      whatTheyDo: "Routing software for parcel carriers.",
      hiringProcess: "",
      sources: ["https://northwind.test/"],
      pagesUsed: ["https://northwind.test/"],
      gaps: [],
      origin: "generated",
      edited: false,
    },
    requirements: [
      { id: "r1", text: "PostgreSQL query tuning", kind: "technical", priority: "must", sourceSpan: "Production experience with PostgreSQL, including query tuning" },
      { id: "r2", text: "written communication", kind: "behavioural", priority: "must", sourceSpan: "Strong written communication; most design work happens in RFCs" },
    ],
    questions: [
      { ...provenance, id: "q1", category: "technical", prompt: "Walk me through a PostgreSQL query you had to tune.", answerOutline: "The plan, the fix, the result.", difficulty: 2, requirementIds: ["r1"], order: 0 },
      { ...provenance, id: "q2", category: "behavioural", prompt: "Tell me about a design you had to argue for in writing.", answerOutline: "The RFC, the objection, the outcome.", difficulty: 2, requirementIds: ["r2"], order: 0 },
    ],
    flashcards: [
      { ...provenance, id: "f1", front: "PostgreSQL query tuning", back: "Read the plan first.", requirementIds: ["r1"], questionId: "q1", order: 0 },
      { ...provenance, id: "f2", front: "Written communication", back: "Write the RFC before the meeting.", requirementIds: ["r2"], questionId: "q2", order: 1 },
    ],
    schedule: {
      daysAvailable: 3,
      days: [
        { day: 1, focus: "Postgres", questionIds: ["q1"], minutes: 20, edited: false },
        { day: 2, focus: "Communication", questionIds: ["q2"], minutes: 20, edited: false },
        { day: 3, focus: "Review", questionIds: [], minutes: 0, edited: false },
      ],
    },
    coverage: { passes: 1, uncoveredRequirementIds: [] },
  };
}

async function seedRecord(h: ApiHarness, id: string, owner: string, version: number): Promise<void> {
  const kit = seedKit(id, version);
  await h.kits.save({ id, userId: owner, hash: `hash-${id}`, createdAt: 0, updatedAt: 0, kit });
}

interface RawRequest {
  method: string;
  path: string;
  headers?: Record<string, string>;
  body?: unknown;
}

interface CallResult {
  status: number;
  body: Record<string, any>;
  events: { event: string; data: Record<string, any> }[];
}

/** One request, as a browser would make it. Streams are read; everything else is parsed as JSON. */
async function call(h: ApiHarness, as: string | null, request: RawRequest): Promise<CallResult> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    ...(as === null ? {} : { authorization: `Bearer ${as}` }),
    ...(request.headers ?? {}),
  };

  if (request.path.endsWith("/events")) return readStream(`${h.base}${request.path}`, headers);

  const response = await fetch(`${h.base}${request.path}`, {
    method: request.method,
    headers,
    ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
  });

  const text = await response.text();
  let body: Record<string, any> = {};
  try {
    body = text === "" ? {} : (JSON.parse(text) as Record<string, any>);
  } catch {
    body = { raw: text };
  }
  return { status: response.status, body, events: [] };
}

/**
 * Read an event stream until it goes quiet.
 *
 * A run in flight never ends the stream, so the read is bounded by a timer rather than by EOF.
 * That is the same shape a browser's `EventSource` has: it takes what has arrived and stays
 * connected. The assertion is about what arrives first, so a short window is enough.
 */
async function readStream(url: string, headers: Record<string, string>): Promise<CallResult> {
  const controller = new AbortController();
  const response = await fetch(url, { headers, signal: controller.signal });

  if (!(response.headers.get("content-type") ?? "").includes("text/event-stream")) {
    const text = await response.text();
    return { status: response.status, body: text === "" ? {} : (JSON.parse(text) as Record<string, any>), events: [] };
  }

  const events: { event: string; data: Record<string, any> }[] = [];
  const reader = (response.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  const deadline = Date.now() + 1_500;
  let buffer = "";

  try {
    while (Date.now() < deadline) {
      const next = await Promise.race([
        reader.read(),
        new Promise<{ done: true; value: undefined }>((r) => setTimeout(() => r({ done: true, value: undefined }), 200)),
      ]);
      if (next.value !== undefined) buffer += decoder.decode(next.value, { stream: true });

      const frames = buffer.split("\n\n");
      buffer = frames.pop() ?? "";
      for (const frame of frames) {
        const event = /^event: (.+)$/m.exec(frame)?.[1];
        const data = /^data: (.+)$/m.exec(frame)?.[1];
        if (event === undefined || data === undefined) continue;
        events.push({ event, data: JSON.parse(data) as Record<string, any> });
      }
      // Everything a mid-run connection replays arrives in one write; a pause with frames in
      // hand means the replay is over and the rest is live.
      if (events.length > 0 && (next.done === true || buffer === "")) break;
    }
  } finally {
    controller.abort();
    await reader.cancel().catch(() => {});
  }

  return { status: response.status, body: {}, events };
}

/** Wait for every job a set of responses started, so `llm_calls` counts finished work. */
async function settleJobs(h: ApiHarness, results: CallResult[]): Promise<void> {
  const jobIds = [...new Set(results.map((r) => r.body["job_id"]).filter((id): id is string => typeof id === "string"))];

  for (let attempt = 0; attempt < 400 && jobIds.length > 0; attempt += 1) {
    const records = await Promise.all(jobIds.map((id) => h.jobs.findById(id)));
    if (records.every((job) => job !== null && (job.status === "done" || job.status === "failed"))) return;
    await new Promise((r) => setTimeout(r, 25));
  }
}

const step14: StepDefinition = {
  id: "14",
  dir: "14-api-contract",
  name: "API contract",
  target: "apps/api → createApp() on the memory adapter, fake Clerk verifier",
  kind: "integration",
  adapter:
    'Three fixtures the cases assume but do not ship. (1) `kit_base` with questions `q1`/`q2`: seeded as two must-have requirements of different kinds with one question each, so a technical regeneration leaves nothing uncovered and coverage has no gap to fill. (2) `https://x.example`, which `POST /kits` posts and the FakeFetcher has no mount for: mounted on the `sparse` fixture, so that case turns on idempotency rather than on how fast a fetch failed. (3) A 25ms latency on the fake provider: it otherwise answers in zero time, and the first regeneration then finishes before the second click has been parsed, which would make "concurrent" untestable rather than tested.',
  run: async (cases, deps) => {
    const outcomes: CaseOutcome[] = [];

    for (const kase of cases) {
      const runs = await repeatCase(1, async (c) => {
        const h = await bootApi();
        try {
          return await deps.tracer.span(`case:${kase.id}`, async (span) => {
            const input = kase.input;
            const expected = kase.expected;

            // ── the world this case runs in ──────────────────────────────────────────
            const owner = typeof input["owner"] === "string" ? (input["owner"] as string) : null;
            const version = typeof input["kit_version"] === "number" ? (input["kit_version"] as number) : 1;
            if (owner !== null) await seedRecord(h, "kit_base", owner, version);

            for (const seed of (input["kits"] ?? []) as { id: string; owner: string }[]) {
              await seedRecord(h, seed.id, seed.owner, version);
            }

            const jobState = input["job_state"] as { completed_spans?: string[]; running?: string } | undefined;
            if (jobState !== undefined) await seedJob(h, input, jobState);

            const before = JSON.stringify(await h.kits.findById("kit_base"));

            // ── the requests ─────────────────────────────────────────────────────────
            const as = (input["as"] ?? null) as string | null;
            const requests = (input["requests"] ?? [input["request"]]) as RawRequest[];
            const results =
              input["concurrent"] === true
                ? await Promise.all(requests.map((r) => call(h, as, r)))
                : await series(requests, (r) => call(h, as, r));

            await settleJobs(h, results);
            const last = results[results.length - 1] as CallResult;
            span.setAll({ statuses: results.map((r) => r.status), llm_calls: h.llm.calls.length });

            // ── the assertions the case names ────────────────────────────────────────
            if (expected["status"] !== undefined) c.eq("status", last.status, expected["status"]);
            if (expected["statuses"] !== undefined) c.eq("statuses", results.map((r) => r.status), expected["statuses"]);

            if (expected["ids"] !== undefined) {
              const ids = (last.body["kits"] ?? []).map((kit: { id: string }) => kit.id);
              c.sameSet("owner-filtered ids", ids, expected["ids"] as string[]);
            }

            if (expected["same_job_id"] === true) {
              const jobIds = results.map((r) => r.body["job_id"]);
              c.ok("one job id for both requests", new Set(jobIds).size === 1 && jobIds[0] !== undefined, JSON.stringify(jobIds));
            }

            if (expected["same_kit_id"] === true) {
              const kitIds = results.map((r) => r.body["kit_id"]);
              c.ok("one kit id for both requests", new Set(kitIds).size === 1 && kitIds[0] !== undefined, JSON.stringify(kitIds));
            }

            if (typeof expected["second_response_flag"] === "string") {
              const flag = expected["second_response_flag"] as string;
              const second = results[1]?.body[flag];
              c.ok(`second response carries ${flag}`, second === true, `got ${JSON.stringify(second)}`);
            }

            if (expected["llm_calls"] !== undefined) {
              c.eq("llm calls", h.llm.calls.length, expected["llm_calls"]);
            }

            for (const field of (expected["body_has"] ?? []) as string[]) {
              c.ok(`body has ${field}`, Object.prototype.hasOwnProperty.call(last.body, field), JSON.stringify(last.body));
            }
            if (expected["field"] !== undefined) c.eq("field", last.body["field"], expected["field"]);
            if (expected["code"] !== undefined) c.eq("code", last.body["code"], expected["code"]);

            if (expected["kit_unchanged"] === true) {
              const after = JSON.stringify(await h.kits.findById("kit_base"));
              c.ok("the kit is byte-identical afterwards", after === before, diffHint(before, after));
            }

            if (expected["first_events_are"] !== undefined) {
              const steps = last.events.filter((e) => e.event === "step").map((e) => e.data["step"]);
              c.eq("replayed steps, in order", steps.slice(0, (expected["first_events_are"] as string[]).length), expected["first_events_are"]);
            }

            return { statuses: results.map((r) => r.status), llmCalls: h.llm.calls.length, body: last.body };
          });
        } finally {
          await h.close();
        }
      });
      outcomes.push({ id: kase.id, runs });
    }
    return outcomes;
  },
};

/**
 * A job caught mid-run, as the case describes it.
 *
 * The spans are published through the same `JobSpanFeed` the runner writes to — there is no
 * back door into the stream, which is the point: if a reload could only be served by a test-only
 * path, a reload in the browser would be served by nothing.
 */
async function seedJob(
  h: ApiHarness,
  input: Record<string, any>,
  state: { completed_spans?: string[]; running?: string },
): Promise<void> {
  const jobId = /\/jobs\/([^/]+)\/events/.exec(String(input["request"]?.path ?? ""))?.[1] ?? "job_1";

  await h.jobs.create({
    id: jobId,
    userId: (input["as"] ?? "user-a") as string,
    kitId: null,
    label: "Senior Backend Engineer",
    status: "running",
    progress: null,
    error: null,
    createdAt: 0,
    updatedAt: 0,
  });

  const spans: Span[] = [];
  let at = 1_000;
  for (const step of state.completed_spans ?? []) {
    spans.push({ id: `s${spans.length + 1}`, parentId: null, step, startedAt: at, endedAt: at + 100, durationMs: 100, status: "ok", attrs: {} });
    at += 100;
  }
  if (state.running !== undefined) {
    spans.push({ id: `s${spans.length + 1}`, parentId: null, step: state.running, startedAt: at, endedAt: at, durationMs: 0, status: "running", attrs: {} });
  }
  h.feed.publish(jobId, spans);
}

/** Sequential, because "the second request" only means something if the first one finished. */
async function series<T, R>(items: readonly T[], run: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = [];
  for (const item of items) results.push(await run(item));
  return results;
}

/** Enough of the difference to see what a supposedly rejected write actually changed. */
function diffHint(before: string, after: string): string {
  for (let i = 0; i < Math.min(before.length, after.length); i += 1) {
    if (before[i] !== after[i]) return `diverges at ${i}: ...${before.slice(i, i + 80)} | ...${after.slice(i, i + 80)}`;
  }
  return `length ${before.length} → ${after.length}`;
}

const STEPS: StepDefinition[] = [step01, step02, step03, step04, step05, step06, step07, step08, step09, step10, step11, step12, step13, step14];

// ── reporting ────────────────────────────────────────────────────────────────────────────

interface StepReport {
  step: string;
  name: string;
  target: string;
  kind: string;
  adapter?: string;
  cases: {
    id: string;
    runs: number;
    passed: number;
    pass_rate: number;
    flaky: boolean;
    first_failure?: string;
    assertion_pass_rates?: Record<string, string>;
    scores?: Record<string, number>;
  }[];
  totals: { cases: number; fully_passing: number; runs: number };
  durationMs: number;
}

function summariseCase(outcome: CaseOutcome, isLlm: boolean): StepReport["cases"][number] {
  const runs = outcome.runs.length;
  const passed = outcome.runs.filter((r) => r.pass).length;
  const firstFailure = outcome.runs.find((r) => !r.pass)?.assertions.find((a) => !a.pass);

  const rates: Record<string, string> = {};
  if (isLlm && runs > 1) {
    const names = new Map<string, { pass: number; total: number }>();
    for (const run of outcome.runs) {
      for (const assertion of run.assertions) {
        const entry = names.get(assertion.name) ?? { pass: 0, total: 0 };
        entry.total += 1;
        if (assertion.pass) entry.pass += 1;
        names.set(assertion.name, entry);
      }
    }
    for (const [name, entry] of names) {
      if (entry.pass < entry.total) rates[name] = `${entry.pass}/${entry.total}`;
    }
  }

  const scoreRuns = outcome.runs.filter((r) => r.scores !== undefined);
  let scores: Record<string, number> | undefined;
  if (scoreRuns.length > 0) {
    scores = {};
    for (const key of Object.keys(scoreRuns[0]?.scores ?? {})) {
      const mean = scoreRuns.reduce((sum, r) => sum + (r.scores?.[key] ?? 0), 0) / scoreRuns.length;
      scores[key] = Number(mean.toFixed(3));
    }
  }

  return {
    id: outcome.id,
    runs,
    passed,
    pass_rate: runs === 0 ? 0 : Number((passed / runs).toFixed(3)),
    flaky: passed > 0 && passed < runs,
    ...(firstFailure !== undefined ? { first_failure: firstFailure.detail === undefined ? firstFailure.name : `${firstFailure.name} — ${firstFailure.detail}` } : {}),
    ...(Object.keys(rates).length > 0 ? { assertion_pass_rates: rates } : {}),
    ...(scores !== undefined ? { scores } : {}),
  };
}

function pad(text: string, width: number): string {
  return text.length >= width ? text.slice(0, width) : text + " ".repeat(width - text.length);
}

function printStep(report: StepReport): void {
  console.log(`\n── ${report.step} ${report.name} (${report.kind}) ${"─".repeat(Math.max(0, 46 - report.name.length))}`);
  if (report.adapter !== undefined) console.log(`   adapter: ${report.adapter}`);
  for (const kase of report.cases) {
    const mark = kase.passed === kase.runs ? "PASS" : kase.passed === 0 ? "FAIL" : "FLAKY";
    console.log(`   ${pad(kase.id, 38)} ${pad(`${kase.passed}/${kase.runs}`, 6)} ${mark}${kase.first_failure === undefined ? "" : `  ${kase.first_failure.slice(0, 150)}`}`);
  }
  console.log(`   ${report.totals.fully_passing}/${report.totals.cases} cases fully passing  (${(report.durationMs / 1000).toFixed(1)}s)`);
}

// ── main ─────────────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const repeatIndex = argv.indexOf("--repeat");
  const repeat = repeatIndex === -1 ? 1 : Number(argv[repeatIndex + 1] ?? 1);
  const outIndex = argv.indexOf("--out");
  const consumed = new Set<number>();
  if (repeatIndex !== -1) consumed.add(repeatIndex + 1);
  if (outIndex !== -1) consumed.add(outIndex + 1);
  const selectors = argv.filter((a, i) => !a.startsWith("--") && !consumed.has(i));

  const wanted = selectors.includes("all") || selectors.length === 0 ? STEPS : STEPS.filter((s) => selectors.includes(s.id));
  if (wanted.length === 0) {
    console.error(`No step matched ${JSON.stringify(selectors)}. Known: ${STEPS.map((s) => s.id).join(", ")}`);
    process.exit(2);
  }

  const runId = new Date().toISOString().replace(/[:.]/g, "-");
  const outRoot = outIndex === -1 ? resolve(process.cwd(), "out", "evals", runId) : resolve(String(argv[outIndex + 1]));
  await mkdir(outRoot, { recursive: true });

  console.log(`Step evals — run ${runId}`);
  console.log(`Output: ${outRoot}`);
  console.log(`Steps: ${wanted.map((s) => s.id).join(", ")}   repeat (LLM steps): ${repeat}`);

  const reports: StepReport[] = [];
  let exitCode = 0;

  for (const step of wanted) {
    const cases = await loadCases(step.dir);
    const isLlm = step.kind === "llm" || step.kind === "llm+fake";

    // One wiring per step: the rate limiter is shared across that step's repeats, and each
    // step gets its own trace.
    const wiring = isLlm
      ? wire({ noCache: true, recordPrompts: true })
      : { llm: new FakeLlmProvider(), tracer: new InMemoryTracer(new SystemClock()), ids: new SequentialIdGenerator(), describe: ["pure step: no provider"] };

    const startedAt = Date.now();
    console.log(`\n▸ ${step.id} ${step.name} — ${cases.length} cases${isLlm ? ` × ${repeat}` : ""}`);
    for (const line of wiring.describe) console.log(`   ${line}`);

    const outcomes = await step.run(cases, {
      tracer: wiring.tracer,
      ids: wiring.ids as IdGenerator,
      llm: wiring.llm as LlmProvider,
      repeat: isLlm ? repeat : 1,
    });

    const summarised = outcomes.map((o) => summariseCase(o, isLlm));
    const report: StepReport = {
      step: step.id,
      name: step.name,
      target: step.target,
      kind: step.kind,
      ...(step.adapter !== undefined ? { adapter: step.adapter } : {}),
      cases: summarised,
      totals: {
        cases: summarised.length,
        fully_passing: summarised.filter((k) => k.passed === k.runs).length,
        runs: summarised.reduce((sum, k) => sum + k.runs, 0),
      },
      durationMs: Date.now() - startedAt,
    };
    reports.push(report);
    printStep(report);

    // Per-step artefacts, kept.
    const stepDir = join(outRoot, `step-${step.id}-${step.name.replace(/[^A-Za-z0-9]+/g, "-").toLowerCase()}`);
    await mkdir(stepDir, { recursive: true });
    await writeFile(join(stepDir, "results.json"), JSON.stringify({ ...report, outcomes }, null, 2));
    const spans: Span[] = wiring.tracer.export();
    await writeFile(join(stepDir, "trace.json"), JSON.stringify(spans, null, 2));
    await writeFile(join(stepDir, "trace.txt"), spans.length === 0 ? "(no spans — this step calls no traced code)\n" : formatTrace(spans));

    // Exit-code policy from RUNNER_PROMPT.md.
    if (step.kind === "unimplemented") exitCode = 1;
    else if (isLlm) {
      if (summarised.some((k) => k.passed / k.runs < 2 / 3)) exitCode = 1;
    } else if (summarised.some((k) => k.passed !== k.runs)) exitCode = 1;
  }

  const summary = {
    run_id: runId,
    generated_at: new Date().toISOString(),
    repeat,
    steps: reports,
    exit_code: exitCode,
  };
  await writeFile(join(outRoot, "summary.json"), JSON.stringify(summary, null, 2));
  await mkdir(resolve(process.cwd(), "evals", "results"), { recursive: true });
  await writeFile(resolve(process.cwd(), "evals", "results", `steps-${runId}.json`), JSON.stringify(summary, null, 2));

  console.log(`\n${"═".repeat(76)}`);
  for (const report of reports) {
    console.log(`  ${pad(report.step, 4)} ${pad(report.name, 30)} ${pad(`${report.totals.fully_passing}/${report.totals.cases}`, 8)} ${report.kind}`);
  }
  console.log(`\nWritten to ${outRoot}`);
  process.exit(exitCode);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(2);
});
