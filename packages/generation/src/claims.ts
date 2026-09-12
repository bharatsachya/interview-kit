/**
 * Did the model assert something nothing it was shown supports?
 *
 * Extraction has had this since it was written: `checkGrounding` refuses a requirement whose
 * distinctive words are not in the posting, because the rubric's words are that **nothing is
 * invented**. The brief never had it. So a requirement the model made up was dropped and
 * recorded, while a brief that said a company processes two billion euros a year and runs on
 * Kafka shipped straight to a candidate who is about to walk into an interview believing it.
 * That asymmetry is the gap this closes.
 *
 * ## Why this is not `checkGrounding`
 *
 * A requirement is a phrase lifted from a document, so token coverage is the right test. A brief
 * is a *summary* — it rewords by design, and demanding 60% token overlap from prose would flag
 * every competent sentence in it. So this looks only at the parts of a sentence that cannot be
 * reworded and that a reader would act on:
 *
 * - **Names.** Proper nouns and technology names. "Kafka", "PostgreSQL", "Series C", "Stripe".
 * - **Numbers.** Amounts, years, counts, percentages.
 *
 * Those are what a model fabricates when it is filling a gap, and they are what a candidate
 * would prepare against. A sentence that reworded "we help marketplaces move money" into "they
 * build payment infrastructure" carries no name and no number, and is correctly ignored.
 *
 * ## Nothing is removed
 *
 * The count and a sample go on the span, and the caller decides. Dropping a sentence from a
 * summary is a far blunter instrument than dropping one requirement from a list — the prose
 * around it stops making sense — and a false positive would silently delete a true statement.
 * Recording it makes the check safe to run everywhere, including over question text, where a
 * false positive costs a number in a trace rather than a question the user wanted.
 */

export type ClaimKind = "number" | "name";

export interface Claim {
  /** As it appeared, so a trace attribute is readable rather than a normalised stub. */
  text: string;
  kind: ClaimKind;
}

export interface ClaimCheck {
  /** How many checkable claims the prose made at all. Zero is the ordinary case for a thin kit. */
  checked: number;
  unsupported: Claim[];
}

/**
 * Words that open a sentence and are not names.
 *
 * Sentence-initial capitalisation is the one false positive worth engineering against, because
 * every sentence has one and the noise would swamp the signal. A token is only taken as a name
 * when it is capitalised somewhere other than the start of a sentence — or when its shape says
 * so outright, like `PostgreSQL` or `S3`.
 */
const SENTENCE_SPLIT = /(?<=[.!?])\s+/;

/** Internal capital or digit: `PostgreSQL`, `GraphQL`, `S3`, `Node.js`. Shape alone is enough. */
const SELF_EVIDENT_NAME = /^[A-Za-z][A-Za-z.]*(?:[A-Z0-9])/;

/**
 * Ordinary words, for deciding what a capital at the start of a sentence means.
 *
 * This list is the whole difficulty of the check. Every sentence capitalises its first word, so
 * taking those at face value flags "Payments", "Marketplaces" and "Settlement" in prose that
 * invented nothing. Skipping them all was the first attempt and it has a hole an eval case found
 * immediately: `Redis is used for caching.` is a fabricated technology sitting in the one
 * position the check refused to look at, and a brief is mostly sentences that open with a proper
 * noun.
 *
 * So a sentence-initial capital is a name unless the word is ordinary English. Everything here
 * is a word with no informational content about a specific employer; a technology or a company
 * name is exactly what must fall through.
 */
const COMMON = new Set([
  // determiners, pronouns, conjunctions, prepositions
  "a", "an", "the", "this", "that", "these", "those", "their", "theirs", "its", "his", "her",
  "our", "your", "my", "they", "it", "he", "she", "we", "you", "i", "there", "here", "both",
  "each", "every", "all", "any", "some", "most", "much", "many", "few", "several", "other",
  "another", "such", "no", "none", "neither", "either", "and", "or", "but", "so", "yet", "for",
  "nor", "if", "when", "while", "although", "though", "because", "since", "unless", "until",
  "after", "before", "during", "in", "on", "at", "by", "with", "without", "from", "to", "into",
  "onto", "over", "under", "across", "through", "between", "among", "about", "against", "as",
  "like", "per", "via", "up", "down", "out", "off", "than", "then", "also", "however",
  "therefore", "instead", "rather", "still", "already", "only", "just", "even", "not",
  // auxiliaries and very common verbs
  "is", "are", "was", "were", "be", "been", "being", "has", "have", "had", "having", "do",
  "does", "did", "doing", "will", "would", "can", "could", "may", "might", "must", "should",
  "shall", "let", "get", "gets", "got", "make", "makes", "made", "take", "takes", "taken",
  "use", "uses", "used", "using", "build", "builds", "built", "run", "runs", "ran", "running",
  "work", "works", "worked", "working", "help", "helps", "helped", "give", "gives", "given",
  "see", "sees", "seen", "know", "knows", "known", "expect", "expects", "expected", "look",
  "looks", "looking", "based", "founded", "focused", "known",
  // ordinary business and product vocabulary that opens sentences
  "candidates", "candidate", "customers", "customer", "clients", "client", "users", "user",
  "teams", "team", "engineers", "engineer", "developers", "developer", "companies", "company",
  "employees", "people", "staff", "roles", "role", "jobs", "job", "positions", "position",
  "products", "product", "services", "service", "platforms", "platform", "systems", "system",
  "payments", "payment", "marketplaces", "marketplace", "settlement", "settlements",
  "interviews", "interview", "interviewing", "hiring", "recruiters", "recruiting", "process",
  "processes", "applications", "application", "engineering", "operations", "support", "sales",
  "marketing", "finance", "security", "data", "software", "hardware", "infrastructure",
  "technology", "technologies", "tools", "tooling", "code", "codebase", "documentation",
  "experience", "requirements", "responsibilities", "skills", "questions", "answers",
  "founded", "headquartered", "offices", "office", "remote", "hybrid", "onsite",
  // Interrogative and imperative openers. A brief is declarative prose; a question is neither,
  // and the first pass over a real run flagged "Walk", "What" and "Tell" as invented names —
  // which is the noise this whole list exists to prevent, arriving from the mood the sentence
  // is in rather than from anything the model made up.
  "what", "how", "why", "when", "where", "who", "whom", "whose", "which",
  "walk", "describe", "tell", "explain", "give", "outline", "discuss", "design", "sketch",
  "imagine", "suppose", "consider", "compare", "contrast", "pick", "choose", "name", "list",
  "think", "talk", "share", "say", "show", "argue", "defend", "justify", "assume", "start",
  "mention", "mentions", "mentioned", "note", "notes", "noted", "cover", "covers", "covered",
  "include", "includes", "including", "identify", "explore", "propose", "suggest", "recall",
]);

