"use client";

import { useEffect, useRef } from "react";
import type { Span } from "@trao/contracts";
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
  onComplete,
}: {
  jobId: string;
  showLabel: boolean;
  onComplete: (jobId: string, kitId: string, spans: Span[]) => void;
}) {
  const { spans, job, progress, label, transport, error } = useJobStream(jobId);
  const announced = useRef(false);

  useEffect(() => {
    if (announced.current) return;
    if (job?.status === "done" && job.kitId) {
      announced.current = true;
      // The spans go up with the kit id. They are the only record of how the run went, and the
      // conversation keeps showing them after the stream has finished — a trace that vanished
      // the moment the run ended would be the one thing the product cannot afford to lose.
      onComplete(jobId, job.kitId, spans);
    }
  }, [job, jobId, spans, onComplete]);

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
            Building your kit{progress ? ` — ${stepLabel(progress.step).toLowerCase()}` : ""}
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
        <ErrorNotice title="No kit could be produced">{job.error.message}</ErrorNotice>
      ) : null}
    </section>
  );
}
