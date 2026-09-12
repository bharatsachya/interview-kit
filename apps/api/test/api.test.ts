import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { resolve } from "node:path";
import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";
import { DevAuthenticator, ClerkAuthenticator } from "@trao/auth";
import type { Budget, JobStore, KitStore, LlmRequest } from "@trao/contracts";
import { InMemoryTracer, RandomIdGenerator, RoutedIdGenerator, SequentialIdGenerator, SystemClock } from "@trao/kernel";
import { validateKitJSON, type InternalKit } from "@trao/kit";
import { FakeLlmProvider, unlimitedBudget } from "@trao/llm";
import { MemoryJobStore, MemoryKitStore, MemoryPracticeStore } from "@trao/persistence";
import { regenerateSection } from "@trao/pipeline";
import { NullSearchProvider } from "@trao/research";
import { FakeFetcher, fixtureMounts } from "@trao/retrieval";
import { createApp } from "../src/app";
import { JobRunner } from "../src/jobs";
import { JobSpanFeed } from "../src/spans";
import { fakeLlmResponses, gapFillResponse } from "../../../fixtures/fake-llm-responses";

const clock = new SystemClock();
const FIXTURE_ROOT = resolve(process.cwd(), "fixtures", "sites");

const JD = `Senior Backend Engineer
Acme Payments — Berlin

Required:
- 5+ years building production services in Python
- Mentoring junior engineers

Nice to have:
- Kubernetes in production
`;

interface Harness {
  app: ReturnType<typeof createApp>;
  kits: KitStore<InternalKit>;
  jobs: JobStore;
  runner: JobRunner;
  feed: JobSpanFeed;
  ids: RandomIdGenerator;
  practice: MemoryPracticeStore;
}

/**
 * How long the fake takes to answer, in milliseconds.
 *
 * Zero for every test but one. The fake is instant, and a job that starts and finishes inside a
 * single millisecond leaves no window for a second request to arrive *during* — which is the
 * only thing the double-click test is about. Raising this models the one property a real
 * provider has that the fake does not.
 */
let modelLatencyMs = 0;

function harness(): Harness {
  const kits = new MemoryKitStore<InternalKit>();
  const jobs = new MemoryJobStore(clock);

  const makeDeps = () => {
    const fake = new FakeLlmProvider({ responses: fakeLlmResponses() });
    fake.respondWith("gap_fill", gapFillResponse);
    const budget: Budget = unlimitedBudget(clock);

    return {
      llm: {
        name: fake.name,
        complete: async <T,>(request: LlmRequest<T>) => {
          if (modelLatencyMs > 0) await new Promise((r) => setTimeout(r, modelLatencyMs));
          return fake.complete(request);
        },
      },
      fetcher: new FakeFetcher({ root: FIXTURE_ROOT, mounts: fixtureMounts() }),
      search: new NullSearchProvider(),
      tracer: new InMemoryTracer(clock),
      clock,
      ids: new RoutedIdGenerator(new SequentialIdGenerator(), { kit_: new RandomIdGenerator() }),
      budget,
      requestsPerSecond: 1_000,
    };
  };

  const feed = new JobSpanFeed();
  const ids = new RandomIdGenerator();
  const practice = new MemoryPracticeStore(clock);
  const runner = new JobRunner({ jobs, kits, ids, clock, makeDeps, feed, regenerate: regenerateSection });
  const app = createApp({ auth: new DevAuthenticator(), jobs, kits, practice, runner, feed, ids, clock, heartbeatMs: 50 });

  return { app, kits, jobs, runner, feed, ids, practice };
}

/** Poll the way the browser does, rather than reaching into the runner. */
async function waitForJob(h: Harness, jobId: string, user = "alice"): Promise<Record<string, unknown>> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const response = await request(h.app).get(`/jobs/${jobId}`).set("authorization", `Bearer ${user}`);
    const body = response.body as { job: { status: string } };
    if (body.job.status === "done" || body.job.status === "failed") return response.body as Record<string, unknown>;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("job never finished");
}

let h: Harness;
beforeEach(() => {
  modelLatencyMs = 0;
  h = harness();
});

describe("auth", () => {
  it("refuses an unauthenticated request", async () => {
    const app = createApp({
      auth: new ClerkAuthenticator({ issuer: "https://example.test", verify: async () => ({ sub: "x" }) }),
      jobs: h.jobs,
      kits: h.kits,
      practice: h.practice,
      runner: h.runner,
      feed: h.feed,
      ids: h.ids,
      clock,
    });

    const response = await request(app).get("/kits");
    expect(response.status).toBe(401);
    expect(response.body).toMatchObject({ code: "UNAUTHENTICATED" });
  });

  it("accepts a token the verifier accepts", async () => {
    const app = createApp({
      auth: new ClerkAuthenticator({ issuer: "https://example.test", verify: async () => ({ sub: "user_123" }) }),
      jobs: h.jobs,
      kits: h.kits,
      practice: h.practice,
      runner: h.runner,
      feed: h.feed,
      ids: h.ids,
      clock,
    });

    const response = await request(app).get("/kits").set("authorization", "Bearer anything");
    expect(response.status).toBe(200);
  });

  it("refuses a token the verifier rejects, without saying why", async () => {
    const app = createApp({
      auth: new ClerkAuthenticator({
        issuer: "https://example.test",
        verify: async () => {
          throw new Error("JWTExpired: exp claim timestamp check failed");
        },
      }),
      jobs: h.jobs,
      kits: h.kits,
      practice: h.practice,
      runner: h.runner,
      feed: h.feed,
      ids: h.ids,
      clock,
    });

    const response = await request(app).get("/kits").set("authorization", "Bearer stale");
    expect(response.status).toBe(401);
    // "expired" versus "bad signature" tells an attacker which half to work on.
    expect(JSON.stringify(response.body)).not.toContain("JWTExpired");
  });

  it("leaves the health check open, so a platform probe needs no token", async () => {
    const response = await request(h.app).get("/health");
    expect(response.status).toBe(200);
  });
});

