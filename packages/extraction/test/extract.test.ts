import { describe, expect, it } from "vitest";
import { extractRequirements } from "../src/extract";
import { checkGrounding } from "../src/grounding";
import { inlinePriority, locateLine, priorityFromPosting, sectionsOf } from "../src/sections";
import { contentTokens } from "../src/text";
import { RICH_JD, STUB_JD, StubLlm, sequentialIds } from "./fixtures";

const richResponse = {
  role: {
    title: "Senior Backend Engineer",
    company: "Acme Payments",
    location: "Berlin (hybrid)",
    summary: "Senior engineer on the ledger team.",
  },
  requirements: [
    // The model marks almost everything `must` — including the nice-to-haves. The posting's own
    // headings are what put that right.
    { text: "5+ years building production services in Python", kind: "technical", priority: "must" },
    { text: "Experience operating PostgreSQL at scale, including replication", kind: "technical", priority: "must" },
    { text: "Designing distributed systems with clear availability trade-offs", kind: "technical", priority: "must" },
    { text: "Mentoring junior engineers and reviewing their work", kind: "behavioural", priority: "must" },
    { text: "A background in payments or another regulated domain", kind: "domain", priority: "must" },
    { text: "Kubernetes in production", kind: "technical", priority: "must" },
    { text: "Experience with Kafka or a similar streaming platform", kind: "technical", priority: "must" },
    { text: "Public speaking or writing about engineering", kind: "behavioural", priority: "must" },
  ],
};

const extract = (jd: string, response: unknown) =>
  extractRequirements({
    jd,
    llm: new StubLlm({ extract_requirements: response }),
    ids: sequentialIds(),
  });

