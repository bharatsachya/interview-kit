import { minutesForQuestions } from "@trao/kit";
import type {
  Difficulty,
  InternalFlashcard,
  InternalKit,
  InternalQuestion,
  QuestionCategory,
  Requirement,
} from "@trao/kit";

/**
 * A complete, realistic kit, used until the pipeline is wired to the UI.
 *
 * It is the real `InternalKit` — not a UI-shaped mock — so every screen is built against the
 * shape the API will actually serve, and swapping the fixture for a fetch is a change of one
 * function. It is deliberately awkward in the places the product has to handle honestly: two
 * must-haves have no question and are reported as gaps, one question is hand-written and one
 * is edited and pinned, the brief has recorded gaps of its own, and four days is short enough
 * that front-loading is visible.
 */

const REQUIREMENTS: Requirement[] = [
  { id: "REQ-01", text: "Design and operate high-throughput payment APIs", kind: "technical", priority: "must" },
  { id: "REQ-02", text: "Build idempotent, retry-safe payment endpoints", kind: "technical", priority: "must" },
  { id: "REQ-03", text: "Ledger design and double-entry accounting", kind: "domain", priority: "must" },
  { id: "REQ-04", text: "Diagnose and cut latency on read-heavy services", kind: "technical", priority: "must" },
  { id: "REQ-05", text: "Five years of backend engineering in production systems", kind: "technical", priority: "must" },
  { id: "REQ-06", text: "PostgreSQL at scale", kind: "technical", priority: "must" },
  { id: "REQ-07", text: "Schema migrations without downtime", kind: "technical", priority: "must" },
  { id: "REQ-08", text: "Own incidents end to end, including the rollback call", kind: "behavioural", priority: "must" },
  { id: "REQ-09", text: "Work alongside compliance and finance partners", kind: "behavioural", priority: "must" },
  { id: "REQ-10", text: "Payments or fintech domain experience", kind: "domain", priority: "must" },
  { id: "REQ-11", text: "Write and review technical design documents", kind: "behavioural", priority: "must" },
  { id: "REQ-12", text: "Mentor junior engineers", kind: "behavioural", priority: "must" },
  { id: "REQ-13", text: "Kafka or another event streaming platform", kind: "technical", priority: "nice" },
  { id: "REQ-14", text: "Go", kind: "technical", priority: "nice" },
  { id: "REQ-15", text: "Card network integrations", kind: "domain", priority: "nice" },
  { id: "REQ-16", text: "Conference speaking", kind: "behavioural", priority: "nice" },
];

type QuestionSeed = {
  id: string;
  category: QuestionCategory;
  prompt: string;
  /** Bullets, never prose blocks — the design system's own rule for answer outlines. */
  outline: string[];
  difficulty: Difficulty;
  requirementIds: string[];
  origin?: InternalQuestion["origin"];
  pinned?: boolean;
};

