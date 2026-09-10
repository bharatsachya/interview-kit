/**
 * Shared harness for the step evals: assertion recording, text matching, and the small
 * builders that turn a case's plain JSON into the internal shapes the packages expect.
 *
 * Kept separate from run-step.ts so the per-step adapters read as assertions rather than as
 * plumbing.
 */

export interface Assertion {
  name: string;
  pass: boolean;
  detail?: string;
}

export class Checks {
  readonly list: Assertion[] = [];

  ok(name: string, pass: boolean, detail?: string): boolean {
    this.list.push(detail === undefined ? { name, pass } : { name, pass, detail });
    return pass;
  }

  eq(name: string, actual: unknown, expected: unknown): boolean {
    const pass = JSON.stringify(actual) === JSON.stringify(expected);
    return this.ok(name, pass, pass ? undefined : `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }

  /** Order-insensitive array equality. */
  sameSet(name: string, actual: readonly string[], expected: readonly string[]): boolean {
    return this.eq(name, [...actual].sort(), [...expected].sort());
  }

  get passed(): boolean {
    return this.list.every((a) => a.pass);
  }

  get firstFailure(): string | undefined {
    const failure = this.list.find((a) => !a.pass);
    if (failure === undefined) return undefined;
    return failure.detail === undefined ? failure.name : `${failure.name} — ${failure.detail}`;
  }
}

// ── Text matching ────────────────────────────────────────────────────────────────────────

export function normalise(text: string): string {
  return text
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[^a-z0-9'+]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

export function tokens(text: string): string[] {
  return normalise(text).split(" ").filter(Boolean);
}

export function jaccard(a: string, b: string): number {
  const left = new Set(tokens(a));
  const right = new Set(tokens(b));
  if (left.size === 0 || right.size === 0) return 0;
  let shared = 0;
  for (const token of left) if (right.has(token)) shared += 1;
  return shared / (left.size + right.size - shared);
}

/** Requirement matching, exactly as RUNNER_PROMPT.md specifies it. */
export function requirementMatches(gold: string, candidate: string): boolean {
  const g = normalise(gold);
  const c = normalise(candidate);
  if (g.length === 0 || c.length === 0) return false;
  if (g.includes(c) || c.includes(g)) return true;
  return jaccard(gold, candidate) >= 0.6;
}

/**
 * Greedy one-to-one assignment: each gold requirement may claim at most one extracted
 * requirement, best match first, so two golds cannot both be satisfied by the same output.
 */
export function assignMatches<G extends { text: string }, E extends { text: string }>(
  gold: readonly G[],
  extracted: readonly E[],
): Map<G, E | null> {
  const taken = new Set<E>();
  const result = new Map<G, E | null>();

  for (const g of gold) {
    let best: E | null = null;
    let bestScore = -1;
    for (const e of extracted) {
      if (taken.has(e)) continue;
      if (!requirementMatches(g.text, e.text)) continue;
      const score = jaccard(g.text, e.text) + (normalise(e.text) === normalise(g.text) ? 1 : 0);
      if (score > bestScore) {
        best = e;
        bestScore = score;
      }
    }
    if (best !== null) taken.add(best);
    result.set(g, best);
  }
  return result;
}

// ── Internal-shape builders ──────────────────────────────────────────────────────────────

export interface RawQuestion {
  id: string;
  category?: string;
  prompt?: string;
  answer_outline?: string;
  difficulty?: number;
  requirement_ids?: string[];
  active?: boolean;
  origin?: string;
  pinned?: boolean;
}

/** A case's plain question object as an InternalQuestion. */
export function toInternalQuestion(raw: RawQuestion, order = 0): Record<string, unknown> {
  return {
    id: raw.id,
    category: raw.category ?? "technical",
    prompt: raw.prompt ?? "",
    answerOutline: raw.answer_outline ?? "",
    difficulty: (raw.difficulty ?? 2) as 1 | 2 | 3,
    requirementIds: [...(raw.requirement_ids ?? [])],
    origin: raw.origin ?? "generated",
    pinned: raw.pinned ?? false,
    active: raw.active ?? true,
    order,
  };
}

export interface RawRequirement {
  id: string;
  text: string;
  kind?: string;
  priority?: string;
  source_span?: string;
}

export function toRequirement(raw: RawRequirement): Record<string, unknown> {
  return {
    id: raw.id,
    text: raw.text,
    kind: raw.kind ?? "technical",
    priority: raw.priority ?? "must",
    ...(raw.source_span !== undefined ? { sourceSpan: raw.source_span } : {}),
  };
}
