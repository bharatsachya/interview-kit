import { describe, expect, it } from "vitest";
import { checkClaims, claimsIn } from "../src/claims";

const pages = [
  "Vaultline builds payment infrastructure for online marketplaces. We process payouts in 14 " +
    "currencies and were founded in 2016. The platform runs on PostgreSQL and Kafka.",
  "Our interview process is a take-home followed by a system design round.",
];

/**
 * The check that stops a brief inventing something a candidate would prepare against.
 *
 * The design constraint is that a summary *rewords* — so this looks only at the parts of a
 * sentence that cannot be reworded and that a reader would act on. Most of these cases are about
 * what it must NOT flag, because a check that cries wolf on competent prose is one nobody reads.
 */
describe("checkClaims", () => {
  it("passes a brief that only says what the pages say", () => {
    const brief =
      "Vaultline builds payment infrastructure for marketplaces. It was founded in 2016 and " +
      "runs on PostgreSQL.";
    expect(checkClaims(brief, pages).unsupported).toEqual([]);
  });

  it("catches a technology nothing mentioned", () => {
    const brief = "The platform runs on PostgreSQL and Redis.";
    const result = checkClaims(brief, pages);
    expect(result.unsupported.map((c) => c.text)).toEqual(["Redis"]);
  });

  it("catches a number nothing supports", () => {
    const brief = "Vaultline processes €2bn a year across 14 currencies.";
    const result = checkClaims(brief, pages);
    // 14 is in the pages; 2bn is not.
    expect(result.unsupported.map((c) => c.text)).toEqual(["2bn"]);
  });

  it("does not flag a sentence that merely rewords one", () => {
    // The whole reason this is not `checkGrounding`: none of these words are in the pages and
    // the sentence is a faithful summary.
    const brief = "They help online sellers move money between buyers and vendors.";
    expect(checkClaims(brief, pages).unsupported).toEqual([]);
  });

  it("catches an invented name that opens a sentence", () => {
    // The hole the eval cases found. Skipping every sentence-initial capital was the first cut,
    // and it gave a free pass to exactly the sentence a brief is made of: a proper noun, a verb,
    // a claim. `Redis` is not ordinary English, so being first does not excuse it.
    const brief = "Redis is used for caching. Redis is used for queues.";
    expect(checkClaims(brief, pages).unsupported.map((c) => c.text)).toEqual(["Redis"]);
  });

  it("does not flag a word for being at the start of a sentence", () => {
    const brief = "Payments are their business. Marketplaces are the customer.";
    expect(checkClaims(brief, pages).unsupported).toEqual([]);
  });

  it("still catches a name at the start of a sentence when its shape gives it away", () => {
    const brief = "PostgreSQL is the database. GraphQL is the API layer.";
    expect(checkClaims(brief, pages).unsupported.map((c) => c.text)).toEqual(["GraphQL"]);
  });

  it("allows what the model was told rather than shown", () => {
    // The company name and role reach the prompt as arguments, not as a retrieved page.
    const brief = "Northwind is hiring a Staff Platform Engineer.";
    const withAllowance = checkClaims(brief, pages, ["Northwind", "Staff Platform Engineer"]);
    expect(withAllowance.unsupported).toEqual([]);
    expect(checkClaims(brief, pages).unsupported.length).toBeGreaterThan(0);
  });

  it("counts one claim however many times it is repeated", () => {
    const result = checkClaims("Redis, Redis and Redis again.", pages);
    expect(result.unsupported).toHaveLength(1);
  });

  it("reports how many claims it looked at, so zero unsupported is distinguishable from zero checked", () => {
    // A brief with nothing checkable in it is not a verified brief, and the trace must not read
    // as though it were.
    expect(checkClaims("They help people move money.", pages).checked).toBe(0);
    expect(checkClaims("They use PostgreSQL.", pages).checked).toBe(1);
  });

  it("has nothing to say about an empty brief", () => {
    expect(checkClaims("", pages)).toEqual({ checked: 0, unsupported: [] });
  });

  it("treats everything as unsupported when nothing was retrieved", () => {
    // The honest outcome: with no sources, every name in the prose came from somewhere else.
    expect(checkClaims("They run on Kafka.", []).unsupported.map((c) => c.text)).toEqual(["Kafka"]);
  });
});

/**
 * Question text is a different mood from a brief, and the first real run proved it.
 *
 * The check flagged "Walk", "What" and "Tell" as invented names — sentence-initial imperatives
 * and interrogatives, which a declarative-prose word list had no reason to contain. Left alone,
 * every category would have reported two or three unsupported claims on a clean run, and the
 * number would have meant nothing.
 */
describe("over question text", () => {
  const context = ["PostgreSQL query tuning at scale", "Mentoring junior engineers"];

  it("says nothing about the way a question opens", () => {
    const questions = [
      "Walk me through a query you tuned.",
      "What would you change about it?",
      "Tell me about mentoring someone.",
      "Describe a system you designed.",
      "How would you approach it?",
    ].join(" ");
    expect(checkClaims(questions, context).unsupported).toEqual([]);
  });

  it("still catches a technology the call was never given", () => {
    const question = "Walk me through how you would shard a Cassandra cluster.";
    expect(checkClaims(question, context).unsupported.map((c) => c.text)).toEqual(["Cassandra"]);
  });

  it("catches an answer outline asserting a fact about the company", () => {
    const outline = "A strong answer mentions their migration to Kubernetes in 2021.";
    expect(checkClaims(outline, context).unsupported.map((c) => c.text)).toEqual(["Kubernetes", "2021"]);
  });

  it("is silent on an outline that describes reasoning rather than facts", () => {
    const outline = "A strong answer covers the plan, the index, and how they measured it.";
    expect(checkClaims(outline, context).checked).toBe(0);
  });

  it("flags a term the material implies but never says — a known limit, not a bug", () => {
    // `EXPLAIN` is the Postgres command "query tuning at scale" is about, and the check cannot
    // know that: it tests whether a token is present, not whether it is entailed. This is the
    // reason question-side claims are recorded as a smell and never acted on. Pinned so the
    // boundary is a decision rather than a surprise.
    const question = "Walk me through a PostgreSQL query you tuned. What did EXPLAIN show?";
    expect(checkClaims(question, context).unsupported.map((c) => c.text)).toEqual(["EXPLAIN"]);
  });
});

describe("claimsIn", () => {
  it("ignores a bare single digit, which carries no claim on its own", () => {
    expect(claimsIn("Teams of 5 people.").filter((c) => c.kind === "number")).toEqual([]);
  });

  it("keeps a single digit that carries a unit", () => {
    expect(claimsIn("They raised 9m last year.").map((c) => c.text)).toContain("9m");
  });

  it("keeps a year", () => {
    expect(claimsIn("Founded in 2016.").map((c) => c.text)).toContain("2016");
  });

  it("does not mistake an initial for a name", () => {
    expect(claimsIn("Run by J. Smith.").map((c) => c.text)).not.toContain("J");
  });
});