const QUESTION_SEEDS: QuestionSeed[] = [
  {
    id: "q_tech_1",
    category: "technical",
    prompt: "Walk me through cutting a 400 ms p95 on a read-heavy endpoint.",
    outline: [
      "Trace first — find the dominant span before touching anything",
      "Cache the read path; name the invalidation rule",
      "Say what you would measure to know it worked",
    ],
    difficulty: 2,
    requirementIds: ["REQ-01", "REQ-04"],
  },
  {
    id: "q_tech_2",
    category: "technical",
    prompt: "What makes a payment endpoint idempotent, and where does the key live?",
    outline: [
      "Client-supplied key, stored with the result, not just with the request",
      "Uniqueness enforced in the database, not in application code",
      "Decide what a replay with a different body should do",
    ],
    difficulty: 2,
    requirementIds: ["REQ-02"],
  },
  {
    id: "q_tech_3",
    category: "technical",
    prompt: "How do you add a NOT NULL column to a hot Postgres table with no downtime?",
    outline: [
      "Add nullable, backfill in batches, then add the constraint NOT VALID and validate",
      "Watch lock queues — a brief ACCESS EXCLUSIVE behind a long read stalls everything",
      "Name the abort condition before you start",
    ],
    difficulty: 3,
    requirementIds: ["REQ-06", "REQ-07"],
  },
  {
    id: "q_tech_4",
    category: "technical",
    prompt: "A reconciliation job double-counted a day of settlements. How do you find out why?",
    outline: [
      "Reproduce from the ledger, not from the report",
      "Look for a retry without an idempotency key before blaming the maths",
      "Fix forward or replay? Say which and why",
    ],
    difficulty: 3,
    requirementIds: ["REQ-03", "REQ-10"],
  },
  {
    id: "q_tech_5",
    category: "technical",
    prompt: "When would you reach for Kafka here, and when would you not?",
    outline: [
      "Fan-out and replay are the reasons; queueing alone is not",
      "Ordering guarantees are per-partition — say what you key on",
      "The cost is operational, and it is permanent",
    ],
    difficulty: 2,
    requirementIds: ["REQ-13"],
  },
  {
    id: "q_tech_6",
    category: "technical",
    prompt: "Describe how you would test a refund flow you cannot run against the card network.",
    outline: [
      "Contract tests against a recorded fixture of the network's responses",
      "Separate the money-moving decision from the transport so the decision is unit-testable",
      "One end-to-end path in a sandbox, not twenty",
    ],
    difficulty: 1,
    requirementIds: ["REQ-15"],
    origin: "manual",
  },
  {
    id: "q_sys_1",
    category: "system-design",
    prompt: "How would you migrate a live ledger table to a new schema without taking write traffic down?",
    outline: [
      "Dual-write behind a flag, backfill in batches",
      "Shadow-read and compare before cutting over",
      "Name the rollback: what makes you stop",
    ],
    difficulty: 3,
    requirementIds: ["REQ-03", "REQ-07"],
  },
  {
    id: "q_sys_2",
    category: "system-design",
    prompt: "Design the ledger behind a wallet that supports holds, captures and partial refunds.",
    outline: [
      "Double-entry, append-only; balance is a projection, never a stored mutable number",
      "A hold is an entry against an available balance, not a lock",
      "Say where you enforce that the books balance",
    ],
    difficulty: 3,
    requirementIds: ["REQ-03", "REQ-10"],
  },
  {
    id: "q_sys_3",
    category: "system-design",
    prompt: "Payments must not be lost when the downstream processor is down for an hour. Design for that.",
    outline: [
      "Accept and durably record before you call anyone",
      "Retry with backoff plus an idempotency key so a replay is safe",
      "Decide what the customer sees while it is pending",
    ],
    difficulty: 2,
    requirementIds: ["REQ-01", "REQ-02"],
  },
  {
    id: "q_sys_4",
    category: "system-design",
    prompt: "How would you shard a payments database that has outgrown one primary?",
    outline: [
      "Shard by the entity you always read together — usually the account",
      "Cross-shard transactions are the cost; name which ones you will have",
      "How the ledger stays reconcilable across shards",
    ],
    difficulty: 3,
    requirementIds: ["REQ-01", "REQ-06"],
  },
  {
    id: "q_beh_1",
    category: "behavioural",
    prompt: "Tell me about a rollback you owned end to end.",
    outline: [
      "What the signal was, and how long it took you to trust it",
      "The call you made and who you told",
      "What you changed afterwards so the next one was cheaper",
    ],
    difficulty: 2,
    requirementIds: ["REQ-08"],
    origin: "edited",
    pinned: true,
  },
  {
    id: "q_beh_3",
    category: "behavioural",
    prompt: "Tell me about a production incident where you were wrong about the cause at first.",
    outline: [
      "The first hypothesis and why it was reasonable",
      "What made you drop it",
      "The cost of the detour, stated plainly",
    ],
    difficulty: 2,
    requirementIds: ["REQ-08", "REQ-05"],
  },
  {
    id: "q_beh_4",
    category: "behavioural",
    prompt: "How do you get a junior engineer from reviewing code to designing a service?",
    outline: [
      "Hand over a decision, not a task",
      "Review the reasoning in writing, before the code",
      "Say how you knew it had worked",
    ],
    difficulty: 1,
    requirementIds: ["REQ-12"],
    // The question the gap-fill pass produced: the first generation pass left REQ-12 uncovered.
    // `fallback` rather than `generated`, so a regeneration of behavioural can replace it and
    // the provenance says where it came from.
    origin: "fallback",
  },
  {
    id: "q_fit_1",
    category: "company-fit",
    prompt: "Vaultline publishes an uptime and incident report every month. Why would a payments company do that, and what would you want in it?",
    outline: [
      "Trust is the product when you hold other people's money",
      "Incidents named, not summarised into a percentage",
      "What you would add: near-misses",
    ],
    difficulty: 1,
    requirementIds: ["REQ-10"],
  },
  {
    id: "q_fit_2",
    category: "company-fit",
    prompt: "The engineering blog describes moving from a monolith to two services in four years. What does that pace tell you?",
    outline: [
      "Deliberate, not slow — splits are paid for in operational cost",
      "Ask what forced each split",
      "Where you would push to keep things together",
    ],
    difficulty: 1,
    requirementIds: ["REQ-05"],
  },
];

