import { resolve } from "node:path";
import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";
import { DevAuthenticator, ClerkAuthenticator } from "@trao/auth";
import type { Budget, JobStore, KitStore } from "@trao/contracts";
import { InMemoryTracer, RandomIdGenerator, RoutedIdGenerator, SequentialIdGenerator, SystemClock } from "@trao/kernel";
import type { InternalKit } from "@trao/kit";
import { FakeLlmProvider, unlimitedBudget } from "@trao/llm";
import { MemoryJobStore, MemoryKitStore } from "@trao/persistence";
import { NullSearchProvider } from "@trao/research";
import { FakeFetcher, fixtureMounts } from "@trao/retrieval";
import { createApp } from "../src/app";
import { JobRunner } from "../src/jobs";
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
}

function harness(): Harness {
  const kits = new MemoryKitStore<InternalKit>();
  const jobs = new MemoryJobStore(clock);

  const makeDeps = () => {
    const fake = new FakeLlmProvider({ responses: fakeLlmResponses() });
    fake.respondWith("gap_fill", gapFillResponse);
    const budget: Budget = unlimitedBudget(clock);

    return {
      llm: fake,
      fetcher: new FakeFetcher({ root: FIXTURE_ROOT, mounts: fixtureMounts() }),
      search: new NullSearchProvider(),
      tracer: new InMemoryTracer(clock),
      clock,
      ids: new RoutedIdGenerator(new SequentialIdGenerator(), { kit_: new RandomIdGenerator() }),
      budget,
      requestsPerSecond: 1_000,
    };
  };

  const runner = new JobRunner({ jobs, kits, ids: new RandomIdGenerator(), clock, makeDeps });
  const app = createApp({ auth: new DevAuthenticator(), jobs, kits, runner });

  return { app, kits, jobs, runner };
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
  h = harness();
});

describe("auth", () => {
  it("refuses an unauthenticated request", async () => {
    const app = createApp({
      auth: new ClerkAuthenticator({ issuer: "https://example.test", verify: async () => ({ sub: "x" }) }),
      jobs: h.jobs,
      kits: h.kits,
      runner: h.runner,
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
      runner: h.runner,
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
      runner: h.runner,
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

  it("rejects a malformed role with the reason", async () => {
    const response = await request(h.app)
      .post("/kits")
      .set("authorization", "Bearer alice")
      .send({ jd: "", company_url: "not-a-url", days: 0 });

    expect(response.status).toBe(422);
    expect((response.body as { code: string }).code).toBe("INVALID_ROLE");
    expect((response.body as { message: string }).message).toMatch(/jd|company_url|days/);
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
