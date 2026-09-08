"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { Span } from "@trao/contracts";
import { api } from "@/lib/api/client";
import type { JobView } from "@/lib/api/types";
import { spanNote, stepLabel, toPhaseViews, unclaimedSpans, type PhaseState } from "@/lib/pipeline-phases";
import { Button } from "@/components/industry/button";
import { Frame } from "@/components/industry/frame";
import { ErrorNotice, Loading } from "@/components/industry/states";

/**
 * Polling, every two seconds, rather than SSE.
 *
 * Free hosts buffer streams, and a progress bar that stalls in the walkthrough video costs more
 * than a plain one that works. Two seconds is also slow enough that a poll failing once is
 * invisible — which is why a failed poll is counted and only surfaced after three in a row: a
 * blip in the network is not a failure of the run, and saying so would be a lie about the job.
 *
 * The steps shown are read from the job's trace spans. Nothing here is a timer pretending to be
 * progress, and there is no percentage — the pipeline cannot know how long a crawl will take,
 * so the screen does not claim to either.
 */
const POLL_MS = 2000;
const FAILURES_BEFORE_SURFACING = 3;

export function JobProgress({ jobIds }: { jobIds: string[] }) {
  const router = useRouter();
  const [views, setViews] = useState<Record<string, JobView>>({});
  const [pollFailures, setPollFailures] = useState(0);
  const navigated = useRef(false);

  useEffect(() => {
    if (jobIds.length === 0) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;

    async function poll() {
      try {
        const results = await Promise.all(
          jobIds.map((id) =>
            api.getJob(id, controller.signal).then(
              (view) => [id, view] as const,
              () => [id, null] as const,
            ),
          ),
        );

        if (stopped) return;

        const fetched = results.filter((entry): entry is readonly [string, JobView] => entry[1] !== null);
        if (fetched.length === 0) {
          setPollFailures((count) => count + 1);
        } else {
          setPollFailures(0);
          setViews((previous) => {
            const next = { ...previous };
            for (const [id, view] of fetched) next[id] = view;
            return next;
          });
        }

        const allSettled =
          fetched.length === jobIds.length &&
          fetched.every(([, view]) => view.job.status === "done" || view.job.status === "failed");
        if (!allSettled && !stopped) timer = setTimeout(poll, POLL_MS);
      } catch {
        if (!stopped) {
          setPollFailures((count) => count + 1);
          timer = setTimeout(poll, POLL_MS);
        }
      }
    }

    void poll();
    return () => {
      stopped = true;
      controller.abort();
      if (timer) clearTimeout(timer);
    };
  }, [jobIds]);

  const ordered = jobIds.map((id) => views[id]).filter((view) => view !== undefined);
  const single = jobIds.length === 1;
  const allDone =
    ordered.length === jobIds.length &&
    ordered.every((view) => view.job.status !== "queued" && view.job.status !== "running");

  // Elapsed comes from the job's own timestamps rather than a clock read during render: the
  // server's numbers are the true ones, and reading a clock here would both be impure and show
  // a figure that only moved when a poll happened to land.
  const elapsedMs = ordered.reduce(
    (longest, view) => Math.max(longest, view.job.updatedAt - view.job.createdAt),
    0,
  );

  // One role, finished: go straight to the kit. A screen whose only remaining content is a
  // link to the next screen is a screen that should not still be here.
  useEffect(() => {
    if (!single || navigated.current) return;
    const only = ordered[0];
    if (only?.job.status === "done" && only.job.kitId) {
      navigated.current = true;
      router.replace(`/kit/${only.job.kitId}`);
    }
  }, [ordered, single, router]);

  if (ordered.length === 0) {
    return (
      <div className="flex flex-col gap-6">
        <Loading label="Starting the run" detail="Reading the description first, so there is something to look at within a few seconds." />
        {pollFailures >= FAILURES_BEFORE_SURFACING ? <PollTrouble attempts={pollFailures} /> : null}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-10">
      {pollFailures >= FAILURES_BEFORE_SURFACING ? <PollTrouble attempts={pollFailures} /> : null}

      {ordered.map((view) => (
        <JobRow key={view.job.id} view={view} showTitle={!single} />
      ))}

      {!allDone ? (
        <p className="max-w-read text-xs opacity-55 tabular-nums">
          Running for {Math.round(elapsedMs / 1000)}s. You can close this tab — the run keeps going,
          and this URL brings you back to it.
        </p>
      ) : null}

      {allDone && !single ? (
        <div className="flex flex-wrap gap-3">
          <Link
            href="/"
            className="font-head rounded-control border-teal-700 bg-teal-700 text-paper inline-flex min-h-11 items-center border px-4 text-sm tracking-wide md:min-h-9"
          >
            All kits
          </Link>
        </div>
      ) : null}
    </div>
  );
}

function JobRow({ view, showTitle }: { view: JobView; showTitle: boolean }) {
  const done = view.job.status === "done";
  const phases = toPhaseViews(view.spans, done);
  const extra = unclaimedSpans(view.spans);

  return (
    <section className="flex flex-col gap-6">
      {showTitle ? (
        <div className="flex flex-wrap items-baseline gap-3">
          <h2 className="text-2xl">{view.label}</h2>
          {done && view.job.kitId ? (
            <Link href={`/kit/${view.job.kitId}`} className="text-teal-700 text-sm underline underline-offset-4">
              Open the kit
            </Link>
          ) : null}
        </div>
      ) : null}

      {view.job.status === "failed" && view.job.error ? (
        <ErrorNotice title="This run could not produce a kit">
          {view.job.error.message}
        </ErrorNotice>
      ) : null}

      <ol className="flex list-none flex-col gap-4">
        {phases.map((phaseView) => (
          <li key={phaseView.phase.id}>
            <Frame className="flex flex-col gap-3 p-4" marks={false}>
              <div className="flex flex-wrap items-center gap-3">
                <StateTick state={phaseView.state} />
                <span className="font-head text-sm tracking-wide">{phaseView.phase.label}</span>
                {phaseView.elapsedMs > 0 ? (
                  <span className="ml-auto text-xs font-medium tabular-nums opacity-55">
                    {(phaseView.elapsedMs / 1000).toFixed(1)}s
                  </span>
                ) : null}
              </div>

              {phaseView.spans.length > 0 ? (
                <ul className="flex list-none flex-col gap-2">
                  {phaseView.spans.map((span) => (
                    <StepRow key={span.id} span={span} />
                  ))}
                </ul>
              ) : null}
            </Frame>
          </li>
        ))}

        {extra.length > 0 ? (
          <li>
            <Frame className="flex flex-col gap-3 p-4" marks={false}>
              <span className="font-head text-sm tracking-wide">Other work</span>
              <ul className="flex list-none flex-col gap-2">
                {extra.map((span) => (
                  <StepRow key={span.id} span={span} />
                ))}
              </ul>
            </Frame>
          </li>
        ) : null}
      </ol>
    </section>
  );
}

function StepRow({ span }: { span: Span }) {
  const note = spanNote(span);
  const degraded = span.status === "skipped" || typeof span.attrs.degraded === "string";

  return (
    <li className="flex flex-col gap-1">
      <div className="flex flex-wrap items-baseline gap-3 text-sm">
        <span aria-hidden className="font-medium opacity-55">
          {span.status === "failed" ? "×" : span.status === "skipped" ? "–" : "✓"}
        </span>
        <span>{stepLabel(span.step)}</span>
        <span className="ml-auto text-xs tabular-nums opacity-40">
          {(span.durationMs / 1000).toFixed(1)}s
        </span>
      </div>
      {note ? (
        <p className={`max-w-read pl-6 text-xs leading-relaxed ${degraded ? "opacity-70" : "text-alarm"}`}>
          {note}
          {degraded ? " The run carried on, and the kit records it." : ""}
        </p>
      ) : null}
    </li>
  );
}

const TICK: Readonly<Record<PhaseState, { className: string; label: string }>> = {
  pending: { className: "bg-transparent", label: "Not started" },
  running: { className: "hatch", label: "Running" },
  done: { className: "bg-ink", label: "Done" },
  // Degraded is a filled mark, not a warning. It succeeded; it just did less than it could.
  degraded: { className: "bg-teal-300", label: "Done, with gaps recorded" },
  failed: { className: "bg-transparent border-alarm", label: "This step failed" },
};

function StateTick({ state }: { state: PhaseState }) {
  const tick = TICK[state];
  return (
    <span className="inline-flex items-center gap-2">
      <span aria-hidden className={`border-ink size-4 shrink-0 border ${tick.className}`} />
      <span className="sr-only">{tick.label}</span>
    </span>
  );
}

function PollTrouble({ attempts }: { attempts: number }) {
  return (
    <ErrorNotice
      title="Cannot reach the server"
      attempts={attempts}
      actions={
        <Button variant="secondary" onClick={() => window.location.reload()}>
          Reload
        </Button>
      }
    >
      The run itself is unaffected — this page just cannot read its progress. It keeps trying.
    </ErrorNotice>
  );
}