describe("POST /kits", () => {
  it("returns a job id immediately rather than holding the request open", async () => {
    const response = await request(h.app)
      .post("/kits")
      .set("authorization", "Bearer alice")
      .send({ jd: JD, company_url: "https://meridian.test/", days: 5 });

    expect(response.status).toBe(202);
    expect((response.body as { job_ids: string[] }).job_ids).toHaveLength(1);
  });

  it("rejects a malformed role, naming the field that was wrong", async () => {
    const response = await request(h.app)
      .post("/kits")
      .set("authorization", "Bearer alice")
      .send({ jd: "", company_url: "not-a-url", days: 0 });

    // 400 and a named field, the same shape every write on the builder uses: a client with one
    // branch for validation failures is a client that can put the message next to the input.
    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ code: "INVALID_BODY" });
    expect((response.body as { field: string }).field).toMatch(/^(jd|company_url|days)$/);
  });

  it("runs the real pipeline through to a stored kit", async () => {
    const created = await request(h.app)
      .post("/kits")
      .set("authorization", "Bearer alice")
      .send({ jd: JD, company_url: "https://meridian.test/", days: 5 });

    const jobId = (created.body as { job_ids: string[] }).job_ids[0] as string;
    const view = (await waitForJob(h, jobId)) as { job: { status: string; kitId: string } };

    expect(view.job.status).toBe("done");
    expect(view.job.kitId).toBeTruthy();

    const kit = await request(h.app).get(`/kits/${view.job.kitId}`).set("authorization", "Bearer alice");
    expect(kit.status).toBe(200);
    expect((kit.body as { kit: InternalKit }).kit.questions.length).toBeGreaterThan(0);
    expect((kit.body as { kit: InternalKit }).kit.schedule.days).toHaveLength(5);
  });

  it("is idempotent — the same submission twice does not generate twice", async () => {
    const body = { jd: JD, company_url: "https://meridian.test/", days: 5 };

    const first = await request(h.app).post("/kits").set("authorization", "Bearer alice").send(body);
    const firstJob = (await waitForJob(h, (first.body as { job_ids: string[] }).job_ids[0] as string)) as {
      job: { kitId: string };
    };

    const second = await request(h.app).post("/kits").set("authorization", "Bearer alice").send(body);
    const secondJob = (await waitForJob(h, (second.body as { job_ids: string[] }).job_ids[0] as string)) as {
      job: { kitId: string; status: string };
    };

    expect(secondJob.job.status).toBe("done");
    expect(secondJob.job.kitId).toBe(firstJob.job.kitId);

    const list = await request(h.app).get("/kits").set("authorization", "Bearer alice");
    expect((list.body as { kits: unknown[] }).kits).toHaveLength(1);
  });
});

describe("POST /kits/batch", () => {
  it("starts one job per case, in input order", async () => {
    const response = await request(h.app)
      .post("/kits/batch")
      .set("authorization", "Bearer alice")
      .send({
        cases: [
          { id: "a", jd: JD, company_url: "https://meridian.test/", days: 3 },
          { id: "b", jd: JD.replace("Backend", "Platform"), company_url: "https://calder.test/", days: 7 },
        ],
      });

    expect(response.status).toBe(202);
    expect((response.body as { job_ids: string[] }).job_ids).toHaveLength(2);
  });

  it("rejects a malformed cases file with the offending field named", async () => {
    const response = await request(h.app)
      .post("/kits/batch")
      .set("authorization", "Bearer alice")
      .send({ cases: [{ id: "a", jd: JD, company_url: "https://x.test/", days: "five" }] });

    expect(response.status).toBe(422);
    expect((response.body as { message: string }).message).toContain("days");
  });
});

describe("progress", () => {
  it("reports real step names read from the trace", async () => {
    const created = await request(h.app)
      .post("/kits")
      .set("authorization", "Bearer alice")
      .send({ jd: JD, company_url: "https://meridian.test/", days: 5 });

    const jobId = (created.body as { job_ids: string[] }).job_ids[0] as string;
    await waitForJob(h, jobId);

    const view = await request(h.app).get(`/jobs/${jobId}`).set("authorization", "Bearer alice");
    const spans = (view.body as { spans: { step: string }[] }).spans;

    expect(spans.map((s) => s.step)).toContain("extract_requirements");
    expect(spans.map((s) => s.step)).toContain("allocate_schedule");
  });

  it("records a failed job with its error code", async () => {
    const created = await request(h.app)
      .post("/kits")
      .set("authorization", "Bearer alice")
      .send({ jd: JD, company_url: "https://gone.test/", days: 5 });

    const view = (await waitForJob(h, (created.body as { job_ids: string[] }).job_ids[0] as string)) as {
      job: { status: string; error: { code: string } };
    };

    expect(view.job.status).toBe("failed");
    expect(view.job.error.code).toBe("COMPANY_UNREACHABLE");
  });
});

