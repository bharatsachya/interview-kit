"use client";

import { useEffect, useRef } from "react";
import type { Span } from "@trao/contracts";
import { useJobStream } from "@/lib/api/job-stream";
import { spanConsequence, spanResult, spanTone, stepLabel, toStreamRows, type SpanTone } from "@/lib/spans";
import { Button } from "@/components/industry/button";
import { ErrorNotice } from "@/components/industry/states";
import { Eyebrow } from "@/components/industry/text";

/**
 * One run, rendered as it happens.
 *
 * Mounted with `key={jobId}`, so a new run is a new component and there is no state to reset.
 *
 * A skipped step reads as information, not as an error: running without a search key is a normal
 * outcome, and drawing it in the alarm colour would misreport a kit that is perfectly fine. A
 * failed step says what it means for the kit rather than what broke in the pipeline — the person
 * watching wants to know what they are getting, not which function threw.
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
  const rows = toStreamRows(spans);
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
  const inFlight = !settled && progress && progress.stepIndex > rows.filter((r) => r.parentId === null).length;

  return (
    <section className="flex flex-col gap-4">
      {showLabel && label ? <Eyebrow className="text-steel-700">{label}</Eyebrow> : null}

      <ol className="flex list-none flex-col gap-2">
        {rows.map((span) => (
          <StepRow key={span.id} span={span} />
        ))}

        {inFlight ? (
          <li className="motion-safe:animate-step-in flex flex-wrap items-baseline gap-3">
            <span aria-hidden className="border-ink hatch size-3 shrink-0 self-center border" />
            <span className="text-sm">{stepLabel(progress.step)}</span>
            <span className="sr-only">in progress</span>
          </li>
        ) : null}
      </ol>

      {transport === "polling" && !settled ? (
        <p className="text-xs opacity-45">
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

const TONE_MARK: Readonly<Record<SpanTone, string>> = {
  done: "bg-ink",
  // Informational, not alarming: the step chose not to run, and the kit records why.
  info: "hatch",
  trouble: "border-alarm bg-transparent",
};

function StepRow({ span }: { span: Span }) {
  const tone = spanTone(span);
  const result = spanResult(span);
  const consequence = spanConsequence(span);

  return (
    <li className="motion-safe:animate-step-in flex flex-col gap-1">
      <div className="flex flex-wrap items-baseline gap-3">
        <span aria-hidden className={`border-ink size-3 shrink-0 self-center border ${TONE_MARK[tone]}`} />
        <span className="text-sm">{stepLabel(span.step, span.attrs)}</span>
        {result ? (
          <>
            <span aria-hidden className="text-xs opacity-35">
              →
            </span>
            <span className={`text-sm tabular-nums ${tone === "trouble" ? "text-alarm" : "opacity-65"}`}>
              {result}
            </span>
          </>
        ) : null}
      </div>
      {consequence ? <p className="pl-6 text-xs opacity-55">{consequence}</p> : null}
    </li>
  );
}