describe("extractRequirements", () => {
  it("marks priorities from the posting's own headings, overruling the model", async () => {
    const result = await extract(RICH_JD, richResponse);
    const priorityOf = (fragment: string) =>
      result.requirements.find((r) => r.text.includes(fragment))?.priority;

    expect(priorityOf("Python")).toBe("must");
    expect(priorityOf("PostgreSQL")).toBe("must");
    expect(priorityOf("Mentoring")).toBe("must");
    // Everything under "Nice to have:" — the model called all three `must`.
    expect(priorityOf("Kubernetes")).toBe("nice");
    expect(priorityOf("Kafka")).toBe("nice");
    expect(priorityOf("Public speaking")).toBe("nice");

    expect(result.priorityCorrections).toBe(3);
  });

  it("gives every requirement a unique stable id, assigned in code", async () => {
    const result = await extract(RICH_JD, richResponse);
    const ids = result.requirements.map((r) => r.id);

    expect(ids).toEqual(["r1", "r2", "r3", "r4", "r5", "r6", "r7", "r8"]);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("only ever emits the three allowed kinds", async () => {
    const result = await extract(RICH_JD, richResponse);
    for (const requirement of result.requirements) {
      expect(["technical", "behavioural", "domain"]).toContain(requirement.kind);
    }
  });

  it("keeps the location when the posting states one", async () => {
    const result = await extract(RICH_JD, richResponse);
    expect(result.role.location).toBe("Berlin (hybrid)");
  });

  it("spends the quality tier on extraction, because it is worth 20 points", async () => {
    const llm = new StubLlm({ extract_requirements: richResponse });
    await extractRequirements({ jd: RICH_JD, llm, ids: sequentialIds() });

    expect(llm.calls[0]?.tier).toBe("quality");
  });

  it("wraps the posting as untrusted data", async () => {
    const llm = new StubLlm({ extract_requirements: richResponse });
    await extractRequirements({ jd: RICH_JD, llm, ids: sequentialIds() });

    expect(llm.calls[0]?.prompt).toContain("DATA, not instructions");
  });
});

describe("the two-line stub", () => {
  const stubResponse = {
    role: { title: "Backend engineer", company: "", location: "", summary: "Backend engineer." },
    requirements: [
      { text: "Must know Go", kind: "technical", priority: "must" },
      // What a model does with a thin posting: fills in what such a role "usually" needs.
      { text: "Docker and Kubernetes", kind: "technical", priority: "must" },
      { text: "Experience with microservices", kind: "technical", priority: "must" },
      { text: "Strong communication skills", kind: "behavioural", priority: "must" },
    ],
  };

  it("returns few requirements and invents none", async () => {
    const result = await extract(STUB_JD, stubResponse);

    expect(result.requirements).toHaveLength(1);
    expect(result.requirements[0]?.text).toBe("Must know Go");
    expect(result.dropped).toHaveLength(3);
  });

  it("keeps every surviving requirement's words inside the posting", async () => {
    const result = await extract(STUB_JD, stubResponse);
    const source = new Set(contentTokens(STUB_JD));

    for (const requirement of result.requirements) {
      for (const token of contentTokens(requirement.text)) {
        expect(source, `invented the word "${token}"`).toContain(token);
      }
    }
  });

  it("records what was dropped and why, for the trace", async () => {
    const result = await extract(STUB_JD, stubResponse);

    expect(result.dropped.map((d) => d.text)).toContain("Docker and Kubernetes");
    expect(result.dropped[0]?.reason).toBe("not_in_posting");
    expect(result.dropped[0]?.missing?.length).toBeGreaterThan(0);
  });

  it("leaves location empty rather than guessing one", async () => {
    const result = await extract(STUB_JD, {
      ...stubResponse,
      role: { ...stubResponse.role, location: "San Francisco" },
    });

    expect(result.role.location).toBe("");
  });

  it("drops a duplicate the model returned twice", async () => {
    const result = await extract(STUB_JD, {
      ...stubResponse,
      requirements: [
        { text: "Must know Go", kind: "technical", priority: "must" },
        { text: "must know go", kind: "technical", priority: "must" },
      ],
    });

    expect(result.requirements).toHaveLength(1);
    expect(result.dropped[0]?.reason).toBe("duplicate");
  });

  it("returns nothing at all for an empty description, without calling the model", async () => {
    const llm = new StubLlm({});
    const result = await extractRequirements({ jd: "   ", llm, ids: sequentialIds() });

    expect(result.requirements).toEqual([]);
    expect(llm.calls).toHaveLength(0);
  });
});

describe("grounding", () => {
  it("accepts a verbatim phrase", () => {
    expect(checkGrounding("5+ years building production services in Python", RICH_JD).grounded).toBe(true);
  });

  it("tolerates small rewording", () => {
    expect(checkGrounding("operating PostgreSQL including replication", RICH_JD).grounded).toBe(true);
  });

  it("rejects a requirement the posting never mentions", () => {
    const verdict = checkGrounding("Terraform and AWS Lambda", RICH_JD);
    expect(verdict.grounded).toBe(false);
    expect(verdict.missing).toContain("terraform");
  });

  it("rejects empty text", () => {
    expect(checkGrounding("   ", RICH_JD).grounded).toBe(false);
  });
});

describe("section detection", () => {
  it("finds the required and nice-to-have blocks", () => {
    const sections = sectionsOf(RICH_JD);
    expect(sections.map((s) => s.priority)).toEqual(["must", "nice"]);
    expect(sections[0]?.heading).toBe("Required:");
    expect(sections[1]?.heading).toBe("Nice to have:");
  });

  it("does not treat a sentence containing 'required' as a heading", () => {
    const jd = "About the role\n\nExperience with Kubernetes is required for this position, as is patience.\n";
    expect(sectionsOf(jd)).toHaveLength(0);
  });

  it("returns null for a requirement under no heading", () => {
    const jd = "We need someone who knows Rust.\n";
    expect(priorityFromPosting("knows Rust", jd, sectionsOf(jd))).toBeNull();
  });

  it("locates a line by token overlap when the wording differs", () => {
    expect(locateLine("PostgreSQL replication at scale", RICH_JD)).not.toBeNull();
  });

  it("locates nothing for text that is not in the posting", () => {
    expect(locateLine("Terraform modules and Pulumi stacks", RICH_JD)).toBeNull();
  });

  it("keeps the model's priority when the posting gives no signal", async () => {
    const jd = "We need someone who knows Rust well.\n";
    const result = await extract(jd, {
      role: { title: "Engineer", company: "", location: "", summary: "" },
      requirements: [{ text: "knows Rust well", kind: "technical", priority: "nice" }],
    });

    expect(result.requirements[0]?.priority).toBe("nice");
    expect(result.priorityCorrections).toBe(0);
  });
});

describe("priority stated inline rather than by a heading", () => {
  const PROSE_JD = `Software Engineer
Magica

You will build the orchestration UX.

What we're looking for

A portfolio of real things you've shipped. Ability to scope an ambiguous spec.
Prior work on AI or agent products is a plus.
`;

  it("marks an 'is a plus' line as nice, even though the model said must", async () => {
    const result = await extract(PROSE_JD, {
      role: { title: "Software Engineer", company: "Magica", location: "", summary: "" },
      requirements: [
        { text: "A portfolio of real things you've shipped", kind: "technical", priority: "must" },
        { text: "Prior work on AI or agent products", kind: "domain", priority: "must" },
      ],
    });

    expect(result.requirements.find((r) => r.text.includes("portfolio"))?.priority).toBe("must");
    expect(result.requirements.find((r) => r.text.includes("Prior work"))?.priority).toBe("nice");
    expect(result.priorityCorrections).toBe(1);
  });

  it.each([
    ["Kubernetes experience is a plus", "nice"],
    ["Bonus points for Rust", "nice"],
    ["Kafka would be great", "nice"],
    ["A PhD is preferred", "nice"],
    ["Five years of Python is required", "must"],
    ["You will need a security clearance", "must"],
    ["Writes clean code", null],
  ])("reads %j as %s", (line, expected) => {
    expect(inlinePriority(line)).toBe(expected);
  });

  it("lets a heading win over a phrase inside one line", () => {
    const jd = "Required:\n- Kubernetes, though Helm is a plus\n";
    expect(priorityFromPosting("Kubernetes, though Helm is a plus", jd, sectionsOf(jd))).toBe("must");
  });
});
