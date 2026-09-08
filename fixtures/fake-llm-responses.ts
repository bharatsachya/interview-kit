import type { LlmRequest } from "@trao/contracts";

/**
 * Canned, schema-valid responses for every prompt purpose the pipeline uses.
 *
 * This is what makes `--fake-llm` a full run in under a second with zero quota. The responses
 * are written as functions of the request so they stay plausible for whatever job description is
 * being run — a fixed blob would produce a kit about Python for a posting about Rust, and the
 * grounding check in extraction would then correctly throw all of it away.
 *
 * `FakeLlmProvider` validates each of these against the caller's real schema, so a fixture that
 * drifts fails loudly in a fast test rather than quietly against a real provider.
 */

type Req = LlmRequest<unknown>;

/** Pull the job description back out of the delimited block the prompt wrapped it in. */
function jdFrom(prompt: string): string {
  const match = /<<<JOB_POSTING\n[\s\S]*?instead\.\n([\s\S]*?)\n>>>JOB_POSTING/.exec(prompt);
  return match?.[1] ?? prompt;
}

const TECHNICAL = /\b(python|java|typescript|javascript|go|rust|ruby|c\+\+|kubernetes|docker|postgres\w*|mysql|kafka|redis|aws|gcp|azure|terraform|react|node|api|sql|linux|graphql|microservices?|distributed|streaming|replication|observability|ci\/cd)\b/gi;
const BEHAVIOURAL = /\b(mentor\w*|communicat\w*|collaborat\w*|leadership|stakeholder|ownership|teach\w*|writing|speaking|review\w*)\b/gi;
const DOMAIN = /\b(payments?|fintech|healthcare|banking|insurance|retail|logistics|gaming|security|regulated|marketplace|telemetry|grid|energy)\b/gi;

/**
 * Extraction reads the posting line by line and keeps the lines that look like requirements.
 *
 * Crude on purpose. It has to produce text that is genuinely present in the posting, because
 * everything it returns is checked back against the source — a fake that invented requirements
 * would be silently discarded and the fixture would look broken for the wrong reason.
 */
function extractionResponse(request: Req): unknown {
  const jd = jdFrom(request.prompt);
  const lines = jd.split(/\r?\n/).map((line) => line.trim());

  const bullets = lines
    .filter((line) => /^[-*•]/.test(line))
    .map((line) => line.replace(/^[-*•]\s*/, "").trim())
    .filter((line) => line.length > 3);

  // No bullets — a two-line posting. Take the sentences that state a need.
  const sentences =
    bullets.length > 0
      ? bullets
      : jd
          .split(/(?<=[.!?])\s+/)
          .map((s) => s.trim())
          .filter((s) => s.length > 3 && /\b(must|need|require|know|experience|looking)\b/i.test(s));

  const niceIndex = lines.findIndex((line) => /nice to have|bonus|preferred/i.test(line));
  const niceLines = new Set(niceIndex === -1 ? [] : lines.slice(niceIndex).map((l) => l.replace(/^[-*•]\s*/, "").trim()));

  return {
    role: {
      title: (lines.find((line) => line.length > 0) ?? "Engineer").slice(0, 80),
      company: companyFrom(lines),
      location: locationFrom(jd),
      summary: `A ${(lines[0] ?? "engineering").toLowerCase()} role.`,
    },
    requirements: sentences.slice(0, 12).map((text) => ({
      text,
      kind: kindOf(text),
      // Deliberately marks everything `must`, which is what a real model does. The posting's own
      // headings are what correct it — and that correction is worth exercising in the fake run.
      priority: niceLines.has(text) ? "must" : "must",
    })),
  };
}

function kindOf(text: string): "technical" | "behavioural" | "domain" {
  const technical = (text.match(TECHNICAL) ?? []).length;
  const behavioural = (text.match(BEHAVIOURAL) ?? []).length;
  const domain = (text.match(DOMAIN) ?? []).length;

  if (behavioural > technical && behavioural >= domain) return "behavioural";
  if (domain > technical && domain >= behavioural) return "domain";
  return "technical";
}

