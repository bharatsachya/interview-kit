import { describe, expect, it } from "vitest";
import { parseCases, parseCasesJSON, validateEvaluationOutput } from "../src/appendix-b";
import { toKitJSON } from "../src/projections";
import { makeKit } from "./fixtures";

/**
 * The batch input is the one file a grader hands us that we did not write. It is parsed in two
 * places — the batch script and the web upload — so these tests guard the shape both rely on.
 */

const VALID_CASE = {
  id: "case-01",
  jd: "Senior Backend Engineer\n\nWe are looking for someone to own our payments API.",
  company_url: "http://localhost:8099/acme/",
  days: 5,
};

describe("parseCases", () => {
  it("accepts the Appendix B example", () => {
    const result = parseCases([VALID_CASE]);
    expect(result.ok).toBe(true);
    expect(result.cases).toHaveLength(1);
    expect(result.cases?.[0]?.days).toBe(5);
  });

  it("accepts a loopback company_url, because Appendix B serves from one", () => {
    // The SSRF decision belongs to the fetcher and its ALLOW_PRIVATE_HOSTS flag. A parser that
    // rejected loopback here would fail every batch case before retrieval ever ran.
    const result = parseCases([{ ...VALID_CASE, company_url: "http://127.0.0.1:8099/acme/" }]);
    expect(result.ok).toBe(true);
  });

  it("rejects an empty array — a run with no cases is a mistake, not an empty success", () => {
    expect(parseCases([]).ok).toBe(false);
  });

  it("rejects a non-integer or zero days", () => {
    expect(parseCases([{ ...VALID_CASE, days: 2.5 }]).ok).toBe(false);
    expect(parseCases([{ ...VALID_CASE, days: 0 }]).ok).toBe(false);
  });

  it("rejects an unknown field rather than dropping it silently", () => {
    const result = parseCases([{ ...VALID_CASE, seniority: "senior" }]);
    expect(result.ok).toBe(false);
  });

  it("rejects duplicate ids, because the output is keyed by id", () => {
    const result = parseCases([VALID_CASE, { ...VALID_CASE, jd: "Another role entirely." }]);
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toContain("duplicate case id: case-01");
  });

  it("names the offending case and field, so a forty-entry file is actionable", () => {
    const result = parseCases([VALID_CASE, { ...VALID_CASE, id: "case-02", days: "five" }]);
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toContain("1.days");
  });

  it("reports malformed JSON as a parse error rather than throwing", () => {
    const result = parseCasesJSON("[{ id: 'case-01' }");
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toContain("not valid JSON");
  });
});

describe("validateEvaluationOutput", () => {
  it("accepts an ok case carrying a real Appendix A kit", () => {
    const output = {
      version: "1.0",
      generated_at: "2026-09-01T09:12:44Z",
      kits: [{ id: "case-01", status: "ok", kit: toKitJSON(makeKit()), error: null }],
    };
    expect(validateEvaluationOutput(output).ok).toBe(true);
  });

  it("accepts a failed case with a null kit and an error", () => {
    const output = {
      version: "1.0",
      generated_at: "2026-09-01T09:12:44Z",
      kits: [
        {
          id: "case-04",
          status: "failed",
          kit: null,
          error: { code: "COMPANY_UNREACHABLE", message: "Company site unreachable after 3 retries." },
        },
      ],
    };
    expect(validateEvaluationOutput(output).ok).toBe(true);
  });

  it("rejects a wrong version literal", () => {
    const output = { version: "1", generated_at: "2026-09-01T09:12:44Z", kits: [] };
    expect(validateEvaluationOutput(output).ok).toBe(false);
  });

  it("rejects an ok case whose kit does not satisfy Appendix A", () => {
    const kit = toKitJSON(makeKit()) as Record<string, unknown>;
    const broken = { ...kit, questions: [{ ...(kit.questions as object[])[0], difficulty: 4 }] };
    const output = {
      version: "1.0",
      generated_at: "2026-09-01T09:12:44Z",
      kits: [{ id: "case-01", status: "ok", kit: broken, error: null }],
    };
    expect(validateEvaluationOutput(output).ok).toBe(false);
  });
});
