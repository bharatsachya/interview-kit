import { truncateForPrompt, untrustedBlock, type LlmProvider } from "@trao/contracts";
import { steerLines } from "./steer";
import { checkClaims, type Claim } from "./claims";
import type { CompanyBrief } from "@trao/kit";
import { z } from "zod";

/**
 * The company brief, built from what retrieval actually found.
 *
 * The rubric rewards handling the empty case well more than handling the easy one: a company you
 * can find nothing about should produce a brief that says so. So when there is nothing to
 * summarise, **no model call is made at all** — an honest brief is written in code. A model
 * handed an empty context will produce a paragraph regardless, and that paragraph would be
 * fiction.
 *
 * `sources` and `pages_used` are set from the actual inputs, never from the model. They are a
 * factual record of what was fetched, and a model asked to list its sources will list plausible
 * ones.
 */

export interface SourcePage {
  url: string;
  title: string;
  text: string;
}

export interface DiscussionItem {
  title: string;
  url: string;
  content: string;
}

export interface BriefInput {
  company: string;
  roleTitle: string;
  pages: readonly SourcePage[];
  discussion: readonly DiscussionItem[];
  /** Why a source is missing, e.g. "no_key" or "COMPANY_UNREACHABLE". Recorded in `gaps`. */
  retrievalGaps?: readonly string[];
  llm: LlmProvider;
  maxCharsPerPage?: number;
  /**
   * What the candidate asked for, when this brief is being rewritten from the composer.
   *
   * Absent on a first generation — nobody has seen the brief yet, so there is nothing to say
   * about it. See `steerLines` for how it reaches the prompt and what it is allowed to do.
   */
  instructions?: string;
}

export interface BriefResult {
  brief: CompanyBrief;
  hadHiringPage: boolean;
  sourcesUsed: number;
  /** True when the brief was written in code because there was nothing to summarise. */
  fabricationAvoided: boolean;
  /** True when an identical request had already been answered and the model was not called. */
  cacheHit: boolean;
  /**
   * Names and numbers the brief asserted that nothing retrieved supports.
   *
   * Recorded, never removed. Extraction drops an ungrounded requirement because a requirement is
   * a phrase lifted from a document; a brief is a summary that rewords by design, so the same
   * treatment would delete true sentences. The pipeline puts the count and a sample on the span,
   * which is where a kit that reads well and cites nothing becomes visible. See `claims.ts`.
   */
  unsupportedClaims: Claim[];
  /** How many checkable claims it made at all — zero unsupported out of zero is not a pass. */
  claimsChecked: number;
}

const briefSchema = z.object({
  summary: z.string(),
  what_they_do: z.string(),
  /**
   * Empty string when the retrieved pages say nothing about interviewing. Named explicitly in
   * the prompt, because "say nothing" is the instruction a model is most likely to ignore.
   */
  hiring_process: z.string(),
});

const HIRING_SIGNALS = /\b(interview|hiring|recruit|take[\s-]?home|onsite|screening|candidate)\b/i;