const WORD = /[A-Za-z][A-Za-z0-9+#.\-/]*/g;
/** Two digits or more, or any digit carrying a unit. `5` alone is noise; `2014` and `2bn` are not. */
const NUMBER = /\d[\d,.]*\s*(?:%|bn|billion|m(?:illion)?|k|thousand|\+)?/gi;

/**
 * Trailing punctuation a word regex cannot help swallowing.
 *
 * `Node.js` needs the inner dot, so the pattern has to allow one — which means `PostgreSQL.` at
 * the end of a sentence comes back with the full stop attached and matches nothing in the
 * sources. Stripping only from the end keeps both cases right.
 */
function trimEdges(token: string): string {
  return token.replace(/[.,;:/\-]+$/, "");
}

/**
 * Capitalised words that are not claims about this company.
 *
 * Generic vocabulary that appears capitalised in ordinary technical and business prose. A check
 * that flags "API" on a page that happens not to use the word is a check whose number nobody
 * reads — and this module's whole argument is that a noisy signal is worse than none. Kept
 * deliberately short: these are terms with no informational content about a specific employer,
 * not a list of technologies, because a technology is exactly what we want to catch.
 */
const GENERIC = new Set([
  "api", "apis", "sdk", "ui", "ux", "ai", "ml", "saas", "paas", "b2b", "b2c", "crm", "erp",
  "ceo", "cto", "coo", "cfo", "vp", "hr", "it", "qa", "rd",
  "eu", "uk", "us", "usa", "emea", "apac",
]);

export function normalise(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

function tokensOf(text: string): Set<string> {
  return new Set(normalise(text).match(WORD) ?? []);
}

/**
 * Claims in `prose` that nothing in `sources` supports.
 *
 * `allowed` is for the things the model was told rather than shown — the company name and the
 * role title reach the prompt as arguments, not as a retrieved page, so a brief that says the
 * company's own name is not inventing anything.
 */
export function checkClaims(
  prose: string,
  sources: readonly string[],
  allowed: readonly string[] = [],
): ClaimCheck {
  const supportedTokens = tokensOf([...sources, ...allowed].join(" "));
  const supportedText = normalise([...sources, ...allowed].join(" "));

  const claims = new Map<string, Claim>();
  for (const claim of claimsIn(prose)) {
    // Keyed by the normalised form: a brief that names Kafka three times made one claim.
    claims.set(`${claim.kind}:${normalise(claim.text)}`, claim);
  }

  const unsupported: Claim[] = [];
  for (const claim of claims.values()) {
    const supported =
      claim.kind === "name"
        ? supportedTokens.has(normalise(claim.text))
        : supportedText.includes(normalise(claim.text).replace(/,/g, ""));
    if (!supported) unsupported.push(claim);
  }

  return { checked: claims.size, unsupported };
}

/** Every checkable claim in a piece of prose, in the order it makes them. */
export function claimsIn(prose: string): Claim[] {
  const found: Claim[] = [];

  for (const sentence of prose.split(SENTENCE_SPLIT)) {
    const words = [...sentence.matchAll(WORD)];
    words.forEach((match, index) => {
      const word = trimEdges(match[0]);
      if (!/^[A-Z]/.test(word)) return;
      // A single capital is an initial or a list marker, not a claim.
      if (word.length < 2) return;
      const lower = word.toLowerCase();
      if (GENERIC.has(lower)) return;
      // The first word of a sentence is capitalised because it is first — so it counts as a name
      // only when it is not ordinary English, or when its shape settles the question outright.
      if (index === 0 && COMMON.has(lower) && !SELF_EVIDENT_NAME.test(word)) return;
      found.push({ text: word, kind: "name" });
    });
  }

  for (const match of prose.matchAll(NUMBER)) {
    const text = trimEdges(match[0].trim());
    if (text === "") continue;
    const digits = text.replace(/[^\d]/g, "");
    // One digit and no unit is noise — "5 years" is carried by the word beside it, and "5"
    // appears in almost any page.
    if (digits.length < 2 && /^\d$/.test(text)) continue;
    found.push({ text, kind: "number" });
  }

  return found;
}