describe("ownership", () => {
  it("does not let one user read another's kit", async () => {
    const created = await request(h.app)
      .post("/kits")
      .set("authorization", "Bearer alice")
      .send({ jd: JD, company_url: "https://meridian.test/", days: 5 });

    const view = (await waitForJob(h, (created.body as { job_ids: string[] }).job_ids[0] as string)) as {
      job: { kitId: string };
    };

    const asBob = await request(h.app).get(`/kits/${view.job.kitId}`).set("authorization", "Bearer bob");
    // 404 rather than 403: confirming it exists is itself a leak.
    expect(asBob.status).toBe(404);
  });

  it("does not let one user read another's job", async () => {
    const created = await request(h.app)
      .post("/kits")
      .set("authorization", "Bearer alice")
      .send({ jd: JD, company_url: "https://meridian.test/", days: 5 });

    const jobId = (created.body as { job_ids: string[] }).job_ids[0] as string;
    const asBob = await request(h.app).get(`/jobs/${jobId}`).set("authorization", "Bearer bob");

    expect(asBob.status).toBe(404);
  });

  it("lists only the caller's own kits", async () => {
    await request(h.app).post("/kits").set("authorization", "Bearer alice").send({ jd: JD, company_url: "https://meridian.test/", days: 5 });
    const created = await request(h.app)
      .post("/kits")
      .set("authorization", "Bearer bob")
      .send({ jd: JD.replace("Senior", "Staff"), company_url: "https://calder.test/", days: 2 });

    await waitForJob(h, (created.body as { job_ids: string[] }).job_ids[0] as string, "bob");

    const bobs = await request(h.app).get("/kits").set("authorization", "Bearer bob");
    expect((bobs.body as { kits: { id: string }[] }).kits).toHaveLength(1);
  });
});

describe("the builder projection", () => {
  it("serves active items with provenance flags intact", async () => {
    const created = await request(h.app)
      .post("/kits")
      .set("authorization", "Bearer alice")
      .send({ jd: JD, company_url: "https://meridian.test/", days: 5 });

    const view = (await waitForJob(h, (created.body as { job_ids: string[] }).job_ids[0] as string)) as {
      job: { kitId: string };
    };
    const response = await request(h.app).get(`/kits/${view.job.kitId}`).set("authorization", "Bearer alice");
    const kit = (response.body as { kit: InternalKit }).kit;

    expect(kit.questions.every((q) => q.active)).toBe(true);
    expect(kit.questions[0]).toHaveProperty("origin");
    expect(kit.questions[0]).toHaveProperty("pinned");
  });
});

describe("unknown routes", () => {
  it("answers with the same error shape as everything else", async () => {
    const response = await request(h.app).get("/nope").set("authorization", "Bearer alice");
    expect(response.status).toBe(404);
    expect(response.body).toMatchObject({ code: "NOT_FOUND" });
  });
});

/**
 * A small kit, written straight into the store.
 *
 * The builder tests are about routing, ownership, versions and error shapes, none of which get
 * more true for having run a ninety-step pipeline first. What each transition *does* to a kit is
 * tested in `packages/kit`, without an HTTP server in front of it.
 */
async function seed(owner = "alice", version = 1): Promise<InternalKit> {
  const flags = { origin: "generated" as const, pinned: false, active: true };
  const kit: InternalKit = {
    id: "kit_seed",
    createdAt: 0,
    version,
    role: { title: "Backend Engineer", company: "Northwind", location: "Berlin", summary: "Routing services.", responsibilities: [] },
    companyBrief: { summary: "Routing software.", whatTheyDo: "Routing.", hiringProcess: "", sources: [], pagesUsed: [], gaps: [], origin: "generated", edited: false },
    requirements: [{ id: "r1", text: "PostgreSQL query tuning", kind: "technical", priority: "must" }],
    questions: [
      { ...flags, id: "q1", category: "technical", prompt: "Tune this query.", answerOutline: "Read the plan.", difficulty: 2, requirementIds: ["r1"], order: 0 },
      { ...flags, id: "q2", category: "technical", prompt: "Index this table.", answerOutline: "Measure first.", difficulty: 1, requirementIds: ["r1"], order: 1 },
    ],
    flashcards: [{ ...flags, id: "f1", front: "Query plans", back: "Read them.", requirementIds: ["r1"], questionId: "q1", order: 0 }],
    schedule: { daysAvailable: 2, days: [{ day: 1, focus: "Postgres", questionIds: ["q1", "q2"], minutes: 30, edited: false }, { day: 2, focus: "Review", questionIds: [], minutes: 0, edited: false }] },
    coverage: { passes: 1, uncoveredRequirementIds: [] },
  };

  await h.kits.save({ id: kit.id, userId: owner, sessionId: "sess_seed", hash: "hash_seed", createdAt: 0, updatedAt: 0, kit });
  return kit;
}

const alice = (): [string, string] => ["authorization", "Bearer alice"];

