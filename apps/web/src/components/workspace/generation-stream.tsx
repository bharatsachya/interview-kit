"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Span } from "@trao/contracts";
import { api } from "@/lib/api/client";
import { useJobStream } from "@/lib/api/job-stream";
import { stepLabel } from "@/lib/spans";
import { Button } from "@/components/industry/button";
import { ErrorNotice } from "@/components/industry/states";
import { Eyebrow } from "@/components/industry/text";
import { Assistant } from "@/components/workspace/assistant";
import { Trace } from "@/components/workspace/trace";

/**
 * One run, rendered as it happens.
 *
 * Mounted with `key={jobId}`, so a new run is a new component and there is no state to reset.
 *
 * The step list is `Trace` — the same component that draws the finished run — given a live
 * step instead of nothing. It used to be a second list with its own markup, which meant two
 * places to rename a step and a visible change of furniture the moment a run ended. Now the
 * rows do not move when the run finishes; the running one simply stops running.
 */
export function GenerationStream({
  jobId,
  showLabel,
  running: runningLabel,
  onComplete,
  onFailed,
  onRetried,
}: {
  jobId: string;
  showLabel: boolean;
  /**
   * What to say while this run is going, when "Building your kit" would be a lie.
   *
   * A rewrite is a run in every respect this component cares about — a job, a trace, steps that
   * finish — but it is not building a kit from a posting, and the sentence is the only thing on
   * screen saying what is happening. Omitted for a first generation, which really is building one.
   */
  running?: string;
  onComplete: (jobId: string, kitId: string, spans: Span[]) => void;
  /**
   * A run that ended without a kit.
   *
   * Separate from `onComplete` because there is no kit id to hand over and nothing for the
   * panel to open — the only consequence is that the history rail now has a row it did not
   * have a moment ago. Without this the failure was on screen but absent from the rail until
   * the next reload, which is precisely backwards: the run you most want to find again was the
   * one the list did not admit existed.
   */
  onFailed: (jobId: string) => void;
  /** A retry started: the workspace swaps this run for the new one it created. */
  onRetried: (jobId: string) => void;
}) {
  const { spans, job, progress, label, transport, error } = useJobStream(jobId);
  const announced = useRef(false);
  const [retrying, setRetrying] = useState(false);
  const [retryError, setRetryError] = useState<string | null>(null);

  /**
   * Start the same work again, as a new run.
   *
   * The new job replaces this one on screen rather than being appended: two traces for what the
   * user thinks of as one attempt is a worse answer than the newest one, and the failure it
   * came from is still in the history rail either way.
   */
  const retry = useCallback(async () => {
    setRetrying(true);
    setRetryError(null);
    try {
      const { job_ids } = await api.retryJob(jobId);
      const next = job_ids[0];
      if (next === undefined) throw new Error("The API accepted the retry but named no run.");
      onRetried(next);
    } catch (cause: unknown) {
      setRetryError(cause instanceof Error ? cause.message : "Could not start it again.");
      setRetrying(false);
    }
  }, [jobId, onRetried]);

  useEffect(() => {
    if (announced.current) return;
    if (job?.status === "done" && job.kitId) {
      announced.current = true;
      // The spans go up with the kit id. They are the only record of how the run went, and the
      // conversation keeps showing them after the stream has finished — a trace that vanished
      // the moment the run ended would be the one thing the product cannot afford to lose.
      onComplete(jobId, job.kitId, spans);
    } else if (job?.status === "failed") {
      announced.current = true;
      onFailed(jobId);
    }
  }, [job, jobId, spans, onComplete, onFailed]);

  const settled = job?.status === "done" || job?.status === "failed";
  const running = !settled;

  return (
    <section className="flex flex-col gap-4">
      {showLabel && label ? <Eyebrow className="text-steel-700">{label}</Eyebrow> : null}

      {running ? (
        <Assistant live>
          {/* Shimmered rather than animated with dots: the sentence names the step, and the step
              changes, so the text is already telling you it is alive. The sweep is what says the
              app has not simply stopped on that step. */}
          <span className="shimmer-text">
            {runningLabel ?? "Building your kit"}
            {progress ? ` — ${stepLabel(progress.step).toLowerCase()}` : ""}
          </span>
        </Assistant>
      ) : null}

      <div className="md:ml-[38px]">
        <Trace
          spans={spans}
          progress={running && progress ? { step: progress.step } : null}
          defaultOpen
        />
      </div>

      {transport === "polling" && !settled ? (
        <p className="text-ink/40 text-xs">
          The live stream dropped, so this is polling instead. The run is unaffected.
        </p>
      ) : null}

      {error ? (
        <ErrorNotice
          title="Lost contact with the run"
          actions={
            <Button variant="secondary" onClick={() => window.location.reload()}>
              Reload
            </Button>
          }
        >
          {error}
        </ErrorNotice>
      ) : null}

      {job?.status === "failed" && job.error ? (
        <ErrorNotice
          title="No kit could be produced"
          actions={
            // Offered only when the API says this run can actually be repeated. A run that
            // failed before the posting was kept on its record has nothing to retry with, and a
            // button that can only 404 is worse than no button.
            job.retryable ? (
              <Button variant="secondary" onClick={() => void retry()} disabled={retrying}>
                {retrying ? "Starting…" : "Try again"}
              </Button>
            ) : null
          }
        >
          {job.error.message}
        </ErrorNotice>
      ) : null}

      {retryError ? <p className="text-alarm text-xs font-medium">{retryError}</p> : null}
    </section>
  );
}
