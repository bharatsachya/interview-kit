import type { Requirement } from "@trao/kit";
import { contentTokens } from "./text";

/**
 * Grouping uncovered requirements into coherent bundles, in code.
 *
 * One question may cover at most three requirements. The code forms the cluster — group by
 * `kind`, then by shared vocabulary — and asks the model for one question covering that
 * bundle. Tagging a single question with every remaining id would pass the automated check and
 * fail a human review instantly.
 *
 * A requirement that clusters with nothing gets its own question. No orphan is swept into an
 * unrelated bundle to save a call.
 */

export const MAX_CLUSTER_SIZE = 3;

/** Shared content tokens needed before two requirements are considered related. */
const RELATED_TOKEN_THRESHOLD = 1;

export function clusterRequirements(requirements: readonly Requirement[]): Requirement[][] {
  const clusters: Requirement[][] = [];

  // Never across kind: a technical requirement and a behavioural one have no honest single
  // question, whatever vocabulary they happen to share.
  for (const kind of ["technical", "behavioural", "domain"] as const) {
    const ofKind = requirements.filter((r) => r.kind === kind);
    const unassigned = [...ofKind];

    while (unassigned.length > 0) {
      const seed = unassigned.shift() as Requirement;
      const cluster = [seed];
      const seedTokens = new Set(contentTokens(seed.text));

      for (let i = unassigned.length - 1; i >= 0 && cluster.length < MAX_CLUSTER_SIZE; i -= 1) {
        const candidate = unassigned[i] as Requirement;
        if (sharedTokenCount(seedTokens, candidate) >= RELATED_TOKEN_THRESHOLD) {
          cluster.unshift(candidate);
          unassigned.splice(i, 1);
        }
      }

      // Restore input order within the cluster so output is stable and readable.
      clusters.push(cluster.sort((a, b) => requirements.indexOf(a) - requirements.indexOf(b)));
    }
  }

  return clusters;
}

function sharedTokenCount(seedTokens: ReadonlySet<string>, candidate: Requirement): number {
  let shared = 0;
  for (const token of new Set(contentTokens(candidate.text))) {
    if (seedTokens.has(token)) shared += 1;
  }
  return shared;
}