/** Send a rewrite of the seeded kit, wait for it, and hand back the id of the fork it made. */
async function rewrite(body: Record<string, unknown>, from = "kit_seed"): Promise<string> {
  const started = await request(h.app).post(`/kits/${from}/regenerate`).set(...alice()).send(body);
  expect(started.status).toBe(202);
  const { job_id: jobId, kit_id: kitId } = started.body as { job_id: string; kit_id: string };
  const finished = (await waitForJob(h, jobId)) as { job: { status: string; kitId: string } };
  // The id is promised before a model is called, and the job has to land on that exact id —
  // otherwise the browser has been told where to look and the answer is somewhere else.
  expect(finished.job.status).toBe("done");
  expect(finished.job.kitId).toBe(kitId);
  return kitId;
}

describe("the builder", () => {
  it("answers every write with the projection and the new version in an ETag", async () => {
    await seed();
    const response = await request(h.app)
      .patch("/kits/kit_seed/questions/q1")
      .set(...alice())
      .set("If-Match", '"1"')
      .send({ prompt: "Tune this query, and say how you knew it worked." });

    expect(response.status).toBe(200);
    expect(response.headers["etag"]).toBe('"2"');
    const kit = (response.body as { kit: InternalKit }).kit;
    expect(kit.questions.find((q) => q.id === "q1")?.origin).toBe("edited");
  });

  it("refuses a write carrying a version the kit has moved past", async () => {
    await seed("alice", 7);
    const response = await request(h.app).patch("/kits/kit_seed/brief").set(...alice()).set("If-Match", '"5"').send({ summary: "Stale." });

    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({ code: "VERSION_CONFLICT", current_version: 7 });
    expect((await h.kits.findById("kit_seed"))?.kit.companyBrief.summary).toBe("Routing software.");
  });

  it("accepts a write with no If-Match at all — a caller with no opinion is not a conflict", async () => {
    await seed();
    const response = await request(h.app).patch("/kits/kit_seed/brief").set(...alice()).send({ summary: "Rewritten by hand." });

    expect(response.status).toBe(200);
    expect(response.headers["etag"]).toBe('"2"');
  });

  it("refuses a malformed If-Match rather than treating it as no opinion", async () => {
    await seed();
    const response = await request(h.app).patch("/kits/kit_seed/brief").set(...alice()).set("If-Match", "banana").send({ summary: "x" });

    expect(response.status).toBe(409);
  });

  it("names the field a body got wrong", async () => {
    await seed();
    const response = await request(h.app).patch("/kits/kit_seed/questions/q1").set(...alice()).send({ difficulty: 9 });

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ code: "INVALID_BODY", field: "difficulty" });
    expect((response.body as { message: string }).message).toBeTypeOf("string");
  });

  it("rejects a field the route does not accept instead of ignoring it", async () => {
    await seed();
    // Retagging a question by hand would close a coverage gap by relabelling rather than by
    // answering it. `QuestionPatch` has no `requirementIds`, so this must fail loudly.
    const response = await request(h.app).patch("/kits/kit_seed/questions/q1").set(...alice()).send({ requirement_ids: ["r1", "r9"] });

    expect(response.status).toBe(400);
  });

  it("moves a question between categories and reorders within one", async () => {
    await seed();
    const moved = await request(h.app).post("/kits/kit_seed/questions/q2/move").set(...alice()).send({ to_category: "system-design" });
    expect(moved.status).toBe(200);
    expect((moved.body as { kit: InternalKit }).kit.questions.find((q) => q.id === "q2")?.category).toBe("system-design");

    const reordered = await request(h.app).post("/kits/kit_seed/questions/reorder").set(...alice()).send({ category: "technical", ids: ["q1"] });
    expect(reordered.status).toBe(200);
  });

  it("adds a question by hand, with a card, and marks it manual", async () => {
    await seed();
    const response = await request(h.app)
      .post("/kits/kit_seed/questions")
      .set(...alice())
      .send({ category: "behavioural", prompt: "Tell me about an RFC you had to defend.", answer_outline: "Mine." });

    expect(response.status).toBe(200);
    const kit = (response.body as { kit: InternalKit }).kit;
    const added = kit.questions.find((q) => q.prompt.startsWith("Tell me about an RFC"));
    expect(added?.origin).toBe("manual");
    expect(kit.flashcards.some((f) => f.questionId === added?.id)).toBe(true);
  });

  it("deletes a question out of both projections and off its day", async () => {
    await seed();
    const response = await request(h.app).delete("/kits/kit_seed/questions/q1").set(...alice()).send();

    expect(response.status).toBe(200);
    const kit = (response.body as { kit: InternalKit }).kit;
    expect(kit.questions.some((q) => q.id === "q1")).toBe(false);
    expect(kit.schedule.days.flatMap((d) => d.questionIds)).not.toContain("q1");
    // Soft, not gone: the record survives so its id can never be handed out again.
    expect((await h.kits.findById("kit_seed"))?.kit.questions.find((q) => q.id === "q1")?.active).toBe(false);
  });

  it("pins a question, and edits and deletes flashcards", async () => {
    await seed();
    expect((await request(h.app).post("/kits/kit_seed/questions/q1/pin").set(...alice()).send({})).status).toBe(200);
    expect((await request(h.app).patch("/kits/kit_seed/flashcards/f1").set(...alice()).send({ back: "Always." })).status).toBe(200);
    expect((await request(h.app).delete("/kits/kit_seed/flashcards/f1").set(...alice()).send()).status).toBe(200);
    expect((await request(h.app).post("/kits/kit_seed/flashcards").set(...alice()).send({ front: "Mine", back: "Also mine" })).status).toBe(200);
  });

  it("marks a day the user rewrote as edited, so allocation steps around it", async () => {
    await seed();
    const response = await request(h.app).patch("/kits/kit_seed/schedule/days/1").set(...alice()).send({ focus: "I renamed this day" });

    expect(response.status).toBe(200);
    const day = (response.body as { kit: InternalKit }).kit.schedule.days.find((d) => d.day === 1);
    expect(day).toMatchObject({ focus: "I renamed this day", edited: true });
  });

  it("404s an item the kit does not have, and a day that is not in the schedule", async () => {
    await seed();
    expect((await request(h.app).patch("/kits/kit_seed/questions/q99").set(...alice()).send({ prompt: "x" })).status).toBe(404);
    expect((await request(h.app).patch("/kits/kit_seed/flashcards/f99").set(...alice()).send({ back: "x" })).status).toBe(404);
    expect((await request(h.app).patch("/kits/kit_seed/schedule/days/9").set(...alice()).send({ focus: "x" })).status).toBe(404);
  });

  it("shows a stranger a 404 rather than confirming the kit exists", async () => {
    await seed("alice");
    for (const path of ["/kits/kit_seed", "/kits/kit_seed/export"]) {
      expect((await request(h.app).get(path).set("authorization", "Bearer bob")).status).toBe(404);
    }
    const write = await request(h.app).patch("/kits/kit_seed/questions/q1").set("authorization", "Bearer bob").send({ prompt: "hijacked" });
    expect(write.status).toBe(404);
    expect((await h.kits.findById("kit_seed"))?.kit.questions[0]?.prompt).toBe("Tune this query.");
  });

  it("exports Appendix A, with no internal fields on it", async () => {
    await seed();
    const response = await request(h.app).get("/kits/kit_seed/export").set(...alice());

    expect(response.status).toBe(200);
    expect(validateKitJSON(response.body).ok).toBe(true);
    expect(JSON.stringify(response.body)).not.toContain('"pinned"');
    expect(response.headers["content-disposition"]).toContain("kit-kit_seed.json");
  });

  it("runs a regeneration once, however many times the button is clicked", async () => {
    await seed();
    // The two clicks have to land while the first run is still going; see `modelLatencyMs`.
    modelLatencyMs = 100;
    const [first, second] = await Promise.all([
      request(h.app).post("/kits/kit_seed/regenerate").set(...alice()).send({ section: "questions", category: "technical" }),
      request(h.app).post("/kits/kit_seed/regenerate").set(...alice()).send({ section: "questions", category: "technical" }),
    ]);

    expect([first.status, second.status]).toEqual([202, 202]);
    expect((first.body as { job_id: string }).job_id).toBe((second.body as { job_id: string }).job_id);
    expect((second.body as { existing: boolean }).existing).toBe(true);
  });

  it("gives a regenerated question an id the kit has never used", async () => {
    await seed();
    const forkId = await rewrite({ section: "questions", category: "technical" });

    const stored = (await h.kits.findById(forkId)) as { kit: InternalKit };
    const ids = stored.kit.questions.map((q) => q.id);

    // Soft delete rests entirely on ids never being reused: two records sharing one id leaves a
    // schedule day unable to say which of them it meant. Two things hold that here, and this
    // asserts the outcome rather than either of them — the runner hands the regenerator its own
    // durable generator rather than the per-run sequential one, whose counter restarts at q1 on
    // every job, and `regenerateSection` skips any name the kit already holds regardless.
    expect(new Set(ids).size).toBe(ids.length);
    expect(stored.kit.questions.find((q) => q.id === "q1")?.active).toBe(false);
    expect(stored.kit.questions.some((q) => q.active && q.category === "technical")).toBe(true);
  });

  it("writes the rewrite into a new kit and leaves the original untouched", async () => {
    const before = await seed();
    const forkId = await rewrite({ section: "questions", category: "technical" });

    expect(forkId).not.toBe("kit_seed");

    // The whole promise of forking, asserted on the document rather than on the response: the
    // kit the user pressed the button on is the same bytes it was, on the same version, with
    // q1 still active. Anything they were editing is still editable, and still there.
    const parent = (await h.kits.findById("kit_seed")) as { kit: InternalKit; hash: string };
    expect(parent.kit).toEqual(before);

    const fork = (await h.kits.findById(forkId)) as { kit: InternalKit; hash: string };
    // A new document starts its own version count — two kits both claiming version 8 is how an
    // `If-Match` written against one of them silently passes against the other.
    expect(fork.kit.version).toBe(1);
    expect(fork.kit.revision).toBe(2);
    // Not the parent's hash. `findByHash` is what recognises a resubmitted posting as already
    // generated, and a fork answering to it would hand back the rewrite rather than the kit the
    // posting actually produced.
    expect(fork.hash).not.toBe(parent.hash);
  });

  it("records on the fork what the rewrite was asked to do", async () => {
    await seed();
    const forkId = await rewrite({ section: "questions", category: "technical", instructions: "Harder, and more about replication." });

    const fork = (await h.kits.findById(forkId)) as { kit: InternalKit };
    expect(fork.kit.forkedFrom).toMatchObject({
      fromKitId: "kit_seed",
      section: "questions",
      category: "technical",
      instructions: "Harder, and more about replication.",
    });

    // Listed as its own row, with the number the rail labels it by. Without this a company with
    // four rewrites is four identical rows.
    const list = await request(h.app).get("/kits").set(...alice());
    const kits = (list.body as { kits: { id: string; revision: number }[] }).kits;
    expect(kits.map((entry) => entry.id).sort()).toEqual([forkId, "kit_seed"].sort());
    expect(kits.find((entry) => entry.id === forkId)?.revision).toBe(2);
  });

  it("treats a rewrite asked for in different words as a different run", async () => {
    await seed();
    modelLatencyMs = 100;
    const [first, second] = await Promise.all([
      request(h.app).post("/kits/kit_seed/regenerate").set(...alice()).send({ section: "questions", category: "technical", instructions: "Harder." }),
      request(h.app).post("/kits/kit_seed/regenerate").set(...alice()).send({ section: "questions", category: "technical", instructions: "Easier." }),
    ]);

    // Deduplicating these would not be saving a model call, it would be refusing the second
    // request and answering it with someone else's answer.
    expect((first.body as { job_id: string }).job_id).not.toBe((second.body as { job_id: string }).job_id);
    expect((first.body as { kit_id: string }).kit_id).not.toBe((second.body as { kit_id: string }).kit_id);
  });

  it("puts a rewrite in the conversation the kit it forked from is already in", async () => {
    await seed();
    const started = await request(h.app)
      .post("/kits/kit_seed/regenerate")
      .set(...alice())
      .send({ section: "company_brief", instructions: "Say more about who they sell to." });

    expect((started.body as { session_id: string }).session_id).toBe("sess_seed");
    await waitForJob(h, (started.body as { job_id: string }).job_id);

    const list = await request(h.app).get("/sessions").set(...alice());
    const sessions = (list.body as { sessions: { id: string; kits: unknown[] }[] }).sessions;

    // One conversation holding both revisions, not two holding one each.
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.id).toBe("sess_seed");
    expect(sessions[0]?.kits).toHaveLength(2);
  });

  it("keeps the sentence the user typed, so a reload does not lose it", async () => {
    await seed();
    const started = await request(h.app)
      .post("/kits/kit_seed/regenerate")
      .set(...alice())
      .send({ section: "questions", category: "technical", instructions: "Go harder on replication." });
    await waitForJob(h, (started.body as { job_id: string }).job_id);

    const view = await request(h.app).get("/sessions/sess_seed").set(...alice());
    const turns = (view.body as { turns: { ask: Record<string, unknown> | null }[] }).turns;

    // The ask used to live in React state on the workspace, so a refresh returned the run and
    // its trace and lost what had actually been asked for.
    expect(turns.at(-1)?.ask).toEqual({
      kind: "rewrite",
      section: "questions",
      category: "technical",
      prompt: "Go harder on replication.",
    });
  });

  it("refuses an instruction longer than the prompt will carry", async () => {
    await seed();
    const response = await request(h.app)
      .post("/kits/kit_seed/regenerate")
      .set(...alice())
      .send({ section: "company_brief", instructions: "x".repeat(601) });
    // Refused at the edge rather than silently truncated three packages later.
    expect(response.status).toBe(400);
  });

  it("refuses a regeneration of questions with no category, and a category on the others", async () => {
    await seed();
    expect((await request(h.app).post("/kits/kit_seed/regenerate").set(...alice()).send({ section: "questions" })).status).toBe(400);
    expect(
      (await request(h.app).post("/kits/kit_seed/regenerate").set(...alice()).send({ section: "schedule", category: "technical" })).status,
    ).toBe(400);
    expect((await request(h.app).post("/kits/kit_seed/regenerate").set(...alice()).send({ section: "schedule" })).status).toBe(202);
  });
});

