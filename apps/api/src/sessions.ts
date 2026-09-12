import { lineageLabel, type InternalKit } from "@trao/kit";
import type { JobAsk, JobRecord, KitRecord } from "@trao/contracts";

/**
 * Sessions, derived rather than stored.
 *
 * A session is one conversation: the posting you sent, every rewrite you asked for since, the
 * runs they started and the kits they produced. It is the unit the history rail lists and the
 * unit a URL points at — `?session=s_7fa3` rather than `?kit=…&jobs=…,…,…`, which grew a job id
 * on every rewrite.
 *
 * **There is no `sessions` collection.** A session is `GROUP BY sessionId` over the two lists
 * the API already reads on every page load, and both of those queries are already indexed by
 * user. A fourth store would mean a fourth thing to keep in step, and its `turns` array would be
 * a second source of truth about what ran — disagreeing with the job records the first time a
 * write half-succeeded. Grouping cannot disagree with itself.
 *
 * Kit ids and job ids do not go away and could not: a kit is a document the builder writes to at
 * `/kits/:id`, and a job is what the progress stream polls. The session is a grouping over them.
 */

/** A run and what it was asked to do — one turn of the conversation. */
export interface SessionTurn {
  jobId: string;
  ask: JobAsk | null;
  status: JobRecord["status"];
  kitId: string | null;
  error: JobRecord["error"];
  progress: JobRecord["progress"];
  createdAt: number;
}

export interface SessionKit {
  id: string;
  title: string;
  company: string;
  days: number;
  createdAt: number;
  revision: number;
  /** What the rewrite that produced this kit did. Absent on the kit a posting built. */
  changed?: string;
}

export interface Session {
  id: string;
  /** The first thing the conversation was about. Taken from its oldest run. */
  title: string;
  createdAt: number;
  /** The newest thing in it, which is what the rail sorts by — a session you rewrote is recent. */
  updatedAt: number;
  turns: SessionTurn[];
  /** Newest first, so the rail's first nested row is the one the panel would open. */
  kits: SessionKit[];
  /** True while any turn is queued or running, so the rail can show one live dot per session. */
  running: boolean;
}

/**
 * The ask on a stored job, including the ones written before it was discriminated.
 *
 * Those hold a bare `{jd, companyUrl, days}`. Reading them as `posting` costs four lines and
 * keeps every kit anyone has already made renderable; a migration would cost a script, a
 * deployment order and a way to be half-done.
 */
export function askOf(stored: JobRecord["request"]): JobAsk | null {
  if (stored === null || stored === undefined) return null;
  const value = stored as Partial<JobAsk> & { jd?: string; companyUrl?: string; days?: number };
  if (value.kind === undefined) {
    return typeof value.jd === "string"
      ? { kind: "posting", jd: value.jd, companyUrl: value.companyUrl ?? "", days: value.days ?? 0 }
      : null;
  }
  return value as JobAsk;
}

/**
 * Which session a record belongs to, including the ones that predate sessions.
 *
 * A legacy record gets a synthetic id derived from what it already has — its kit if it made one,
 * otherwise itself. That puts a legacy kit and the run that produced it in the same one-turn
 * session without writing to either, and the ids cannot collide with a minted `sess_…`.
 */
function sessionOfJob(job: JobRecord): string {
  return job.sessionId ?? (job.kitId === null ? `job:${job.id}` : `kit:${job.kitId}`);
}

function sessionOfKit(record: KitRecord<InternalKit>): string {
  return record.sessionId ?? `kit:${record.id}`;
}

/**
 * Group a user's runs and kits into conversations, newest activity first.
 *
 * Both lists are needed and neither is a superset of the other — a kit carries what a finished
 * run was *about*, a job carries the runs that have no kit yet or never will. That was already
 * true of the history rail's client-side merge; this moves it to the one place that can see both
 * without a second round trip.
 */
export function buildSessions(jobs: readonly JobRecord[], kits: readonly KitRecord<InternalKit>[]): Session[] {
  const byId = new Map<string, Session>();

  const open = (id: string, at: number): Session => {
    const existing = byId.get(id);
    if (existing !== undefined) return existing;
    const fresh: Session = { id, title: "", createdAt: at, updatedAt: at, turns: [], kits: [], running: false };
    byId.set(id, fresh);
    return fresh;
  };

  for (const job of jobs) {
    const session = open(sessionOfJob(job), job.createdAt);
    session.turns.push({
      jobId: job.id,
      ask: askOf(job.request),
      status: job.status,
      kitId: job.kitId,
      error: job.error,
      progress: job.progress,
      createdAt: job.createdAt,
    });
    session.createdAt = Math.min(session.createdAt, job.createdAt);
    session.updatedAt = Math.max(session.updatedAt, job.updatedAt);
    if (job.status === "queued" || job.status === "running") session.running = true;
  }

  for (const record of kits) {
    const session = open(sessionOfKit(record), record.createdAt);
    const kit = record.kit;
    session.kits.push({
      id: record.id,
      title: kit.role.title,
      company: kit.role.company,
      days: kit.schedule.daysAvailable,
      createdAt: record.createdAt,
      revision: kit.revision ?? 1,
      ...(kit.forkedFrom !== undefined ? { changed: lineageLabel(kit.forkedFrom) } : {}),
    });
    session.createdAt = Math.min(session.createdAt, record.createdAt);
    session.updatedAt = Math.max(session.updatedAt, record.updatedAt);
  }

  for (const session of byId.values()) {
    // Oldest first: a transcript is read downwards, and the turn that opened the conversation is
    // the one that names it.
    session.turns.sort((a, b) => a.createdAt - b.createdAt);
    // Newest first: the rail's first nested row is the newest revision, which is what opening
    // the session should show.
    session.kits.sort((a, b) => b.createdAt - a.createdAt);
    session.title = titleOf(session);
  }

  return [...byId.values()].sort((a, b) => b.updatedAt - a.updatedAt);
}

/**
 * What the conversation is called.
 *
 * The kit's own company and role when there is one, because that is what the person is preparing
 * for and it stays right as the session grows. A session whose only run failed has no kit to ask,
 * so it falls back to the posting's first line — which is exactly what the job label already is.
 */
function titleOf(session: Session): string {
  const oldestKit = session.kits[session.kits.length - 1];
  if (oldestKit !== undefined) {
    const company = oldestKit.company.trim();
    const role = oldestKit.title.trim();
    if (company !== "" && role !== "") return `${company} — ${role}`;
    if (company !== "") return company;
    if (role !== "") return role;
  }

  const opening = session.turns[0]?.ask;
  if (opening?.kind === "posting") {
    const firstLine = opening.jd.split(/\r?\n/).find((line) => line.trim() !== "")?.trim() ?? "";
    if (firstLine !== "") return firstLine.slice(0, 80);
  }
  return "Untitled session";
}