const FLASHCARD_SEEDS: { front: string; back: string; requirementIds: string[]; questionId: string | null }[] = [
  {
    front: "What makes a payment endpoint idempotent?",
    back: "A client-supplied key, stored with the result, so a retry returns the first outcome instead of charging twice.",
    requirementIds: ["REQ-02"],
    questionId: "q_tech_2",
  },
  {
    front: "Where is an idempotency key's uniqueness enforced?",
    back: "In the database, as a unique constraint. Application-level checks race under concurrency.",
    requirementIds: ["REQ-02"],
    questionId: "q_tech_2",
  },
  {
    front: "Order of operations for adding a NOT NULL column to a hot table",
    back: "Add nullable → backfill in batches → add the constraint NOT VALID → VALIDATE. Never one blocking ALTER.",
    requirementIds: ["REQ-06", "REQ-07"],
    questionId: "q_tech_3",
  },
  {
    front: "First move when p95 latency jumps",
    back: "Read a trace and find the dominant span. Optimising before measuring is guessing.",
    requirementIds: ["REQ-04"],
    questionId: "q_tech_1",
  },
  {
    front: "Why is a balance a projection rather than a column?",
    back: "An append-only double-entry ledger can be recomputed and audited; a mutable number can only be trusted.",
    requirementIds: ["REQ-03"],
    questionId: "q_sys_2",
  },
  {
    front: "What is a hold, in ledger terms?",
    back: "An entry reducing the available balance without moving settled funds — not a lock on a row.",
    requirementIds: ["REQ-03"],
    questionId: "q_sys_2",
  },
  {
    front: "The four steps of a zero-downtime table migration",
    back: "Dual-write behind a flag, backfill in batches, shadow-read and compare, then cut over — with a named abort condition.",
    requirementIds: ["REQ-07"],
    questionId: "q_sys_1",
  },
  {
    front: "When does Kafka earn its operational cost?",
    back: "Fan-out to several consumers, and replay. If you only need a queue, you only need a queue.",
    requirementIds: ["REQ-13"],
    questionId: "q_tech_5",
  },
  {
    front: "What does Kafka guarantee about ordering?",
    back: "Ordering within a partition only — so the partition key is the design decision.",
    requirementIds: ["REQ-13"],
    questionId: "q_tech_5",
  },
  {
    front: "Durability rule when calling a downstream processor",
    back: "Record the intent durably before the call, so a crash mid-flight is recoverable rather than invisible.",
    requirementIds: ["REQ-01", "REQ-02"],
    questionId: "q_sys_3",
  },
  {
    front: "Natural shard key for a payments database",
    back: "The account — the entity almost every read already groups by. The cost is cross-account transactions.",
    requirementIds: ["REQ-01", "REQ-06"],
    questionId: "q_sys_4",
  },
  {
    front: "Before blaming reconciliation maths, check…",
    back: "Whether a retry ran without an idempotency key. Double-counting is usually a replay, not arithmetic.",
    requirementIds: ["REQ-03", "REQ-10"],
    questionId: "q_tech_4",
  },
  {
    front: "Structure for a rollback story",
    back: "The signal, the call and who you told, then the change that made the next one cheaper.",
    requirementIds: ["REQ-08"],
    questionId: "q_beh_1",
  },
  {
    front: "What makes an incident story credible?",
    back: "Naming the first hypothesis you got wrong, and what made you drop it.",
    requirementIds: ["REQ-08"],
    questionId: "q_beh_3",
  },
  {
    front: "How to hand mentoring off in an interview answer",
    back: "You handed over a decision rather than a task, reviewed the reasoning in writing, and can say how you knew it worked.",
    requirementIds: ["REQ-12"],
    questionId: "q_beh_4",
  },
  {
    front: "Testing a flow you cannot run against the real card network",
    back: "Contract tests over recorded responses, the money decision split from the transport, and one sandbox path end to end.",
    requirementIds: ["REQ-15"],
    questionId: "q_tech_6",
  },
];

function buildQuestions(): InternalQuestion[] {
  const perCategory = new Map<QuestionCategory, number>();

  return QUESTION_SEEDS.map((seed) => {
    const order = perCategory.get(seed.category) ?? 0;
    perCategory.set(seed.category, order + 1);

    return {
      id: seed.id,
      category: seed.category,
      prompt: seed.prompt,
      answerOutline: seed.outline.join("\n"),
      difficulty: seed.difficulty,
      requirementIds: seed.requirementIds,
      origin: seed.origin ?? "generated",
      pinned: seed.pinned ?? false,
      active: true,
      order,
    };
  });
}