/** Open the stream on a real port, take what has arrived, and hang up. */
async function readStream(path: string, user: string): Promise<string> {
  const server = await new Promise<Server>((ready) => {
    const listening = h.app.listen(0, "127.0.0.1", () => ready(listening));
  });
  const port = (server.address() as AddressInfo).port;
  const controller = new AbortController();

  try {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      headers: { authorization: `Bearer ${user}` },
      signal: controller.signal,
    });
    const reader = (response.body as ReadableStream<Uint8Array>).getReader();
    const chunk = await Promise.race([
      reader.read(),
      new Promise<{ value: undefined }>((r) => setTimeout(() => r({ value: undefined }), 500)),
    ]);
    await reader.cancel().catch(() => {});
    return chunk.value === undefined ? "" : new TextDecoder().decode(chunk.value);
  } finally {
    controller.abort();
    await new Promise<void>((done) => server.close(() => done()));
  }
}

describe("the event stream", () => {
  it("replays the steps a job has already finished before streaming live ones", async () => {
    await h.jobs.create({
      id: "job_watch",
      userId: "alice",
      sessionId: null,
      kitId: null,
      label: "Backend Engineer",
      status: "running",
      progress: null,
      request: null,
      error: null,
      createdAt: 0,
      updatedAt: 0,
    });
    h.feed.publish("job_watch", [
      { id: "s1", parentId: null, step: "extract_requirements", startedAt: 1, endedAt: 2, durationMs: 1, status: "ok", attrs: {} },
      { id: "s2", parentId: null, step: "fetch_homepage", startedAt: 2, endedAt: 3, durationMs: 1, status: "ok", attrs: {} },
      { id: "s3", parentId: null, step: "crawl_site", startedAt: 3, endedAt: 3, durationMs: 0, status: "running", attrs: {} },
    ]);

    // A page reloaded mid-run must be told what it missed, not handed an empty stream. Read
    // through a real socket rather than through supertest: a stream that never ends has no
    // response to buffer, and the assertion is about what arrives first.
    const text = await readStream("/jobs/job_watch/events", "alice");

    expect(text).toContain("extract_requirements");
    expect(text.indexOf("extract_requirements")).toBeLessThan(text.indexOf("fetch_homepage"));
    expect(text).toContain("crawl_site");
  });

  it("shows a stranger a 404 rather than another user's trace", async () => {
    await h.jobs.create({ id: "job_watch", userId: "alice", sessionId: null, kitId: null, label: "x", status: "running", progress: null, request: null, error: null, createdAt: 0, updatedAt: 0 });
    const response = await request(h.app).get("/jobs/job_watch/events").set("authorization", "Bearer bob");
    expect(response.status).toBe(404);
  });
});

