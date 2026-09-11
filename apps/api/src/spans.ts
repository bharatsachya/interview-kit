import type { Span } from "@trao/contracts";

/**
 * What a job has done so far, and what it does next, for anyone watching.
 *
 * The runner writes into this; the `/jobs/:id/events` stream reads out of it. They are kept
 * apart deliberately — the runner must not know whether anyone is connected, and the stream
 * must not have to reach into a running pipeline.
 *
 * ## Why a replay buffer and not just a broadcast
 *
 * A browser connects when the user opens the page, which is rarely the moment the job starts —
 * they reload, they come back from another tab, they share the URL. A pure broadcast would send
 * such a client whatever happens next and nothing about the eight steps already finished, and
 * the screen would sit blank through the longest part of the run. So every span is kept, and a
 * new subscriber is caught up before it is connected. That is also what makes the stream safe
 * to reconnect to: replay is the normal path, not an error path.
 *
 * Memory is bounded by the number of spans a run produces — tens, not thousands — and the
 * buffer is dropped when the job is forgotten.
 */
export class JobSpanFeed {
  readonly #byJob = new Map<string, Map<string, Span>>();
  readonly #order = new Map<string, string[]>();
  readonly #listeners = new Map<string, Set<Listener>>();
  readonly #finished = new Set<string>();

  /**
   * Record the current state of a job's trace.
   *
   * Takes the whole span list rather than one span, because that is what a tracer can hand over
   * cheaply and it makes the call idempotent: the runner polls, publishes everything it has, and
   * only what actually changed reaches a subscriber. A span that opened as `running` and later
   * settled is published twice on purpose — the status transition is the interesting part.
   */
  publish(jobId: string, spans: readonly Span[]): void {
    const known = this.#byJob.get(jobId) ?? new Map<string, Span>();
    const order = this.#order.get(jobId) ?? [];
    this.#byJob.set(jobId, known);
    this.#order.set(jobId, order);

    const changed: Span[] = [];
    for (const span of spans) {
      const previous = known.get(span.id);
      if (previous === undefined) order.push(span.id);
      else if (previous.status === span.status && previous.endedAt === span.endedAt) continue;
      known.set(span.id, span);
      changed.push(span);
    }

    if (changed.length === 0) return;
    for (const listener of this.#listeners.get(jobId) ?? []) {
      for (const span of changed) listener.onSpan(span);
    }
  }

  /** Everything recorded so far, in the order the steps started. */
  snapshot(jobId: string): Span[] {
    const known = this.#byJob.get(jobId);
    if (known === undefined) return [];
    return (this.#order.get(jobId) ?? []).flatMap((id) => {
      const span = known.get(id);
      return span === undefined ? [] : [span];
    });
  }

  /**
   * Catch a listener up, then keep it fed. Returns the unsubscribe.
   *
   * The replay happens inside `subscribe` rather than being left to the caller so there is no
   * window between reading the snapshot and registering: a span published in that gap would be
   * in neither, and the client would be permanently one step behind with no way to tell.
   */
  subscribe(jobId: string, listener: Listener): () => void {
    for (const span of this.snapshot(jobId)) listener.onSpan(span);
    if (this.#finished.has(jobId)) {
      listener.onEnd();
      return () => {};
    }

    const listeners = this.#listeners.get(jobId) ?? new Set<Listener>();
    this.#listeners.set(jobId, listeners);
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  /** The job has settled. Subscribers are told once; late ones are told on arrival. */
  finish(jobId: string): void {
    this.#finished.add(jobId);
    for (const listener of this.#listeners.get(jobId) ?? []) listener.onEnd();
    this.#listeners.delete(jobId);
  }

  isFinished(jobId: string): boolean {
    return this.#finished.has(jobId);
  }

  /** Drop a job's buffer. Called when nothing will ever watch it again. */
  forget(jobId: string): void {
    this.#byJob.delete(jobId);
    this.#order.delete(jobId);
    this.#listeners.delete(jobId);
    this.#finished.delete(jobId);
  }
}

export interface Listener {
  onSpan(span: Span): void;
  onEnd(): void;
}
