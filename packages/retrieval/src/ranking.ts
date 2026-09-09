import type { Candidate, LinkPosition } from "./discovery";
import { hostOf } from "./url";

/**
 * Heuristic link scoring. Two scorers, no LLM.
 *
 * The brief says directly that **a fixed list of paths is not sufficient**, and the fixtures
 * prove it: one keeps its hiring material at `/company/join-us`, another only in a sitemap, a
 * third behind a link to an applicant tracking system on someone else's domain. Scoring finds
 * all three; a path list finds none.
 *
 * No model. The crawl span carries the top five per scorer with their scores and the reasons for
 * them, so a grader can see why each page was chosen. A model call cannot be inspected that way,
 * would spend quota on a step worth no points, and would be slower than the fetch it is deciding
 * about.
 *
 * Two scorers rather than one because a kit needs two different things. "About us" tells you
 * what the company does; "how we hire" tells you what the interview will be. One ranked list
 * gives you two of one and none of the other, which is how a brief ends up describing a product
 * and saying nothing about the process.
 */

export type ScorerKind = "about" | "hiring";

interface Term {
  term: string;
  weight: number;
}

const ABOUT_TERMS: readonly Term[] = [
  { term: "about", weight: 10 },
  { term: "company", weight: 9 },
  { term: "mission", weight: 8 },
  { term: "story", weight: 7 },
  { term: "team", weight: 7 },
  { term: "who", weight: 4 },
  { term: "we", weight: 3 },
  { term: "us", weight: 4 },
  { term: "values", weight: 5 },
  { term: "product", weight: 4 },
  { term: "platform", weight: 3 },
];

const HIRING_TERMS: readonly Term[] = [
  { term: "careers", weight: 12 },
  { term: "career", weight: 9 },
  { term: "jobs", weight: 11 },
  { term: "job", weight: 7 },
  { term: "hiring", weight: 12 },
  { term: "hire", weight: 10 },
  { term: "join", weight: 9 },
  { term: "recruiting", weight: 9 },
  { term: "recruitment", weight: 9 },
  { term: "openings", weight: 9 },
  { term: "vacancies", weight: 9 },
  { term: "handbook", weight: 8 },
  { term: "interview", weight: 11 },
  { term: "interviewing", weight: 11 },
  { term: "engineering", weight: 5 },
  { term: "eng", weight: 4 },
  { term: "blog", weight: 2 },
  { term: "life", weight: 5 },
  { term: "culture", weight: 5 },
  { term: "working", weight: 5 },
  { term: "work", weight: 3 },
  { term: "people", weight: 4 },
  { term: "apply", weight: 6 },
  { term: "benefits", weight: 4 },
];

/** Pages that are almost never either thing. */
const NEGATIVE: readonly Term[] = [
  { term: "privacy", weight: -14 },
  { term: "terms", weight: -14 },
  { term: "cookie", weight: -14 },
  { term: "legal", weight: -12 },
  { term: "login", weight: -12 },
  { term: "signin", weight: -12 },
  { term: "signup", weight: -10 },
  { term: "pricing", weight: -8 },
  { term: "docs", weight: -6 },
  { term: "documentation", weight: -6 },
  { term: "support", weight: -5 },
  { term: "status", weight: -5 },
  { term: "download", weight: -5 },
  { term: "tag", weight: -5 },
  { term: "category", weight: -5 },
  { term: "archive", weight: -5 },
];

/**
 * Applicant tracking systems. A link to one of these is a company saying "our jobs live here".
 *
 * These were being discarded as external, which is precisely backwards: an ATS host is the
 * strongest hiring signal a link can carry, because nobody links to Greenhouse by accident.
 */
export const ATS_HOSTS =
  /(^|\.)(greenhouse\.io|boards\.greenhouse\.io|lever\.co|jobs\.lever\.co|ashbyhq\.com|workable\.com|myworkdayjobs\.com|workday\.com|bamboohr\.com|jobvite\.com|smartrecruiters\.com|recruitee\.com|teamtailor\.com|personio\.de|breezy\.hr|rippling\.com)$/i;