describe("retrying a failed run", () => {
  it("starts a new run from the posting the failed one stored", async () => {
    await h.jobs.create({
      id: "job_dead", userId: "alice", sessionId: null, kitId: null, label: "Acme", status: "failed",
      progress: null, request: { kind: "posting" as const, jd: "Senior Backend Engineer at Acme", companyUrl: "http://127.0.0.1:8099/acme/", days: 5 },
      error: { code: "TIMEOUT", message: "timed out" }, createdAt: 0, updatedAt: 0,
    });

    const response = await request(h.app).post("/jobs/job_dead/retry").set("authorization", "Bearer alice");

    expect(response.status).toBe(202);
    const startedId = (response.body as { job_ids: string[] }).job_ids[0] as string;
    // A new run, not a reset of the old one — the failure stays in the history rail.
    expect(startedId).not.toBe("job_dead");
    expect((await h.jobs.findById("job_dead"))?.status).toBe("failed");
  });

  it("survives a record written before the posting was stored at all", async () => {
    // Not the same as `request: null`. A document from before the field existed comes back with
    // it missing, and `undefined` walks through a `=== null` guard — which is how this returned
    // a 500 in production instead of a 404, on the very runs a user would most want to retry.
    const ancient = {
      id: "job_ancient", userId: "alice", sessionId: null, kitId: null, label: "x", status: "failed" as const,
      progress: null, error: { code: "INTERNAL", message: "x" }, createdAt: 0, updatedAt: 0,
    };
    await h.jobs.create(ancient as unknown as Parameters<typeof h.jobs.create>[0]);

    const response = await request(h.app).post("/jobs/job_ancient/retry").set("authorization", "Bearer alice");
    expect(response.status).toBe(404);

    // And it must not be advertised as retryable, or the button reappears and 404s on click.
    const list = await request(h.app).get("/jobs").set("authorization", "Bearer alice");
    const row = (list.body as { jobs: { id: string; retryable: boolean }[] }).jobs.find((j) => j.id === "job_ancient");
    expect(row?.retryable).toBe(false);
  });

  it("refuses a run that stored no posting, rather than starting an empty one", async () => {
    await h.jobs.create({
      id: "job_old", userId: "alice", sessionId: null, kitId: null, label: "x", status: "failed",
      progress: null, request: null, error: { code: "INTERNAL", message: "x" }, createdAt: 0, updatedAt: 0,
    });

    const response = await request(h.app).post("/jobs/job_old/retry").set("authorization", "Bearer alice");
    expect(response.status).toBe(404);
  });

  it("refuses to retry a run that did not fail", async () => {
    await h.jobs.create({
      id: "job_fine", userId: "alice", sessionId: null, kitId: "kit_1", label: "x", status: "done",
      progress: null, request: { kind: "posting" as const, jd: "x", companyUrl: "http://127.0.0.1:8099/acme/", days: 3 },
      error: null, createdAt: 0, updatedAt: 0,
    });

    const response = await request(h.app).post("/jobs/job_fine/retry").set("authorization", "Bearer alice");
    expect(response.status).toBe(404);
  });

  it("shows a stranger a 404 rather than retrying someone else's run", async () => {
    await h.jobs.create({
      id: "job_hers", userId: "alice", sessionId: null, kitId: null, label: "x", status: "failed",
      progress: null, request: { kind: "posting" as const, jd: "x", companyUrl: "http://127.0.0.1:8099/acme/", days: 3 },
      error: { code: "INTERNAL", message: "x" }, createdAt: 0, updatedAt: 0,
    });

    const response = await request(h.app).post("/jobs/job_hers/retry").set("authorization", "Bearer bob");
    expect(response.status).toBe(404);
  });

  it("tells the list which runs can be retried and which cannot", async () => {
    await h.jobs.create({
      id: "job_a", userId: "carol", sessionId: null, kitId: null, label: "x", status: "failed",
      progress: null, request: { kind: "posting" as const, jd: "x", companyUrl: "http://127.0.0.1:8099/acme/", days: 3 },
      error: { code: "INTERNAL", message: "x" }, createdAt: 1, updatedAt: 1,
    });
    await h.jobs.create({
      id: "job_b", userId: "carol", sessionId: null, kitId: null, label: "x", status: "failed",
      progress: null, request: null, error: { code: "INTERNAL", message: "x" }, createdAt: 2, updatedAt: 2,
    });

    const response = await request(h.app).get("/jobs").set("authorization", "Bearer carol");
    const byId = new Map((response.body as { jobs: { id: string; retryable: boolean }[] }).jobs.map((j) => [j.id, j.retryable]));

    expect(byId.get("job_a")).toBe(true);
    expect(byId.get("job_b")).toBe(false);
  });

  it("keeps the posting server-side rather than shipping it back on every poll", async () => {
    await h.jobs.create({
      id: "job_poll", userId: "alice", sessionId: null, kitId: null, label: "x", status: "failed",
      progress: null, request: { kind: "posting" as const, jd: "a very long posting".repeat(50), companyUrl: "http://127.0.0.1:8099/acme/", days: 3 },
      error: { code: "INTERNAL", message: "x" }, createdAt: 0, updatedAt: 0,
    });

    const response = await request(h.app).get("/jobs/job_poll").set("authorization", "Bearer alice");

    expect(response.status).toBe(200);
    expect((response.body as { job: Record<string, unknown> }).job["request"]).toBeUndefined();
    expect((response.body as { job: { retryable: boolean } }).job.retryable).toBe(true);
  });
});