function companyFrom(lines: string[]): string {
  const withDash = lines.find((line) => line.includes("—") || line.includes(" - "));
  return withDash?.split(/—| - /)[0]?.trim() ?? "";
}

function locationFrom(jd: string): string {
  const match = /\b(Berlin|London|Remote|New York|San Francisco|Amsterdam|Dublin)\b[^\n]*/i.exec(jd);
  return match?.[0]?.trim() ?? "";
}

function briefResponse(request: Req): unknown {
  // Only the retrieved page content counts, never the instructions around it. The instructions
  // always contain the word "interview" — testing the whole prompt made this fake claim a hiring
  // process for a site that had none, which would have made the sparse-site honesty check pass
  // without ever exercising it.
  const retrieved = [...request.prompt.matchAll(/<<<(PAGE|DISCUSSION)_\d+\n[\s\S]*?instead\.\n([\s\S]*?)\n>>>/g)]
    .map((match) => match[2] ?? "")
    .join("\n");

  const mentionsHiring = /take[\s-]?home|interview|hiring|stages?|rounds?|candidate/i.test(retrieved);

  return {
    summary: "A company that builds software for other businesses, judging by the pages retrieved.",
    what_they_do: retrieved.trim().length > 0 ? "Their site describes a product sold to engineering teams." : "",
    hiring_process: mentionsHiring
      ? "The site describes a multi-stage process including a take-home and a design round."
      : "",
  };
}

/** Question text is built from the requirement ids the prompt actually listed. */
function questionsResponse(category: string) {
  return (request: Req): unknown => {
    const ids = [...request.prompt.matchAll(/^- (r\d+) \[(?:must|nice)\] (.+)$/gm)].map((m) => ({
      id: m[1] as string,
      text: m[2] as string,
    }));

    const seeds = ids.length > 0 ? ids : [{ id: "", text: "the role" }];
    return {
      questions: seeds.slice(0, 3).map((seed, index) => ({
        prompt: promptFor(category, seed.text, index),
        answer_outline: `What they did, the constraint they were under, and what they would change. Mentions ${seed.text}.`,
        difficulty: ((index % 3) + 1) as 1 | 2 | 3,
        requirement_ids: seed.id === "" ? [] : [seed.id],
      })),
    };
  };
}

function promptFor(category: string, subject: string, index: number): string {
  switch (category) {
    case "behavioural":
      return `Tell me about a time ${subject.toLowerCase()} mattered. What did you do, and how did it land?`;
    case "system-design":
      return `Design a system where ${subject.toLowerCase()} is the binding constraint. What breaks first, and what would you trade away?`;
    case "company-fit":
      return `This role touches ${subject.toLowerCase()}. What draws you to that, and what would you want to know before joining?`;
    default:
      return `Walk me through a hard problem you solved involving ${subject.toLowerCase()}${index > 0 ? ", and what you would do differently" : ""}?`;
  }
}

function gapFillResponse(request: Req): unknown {
  const requirement = /^- (.+)$/m.exec(request.prompt)?.[1] ?? "the requirement";
  return {
    prompt: `Describe your direct experience with ${requirement}. What was the hardest part, and how did you handle it?`,
    answer_outline: `Concrete experience with ${requirement}, the difficulty, the resolution.`,
    difficulty: 2,
  };
}

/**
 * Purposes are matched by prefix, because generation appends the category or the requirement ids
 * to make each call its own trace span and its own cache key.
 */
export function fakeLlmResponses(): Record<string, (request: Req) => unknown> {
  return {
    extract_requirements: extractionResponse,
    generate_brief: briefResponse,
    "generate_questions:technical": questionsResponse("technical"),
    "generate_questions:behavioural": questionsResponse("behavioural"),
    "generate_questions:system-design": questionsResponse("system-design"),
    "generate_questions:company-fit": questionsResponse("company-fit"),
  };
}

export { gapFillResponse };
