import type { RequirementKind, RequirementPriority } from "@trao/kit";
import { MIN_SPAN_CONFIDENCE, type JdSpan } from "./spans";
import { contentTokens } from "./text";

/**
 * Example lists collapse to one requirement.
 *
 * A live run on a 1,800-character posting returned twenty requirements, six of which were
 * "Gmail", "Drive", "Slack", "WhatsApp", "Telegram" and "iMessage" — the products the *company's*
 * product connects to, listed in two sentences describing what the role builds. Six study
 * requirements for one need, and the schedule then spent six days on them.
 *
 * The prompt now says not to do this. That is not enough: a prompt rule is a request, and the
 * failure is cheap to detect afterwards. If several requirements trace back to the same sentence
 * and are bare names rather than stated needs, they are one requirement whose text is that
 * sentence — which still contains every name, so nothing is lost.
 *
 * Deliberately narrow. Two *stated* requirements from one sentence ("designing distributed
 * systems and mentoring the people who run them") are genuinely two, and are left alone.
 */

/** More content words than this and it is a stated requirement, not an item in a list. */
export const MAX_BARE_NAME_TOKENS = 2;

/**
 * Words that turn a short phrase into a claim about the candidate.
 *
 * "Kafka" is an item in a list. "Kafka experience" is a requirement, and merging it into its
 * neighbours would destroy a real one.
 */
const STATED =
  /\b(experience|experienced|years?|yrs?|ability|able|background|knowledge|familiar\w*|proficien\w*|expert\w*|fluen\w*|comfortable|strong|deep|solid|know\w*|understand\w*|build\w*|ship\w*|design\w*|mentor\w*|own\w*|writ\w*|speak\w*|manag\w*|lead\w*|degree|track record)\b/i;

/** A bare product or technology name, as opposed to something asked of the candidate. */
export function isBareName(text: string): boolean {
  const tokens = contentTokens(text);
  if (tokens.length === 0 || tokens.length > MAX_BARE_NAME_TOKENS) return false;
  return !STATED.test(text);
}

export interface SpannedCandidate {
  text: string;
  kind: RequirementKind;
  priority: RequirementPriority;
  span: JdSpan;
  spanScore: number;
}

/** What was merged away, for the trace. The names survive inside `into`. */
export interface MergedGroup {
  into: string;
  from: string[];
}

export interface CollapseResult {
  kept: SpannedCandidate[];
  merged: MergedGroup[];
}

export function collapseExampleLists(candidates: readonly SpannedCandidate[]): CollapseResult {
  const groups = new Map<string, SpannedCandidate[]>();
  for (const candidate of candidates) {
    const key = candidate.span.text;
    const existing = groups.get(key);
    if (existing === undefined) groups.set(key, [candidate]);
    else existing.push(candidate);
  }

  const merged: MergedGroup[] = [];
  const replacements = new Map<string, SpannedCandidate>();

  for (const [spanText, group] of groups) {
    // Only a confident match is evidence that these came from the same sentence.
    const names = group.filter((c) => c.spanScore >= MIN_SPAN_CONFIDENCE && isBareName(c.text));
    if (group.length < 2 || names.length < 2) continue;

    merged.push({ into: spanText, from: group.map((c) => c.text) });
    replacements.set(spanText, {
      text: spanText,
      kind: dominantKind(group),
      // The strictest priority any member carried. Recomputed from the posting's own headings
      // afterwards anyway; this is only the fallback for a sentence under no heading.
      priority: group.some((c) => c.priority === "must") ? "must" : "nice",
      span: (group[0] as SpannedCandidate).span,
      spanScore: 1,
    });
  }

  // Rebuilt in reading order, each collapsed group taking the place of its first member, so the
  // ids assigned afterwards still run down the posting.
  const kept: SpannedCandidate[] = [];
  const emitted = new Set<string>();
  for (const candidate of candidates) {
    const replacement = replacements.get(candidate.span.text);
    if (replacement === undefined) {
      kept.push(candidate);
      continue;
    }
    if (emitted.has(candidate.span.text)) continue;
    emitted.add(candidate.span.text);
    kept.push(replacement);
  }

  return { kept, merged };
}

/** The kind most of the group agreed on; the first member's kind breaks a tie. */
function dominantKind(group: readonly SpannedCandidate[]): RequirementKind {
  const counts = new Map<RequirementKind, number>();
  for (const candidate of group) counts.set(candidate.kind, (counts.get(candidate.kind) ?? 0) + 1);

  let best = (group[0] as SpannedCandidate).kind;
  let bestCount = counts.get(best) ?? 0;
  for (const [kind, count] of counts) {
    if (count > bestCount) {
      best = kind;
      bestCount = count;
    }
  }
  return best;
}