describe("practice", () => {
  it("deals a fresh deck in stored order and reports nothing covered", async () => {
    await seed();
    const response = await request(h.app).get("/kits/kit_seed/practice").set(...alice());

    expect(response.status).toBe(200);
    const body = response.body as { session_id: string; deck: string[]; summary: Record<string, number> };
    expect(body.session_id).toMatch(/^practice_/);
    expect(body.deck).toEqual(["f1"]);
    expect(body.summary).toMatchObject({ total: 1, covered: 0, not_covered: 1 });
  });

  it("records a rating and reports it as covered on the next read", async () => {
    await seed();
    const opened = (await request(h.app).get("/kits/kit_seed/practice").set(...alice())).body as { session_id: string };

    const rated = await request(h.app)
      .post("/kits/kit_seed/practice")
      .set(...alice())
      .send({ session_id: opened.session_id, flashcard_id: "f1", confidence: "shaky" });

    expect(rated.status).toBe(200);
    expect((rated.body as { summary: Record<string, number> }).summary).toMatchObject({ covered: 1, shaky: 1 });

    // The point of the collection: a reload is a new session and the history is still there.
    const reopened = await request(h.app).get("/kits/kit_seed/practice").set(...alice());
    expect((reopened.body as { summary: Record<string, number> }).summary).toMatchObject({ covered: 1, shaky: 1 });
    expect((reopened.body as { standings: { confidence: string }[] }).standings[0]?.confidence).toBe("shaky");
  });

  it("orders the next deck by lowest confidence", async () => {
    await seed();
    // A second card, so there is an order to get wrong.
    await request(h.app).post("/kits/kit_seed/flashcards").set(...alice()).send({ front: "Second", back: "Card" });
    const opened = (await request(h.app).get("/kits/kit_seed/practice").set(...alice())).body as {
      session_id: string;
      deck: string[];
    };
    expect(opened.deck[0]).toBe("f1");

    await request(h.app)
      .post("/kits/kit_seed/practice")
      .set(...alice())
      .send({ session_id: opened.session_id, flashcard_id: "f1", confidence: "known" });

    const next = (await request(h.app).get("/kits/kit_seed/practice").set(...alice())).body as { deck: string[] };
    // f1 is known, the other has never been dealt — so the untouched one leads now.
    expect(next.deck[next.deck.length - 1]).toBe("f1");
  });

  it("keeps one user's ratings out of another's deck", async () => {
    await seed("alice");
    const opened = (await request(h.app).get("/kits/kit_seed/practice").set(...alice())).body as { session_id: string };
    await request(h.app)
      .post("/kits/kit_seed/practice")
      .set(...alice())
      .send({ session_id: opened.session_id, flashcard_id: "f1", confidence: "known" });

    expect((await request(h.app).get("/kits/kit_seed/practice").set("authorization", "Bearer bob")).status).toBe(404);
    const asBob = await request(h.app)
      .post("/kits/kit_seed/practice")
      .set("authorization", "Bearer bob")
      .send({ session_id: "practice_bob", flashcard_id: "f1", confidence: "known" });
    expect(asBob.status).toBe(404);
  });

  it("refuses a rating for a card the deck does not have, and a confidence off the scale", async () => {
    await seed();
    const missing = await request(h.app)
      .post("/kits/kit_seed/practice")
      .set(...alice())
      .send({ session_id: "practice_x", flashcard_id: "f99", confidence: "known" });
    expect(missing.status).toBe(404);

    const bogus = await request(h.app)
      .post("/kits/kit_seed/practice")
      .set(...alice())
      .send({ session_id: "practice_x", flashcard_id: "f1", confidence: "brilliant" });
    expect(bogus.status).toBe(400);
    expect(bogus.body).toMatchObject({ code: "INVALID_BODY", field: "confidence" });
  });

  it("does not bump the kit's version — a rating is not an edit", async () => {
    await seed();
    const before = (await h.kits.findById("kit_seed"))?.kit.version;
    await request(h.app)
      .post("/kits/kit_seed/practice")
      .set(...alice())
      .send({ session_id: "practice_x", flashcard_id: "f1", confidence: "known" });

    expect((await h.kits.findById("kit_seed"))?.kit.version).toBe(before);
  });
});
