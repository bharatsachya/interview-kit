import type { QuestionDraft } from "./questions";

/**
 * The questions every engineering interview can ask, whether or not the posting mentions them.
 *
 * Everything else in this package is grounded in the posting: extraction finds requirements, the
 * categories are seeded from them, and coverage checks each one is asked about. That is correct
 * and it has a hole. Data structures and algorithms are screened for in a large share of
 * engineering interviews and named in almost none of the postings — so a kit built only from
 * what the advert says leaves a candidate unprepared for the round they are most likely to face.
 *
 * ## Why this does not break the grounding rule
 *
 * It looks like an exception to "nothing is invented" and it is not. That rule is about **claims
 * about the employer**: an invented requirement, a fabricated funding round, a tech stack nobody
 * published. It is not about what a candidate should practise.
 *
 * Nothing here asserts anything about the company. Each question carries `requirementIds: []`,
 * which is the honest statement that it covers no stated requirement, and `origin:
 * "fundamentals"`, which says in the document where it came from. Coverage ignores them for
 * exactly that reason — they cannot close a gap, because they were never about one.
 *
 * ## Written in code, not by a model
 *
 * Same argument as the schedule and the fallback questions. This is a known, stable body of
 * material; a model asked for "five DSA questions" returns five of these with worse wording, at
 * the cost of a request against a free tier with a daily cap. Deterministic also means the set
 * is reviewable — which matters, because unlike every other question in the kit there is no
 * posting to check these against.
 *
 * ## Only where they belong
 *
 * A role with no technical requirements and a non-engineering title gets none. A recruiter
 * preparing for a content role does not need to be asked about hash maps, and a kit that asked
 * would be worse than one that did not.
 */

/** Titles that mean somebody writes code. Matched loosely — "Senior Backend Engineer II". */
const ENGINEERING_TITLE =
  /\b(engineer|developer|programmer|sde|swe|architect|scientist|ml|ai|data|backend|back-end|frontend|front-end|full[\s-]?stack|platform|infrastructure|devops|sre|mobile|ios|android)\b/i;

export interface FundamentalsInput {
  roleTitle: string;
  /** Requirement texts, used to decide whether this is a coding role and which slant to take. */
  requirements: readonly string[];
}

/**
 * Which flavour of the applied question to ask.
 *
 * One question of the five changes; the other four are the same for everyone, because complexity
 * and the core structures do not differ by stack. Guessing harder than this would be inventing a
 * specialism from a job title.
 */
type Track = "data" | "frontend" | "general";

function trackFor(input: FundamentalsInput): Track {
  const haystack = `${input.roleTitle} ${input.requirements.join(" ")}`.toLowerCase();
  if (/\b(ml|machine learning|ai|data scien|data engineer|pipeline|etl|pandas|spark|nlp)\b/.test(haystack)) return "data";
  if (/\b(frontend|front-end|react|vue|angular|ui engineer|web developer)\b/.test(haystack)) return "frontend";
  return "general";
}

const APPLIED: Readonly<Record<Track, QuestionDraft>> = {
  general: draft(
    "Design a rate limiter that allows N requests per user per minute. What data structure holds the state, and what happens when the process restarts?",
    "A sliding window or token bucket per key; a hash map of user → counter with timestamps; the trade between a fixed window (cheap, bursty at the boundary) and a sliding log (exact, more memory). Restart means the state was in memory — name where it would actually live.",
    3,
  ),
  data: draft(
    "You have a stream of events too large to hold in memory and need the top ten most frequent keys. How do you do it?",
    "A count-min sketch or a bounded min-heap of size ten alongside a counter map; why an exact answer needs space proportional to distinct keys; what accuracy you are trading away and whether that is acceptable here.",
    3,
  ),
  frontend: draft(
    "You need to render a list of fifty thousand rows without the page becoming unusable. What do you do?",
    "Windowing — render only what is visible plus a buffer; keys stable across renders so the diff is cheap; why pagination and virtualisation solve different problems; measuring before optimising.",
    3,
  ),
};

/** The four that do not vary. Ordered roughly easiest first, which is how they should be read. */
const CORE: readonly QuestionDraft[] = [
  draft(
    "Given an array of integers, find two that sum to a target. Walk through your approach and its complexity.",
    "The nested loop at O(n²), then the hash map at O(n) time and O(n) space; state what the map holds and why one pass is enough. The point is naming the trade, not reaching the answer.",
    1,
  ),
  draft(
    "What is the difference between an array and a linked list, and when would you reach for each?",
    "Contiguous memory and O(1) indexing against O(1) insertion at a known node; cache locality, which is the part most answers miss; the honest answer that an array is almost always right in practice.",
    1,
  ),
  draft(
    "Explain how a hash map works, and what happens when two keys collide.",
    "Hashing to a bucket, chaining or open addressing, load factor and resizing; why the average case is O(1) and the worst case is O(n); what a bad hash function costs.",
    2,
  ),
  draft(
    "When would you use a tree or a graph rather than a flat collection, and how would you traverse it?",
    "Hierarchy or relationships as the reason; BFS with a queue against DFS with a stack or recursion, and which suits shortest-path against exhaustive search; the visited set, and what happens without one.",
    2,
  ),
];

/**
 * The fundamentals band for this role, or nothing.
 *
 * Returns drafts, not questions: ids are the caller's to mint, the same contract
 * `generateCategoryQuestions` uses, so a fake run stays byte-identical.
 */
export function fundamentalsFor(input: FundamentalsInput): QuestionDraft[] {
  const engineering =
    ENGINEERING_TITLE.test(input.roleTitle) ||
    // A title can be anything — "Member of Technical Staff" — so the requirements get a say.
    input.requirements.length > 0;
  if (!engineering) return [];

  return [...CORE, APPLIED[trackFor(input)]].map((question, index) => ({ ...question, order: index }));
}

function draft(prompt: string, answerOutline: string, difficulty: 1 | 2 | 3): QuestionDraft {
  return {
    category: "technical",
    prompt,
    answerOutline,
    difficulty,
    // Covers no stated requirement, and says so. Coverage reads this and correctly concludes
    // these close no gaps — they were never about one.
    requirementIds: [],
    origin: "fundamentals",
    pinned: false,
    active: true,
    order: 0,
  };
}