function buildFlashcards(): InternalFlashcard[] {
  return FLASHCARD_SEEDS.map((seed, index) => ({
    id: `fc_${String(index + 1).padStart(2, "0")}`,
    front: seed.front,
    back: seed.back,
    requirementIds: seed.requirementIds,
    questionId: seed.questionId,
    origin: "generated",
    pinned: false,
    active: true,
    order: index,
  }));
}

/**
 * Four days, front-loaded: the hardest material lands first, so a day lost at the end costs
 * less than a day lost at the start. Minutes are summed from the questions actually in the
 * block via the shared table — never typed by hand, or the day and its contents could drift.
 */
function buildSchedule(questions: InternalQuestion[]) {
  const byId = new Map(questions.map((q) => [q.id, q]));
  const plan: { focus: string; questionIds: string[] }[] = [
    { focus: "Ledger design and idempotency", questionIds: ["q_sys_1", "q_sys_2", "q_tech_2"] },
    { focus: "Migrations and scale", questionIds: ["q_tech_3", "q_sys_4", "q_tech_4"] },
    { focus: "Latency, events and behavioural stories", questionIds: ["q_tech_1", "q_tech_5", "q_beh_1", "q_beh_3"] },
    { focus: "Company fit and the lighter cards", questionIds: ["q_fit_1", "q_fit_2", "q_beh_4", "q_tech_6"] },
  ];

  return {
    daysAvailable: plan.length,
    days: plan.map((day, index) => ({
      day: index + 1,
      focus: day.focus,
      questionIds: day.questionIds,
      minutes: minutesForQuestions(day.questionIds.map((id) => byId.get(id)).filter((q) => q !== undefined)),
      edited: false,
    })),
  };
}

export function fixtureKit(): InternalKit {
  const questions = buildQuestions();

  return {
    id: "kit_vaultline_be_payments",
    createdAt: Date.UTC(2026, 8, 8, 9, 14, 0),
    role: {
      title: "Senior Backend Engineer, Payments",
      company: "Vaultline",
      location: "London (hybrid, 2 days on-site)",
      summary:
        "Owns the services that move money: the payments API, the ledger behind it, and the reconciliation that proves the two agree. The posting is unusually specific about idempotency and about migrating live tables, and it asks for someone who will write the design document and then defend it.",
      responsibilities: [
        "Own the payments API and the double-entry ledger behind it",
        "Run the reconciliation that proves the API and the ledger agree",
        "Migrate live payment tables without taking the service down",
        "Write the design document for each change and defend it in review",
      ],
    },
    companyBrief: {
      summary:
        "Vaultline is a payments infrastructure company selling a ledger-and-payouts API to marketplaces. Roughly 180 people, Series B, London and Lisbon.",
      whatTheyDo:
        "One API for holding, splitting and paying out marketplace funds, with the double-entry ledger exposed to the customer rather than hidden. Their pitch is auditability: every balance is derivable from entries the customer can read.",
      hiringProcess:
        "Their careers page describes four stages: a 45-minute call, a 90-minute technical pairing session on a real service, a system design round focused on ledgers, and a values conversation. They say explicitly that there is no take-home and no algorithm puzzle.",
      sources: [
        "https://vaultline.example/careers",
        "https://vaultline.example/careers/engineering",
        "https://vaultline.example/blog/why-our-ledger-is-public",
        "https://vaultline.example/about",
      ],
      pagesUsed: ["https://vaultline.example/careers/engineering", "https://vaultline.example/blog/why-our-ledger-is-public"],
      gaps: [
        "No public discussion of the interview process was found beyond the careers page — the search provider returned nothing for this company.",
        "Team size for the payments group is not stated anywhere public.",
      ],
      edited: false,
    },
    requirements: REQUIREMENTS,
    questions,
    flashcards: buildFlashcards(),
    schedule: buildSchedule(questions),
    coverage: {
      passes: 2,
      // Genuinely uncovered: no active question lists these ids. Two must-haves the model
      // never reached and two nice-to-haves. They are reported rather than papered over — a
      // question invented to close a gap is worse than an admitted gap.
      uncoveredRequirementIds: ["REQ-09", "REQ-11", "REQ-14", "REQ-16"],
    },
  };
}
