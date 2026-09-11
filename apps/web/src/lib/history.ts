import type { JobSummary, KitSummary } from "@/lib/api/types";

/**
 * The history rail lists runs, not kits.
 *
 * It used to list kits, and a kit does not exist until its job succeeds — so a run that failed
 * left nothing behind. The trace was on screen while you watched it and gone the moment you
 * reloaded, which is the worst possible time to lose it: a failure is the thing you most want to
 * go back and read. Queued and running jobs had the same hole; navigating away lost them too.
 *
 * Both halves are needed, and neither is a superset of the other. A kit carries what a finished
 * run is *about* — company, role, how many days — which the job record never holds. A job
 * carries the runs that have no kit yet or never will. So the two lists are merged rather than
 * one being chosen.
 */
export type HistoryEntry =
  | { kind: "kit"; id: string; createdAt: number; kit: KitSummary }
  | { kind: "run"; id: string; createdAt: number; job: JobSummary };

/**
 * Merge finished kits with the runs that have not produced one.
 *
 * A `done` job is deliberately dropped: its kit is already in the list and says more than the
 * job does. The exception is a `done` job whose kit is missing — a kit deleted out from under a
 * finished run — which would otherwise vanish silently, so it is kept as a run row.
 *
 * Newest first, by the same clock for both kinds, so a failed run sits in the position it
 * actually happened rather than being grouped apart from the successes.
 */
export function mergeHistory(kits: KitSummary[], jobs: JobSummary[]): HistoryEntry[] {
  const kitIds = new Set(kits.map((kit) => kit.id));

  const entries: HistoryEntry[] = kits.map((kit) => ({
    kind: "kit",
    id: kit.id,
    createdAt: kit.createdAt,
    kit,
  }));

  for (const job of jobs) {
    if (job.status === "done" && job.kitId !== null && kitIds.has(job.kitId)) continue;
    entries.push({ kind: "run", id: job.id, createdAt: job.createdAt, job });
  }

  return entries.sort((a, b) => b.createdAt - a.createdAt);
}

/** How many entries are finished kits — what the compare control and the user chip count. */
export function kitCount(entries: HistoryEntry[]): number {
  return entries.reduce((total, entry) => total + (entry.kind === "kit" ? 1 : 0), 0);
}

/** The kits among the entries, for the comparison view, newest first. */
export function kitsOf(entries: HistoryEntry[]): KitSummary[] {
  return entries.flatMap((entry) => (entry.kind === "kit" ? [entry.kit] : []));
}

/** What a run row says it is. `done` never reaches here unless its kit went missing. */
export function runLabel(job: JobSummary): string {
  if (job.status === "failed") return "Failed";
  if (job.status === "queued") return "Queued";
  if (job.status === "done") return "Kit missing";
  return job.progress === null
    ? "Running"
    : `Step ${job.progress.stepIndex + 1} of ${job.progress.stepCount}`;
}