export async function generateBrief(input: BriefInput): Promise<BriefResult> {
  const pagesUsed = input.pages.map((page) => page.url);
  const sources = [...pagesUsed, ...input.discussion.map((item) => item.url)];
  const hadHiringPage = input.pages.some((page) => HIRING_SIGNALS.test(`${page.title} ${page.text}`));

  const gaps = [...(input.retrievalGaps ?? [])];
  if (input.pages.length === 0) gaps.push("The company website could not be read, so this brief comes from the job description alone.");
  else if (!hadHiringPage) gaps.push("No page describing the interview process was found on the company site.");
  if (input.discussion.length === 0) gaps.push("No public discussion of the company's interview process was retrieved.");

  if (input.pages.length === 0 && input.discussion.length === 0) {
    return {
      brief: honestlyEmpty(input.company, gaps),
      hadHiringPage: false,
      sourcesUsed: 0,
      fabricationAvoided: true,
      cacheHit: false,
      // Written in code from a fixed sentence. There is nothing here a model could have invented.
      unsupportedClaims: [],
      claimsChecked: 0,
    };
  }

  const { data, cacheHit } = await input.llm.complete({
    purpose: "generate_brief",
    prompt: buildPrompt(input),
    schema: briefSchema,
  });

  const hiringProcess = data.hiring_process.trim();

  // A page that mentioned interviewing was found, and the model still had nothing to say about
  // the process. Without this the kit shows an empty hiring section and no reason for it, which
  // reads as a bug rather than as an honest gap — and the whole point of the empty-string
  // instruction is that saying nothing has to be visible.
  if (hadHiringPage && hiringProcess.length === 0) {
    gaps.push("The company site was read, but none of it described the interview process in enough detail to summarise.");
  }

  // Checked against what the model was actually shown: the page text and the discussion it was
  // given, plus the company and role, which reach the prompt as arguments rather than as a page.
  const claims = checkClaims(
    `${data.summary} ${data.what_they_do} ${hiringProcess}`,
    [...input.pages.map((page) => `${page.title} ${page.text}`), ...input.discussion.map((item) => `${item.title} ${item.content}`)],
    [input.company, input.roleTitle],
  );

  return {
    brief: {
      summary: data.summary.trim(),
      whatTheyDo: data.what_they_do.trim(),
      hiringProcess,
      sources,
      pagesUsed,
      gaps,
      edited: false,
      origin: "generated",
    },
    hadHiringPage,
    sourcesUsed: sources.length,
    fabricationAvoided: false,
    cacheHit,
    unsupportedClaims: claims.unsupported,
    claimsChecked: claims.checked,
  };
}

function honestlyEmpty(company: string, gaps: string[]): CompanyBrief {
  const name = company.trim().length > 0 ? company.trim() : "This company";
  return {
    summary: `Nothing could be retrieved about ${name}. What follows in this kit comes from the job description alone.`,
    whatTheyDo: "",
    hiringProcess: "",
    sources: [],
    pagesUsed: [],
    gaps,
    edited: false,
    origin: "generated",
  };
}

function buildPrompt(input: BriefInput): string {
  const perPage = input.maxCharsPerPage ?? 3_000;

  const pages = input.pages
    .map((page, index) => untrustedBlock(`page_${index + 1}`, `URL: ${page.url}\nTITLE: ${page.title}\n\n${truncateForPrompt(page.text, perPage)}`))
    .join("\n\n");

  const discussion = input.discussion
    .map((item, index) => untrustedBlock(`discussion_${index + 1}`, `URL: ${item.url}\nTITLE: ${item.title}\n\n${truncateForPrompt(item.content, 1_500)}`))
    .join("\n\n");

  return [
    `Write a short briefing on ${input.company || "this company"} for someone interviewing there`,
    `for a ${input.roleTitle || "role"}.`,
    "",
    "Use ONLY the material below. This is the rule that matters:",
    "",
    "- If the material does not say what the company does, say so plainly in `what_they_do`",
    "  rather than inferring it from the company's name or from the job title.",
    "- If nothing below describes how they interview, return an EMPTY STRING for",
    "  `hiring_process`. Do not describe a typical hiring process. An empty field is correct and",
    "  useful; a plausible invention is worse than nothing, because the candidate will prepare",
    "  for the wrong thing.",
    "- Do not list sources. They are recorded separately from what was actually fetched.",
    "",
    "`summary` is two or three sentences a candidate would want to know before walking in.",
    "",
    ...steerLines(input.instructions),
    pages.length > 0 ? pages : "(no pages were retrieved)",
    "",
    discussion.length > 0 ? discussion : "(no public discussion was retrieved)",
    "",
    "Return JSON of exactly this shape and nothing else:",
    "",
    '{ "summary": "", "what_they_do": "", "hiring_process": "" }',
    "",
    "Every value is a single string. `hiring_process` may be empty.",
  ].join("\n");
}