const POSITION_BONUS: Readonly<Record<LinkPosition, number>> = {
  // "Careers" lives in the nav or the footer on almost every company site.
  nav: 6,
  footer: 5,
  main: 1,
  unknown: 0,
};

export interface ScoredLink extends Candidate {
  score: number;
  /** Why it scored what it did. This is the whole argument for not using a model here. */
  reasons: string[];
  /** True when the link leaves the company's own site. Scored anyway, followed selectively. */
  external: boolean;
}

export interface ScoreOptions {
  /** The site being crawled, so "external" can mean something. */
  origin?: string;
}

export function scoreLink(candidate: Candidate, kind: ScorerKind, options: ScoreOptions = {}): ScoredLink {
  const positive = kind === "hiring" ? HIRING_TERMS : ABOUT_TERMS;
  const urlTokens = tokenise(pathAndQuery(candidate.url));
  const anchorTokens = tokenise(candidate.anchor);
  const host = hostOf(candidate.url);

  let score = 0;
  const reasons: string[] = [];

  for (const { term, weight } of [...positive, ...NEGATIVE]) {
    // Anchor text is the better signal: it is written for humans, while a URL slug is often an
    // accident of the CMS. "Life at Northwind — how we interview" pointing at /company/join-us
    // is the case a path list misses entirely.
    if (anchorTokens.has(term)) {
      score += weight * 2;
      reasons.push(`anchor:${term}${signed(weight * 2)}`);
    }
    if (urlTokens.has(term)) {
      score += weight;
      reasons.push(`url:${term}${signed(weight)}`);
    }
  }

  if (kind === "hiring" && ATS_HOSTS.test(host)) {
    score += 20;
    reasons.push("host:ats+20");
  }

  const bonus = POSITION_BONUS[candidate.position];
  if (bonus > 0) {
    score += bonus;
    reasons.push(`${candidate.position}:+${bonus}`);
  }

  // A dated path is an article, whatever else it says.
  if (/\/(19|20)\d{2}\//.test(safePathname(candidate.url))) {
    score -= 8;
    reasons.push("url:dated-8");
  }

  const depth = pathDepth(candidate.url);
  if (depth > 2) {
    const penalty = (depth - 2) * 2;
    score -= penalty;
    reasons.push(`depth:${depth}-${penalty}`);
  }

  const external = options.origin !== undefined && !sameOrigin(candidate.url, options.origin);
  return { ...candidate, score, reasons, external };
}

/**
 * Score first, filter later.
 *
 * Everything discovered is ranked, including links to other domains. Deciding what to follow is
 * a separate question from deciding what is relevant, and collapsing the two is what threw away
 * a careers page for being on greenhouse.io.
 */
export function rankLinks(
  candidates: readonly Candidate[],
  kind: ScorerKind,
  options: ScoreOptions = {},
): ScoredLink[] {
  return candidates
    .map((candidate) => scoreLink(candidate, kind, options))
    // Stable: score, then shallower, then alphabetical, so a crawl is reproducible.
    .sort((a, b) => b.score - a.score || pathDepth(a.url) - pathDepth(b.url) || a.url.localeCompare(b.url));
}

function sameOrigin(candidate: string, origin: string): boolean {
  try {
    return new URL(candidate).origin === new URL(origin).origin;
  } catch {
    return false;
  }
}

function signed(weight: number): string {
  return weight > 0 ? `+${weight}` : String(weight);
}

function safePathname(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

function pathAndQuery(url: string): string {
  try {
    const parsed = new URL(url);
    // The host counts for an external link: boards.greenhouse.io/acme says "jobs" in the host.
    return `${parsed.hostname} ${parsed.pathname} ${parsed.search}`;
  } catch {
    return url;
  }
}

function pathDepth(url: string): number {
  return safePathname(url).split("/").filter(Boolean).length;
}

function tokenise(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/\.(html?|php|aspx?)(?=$|\s)/g, " ")
      .split(/[^a-z0-9]+/)
      .filter(Boolean),
  );
}
