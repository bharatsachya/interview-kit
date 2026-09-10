"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Span } from "@trao/contracts";
import { seconds } from "@/lib/kit-outputs";
import {
  PIPELINE_STEP_ORDER,
  parseStep,
  spanConsequence,
  spanResult,
  spanTone,
  stepLabel,
  toStreamRows,
} from "@/lib/spans";
import { Ring } from "@/components/industry/mark";

/** A replay is meant to be watched, not waited through. */
const REPLAY_TOTAL_MS = 3000;
/** Even a step that took no measurable time has to be legible as having happened. */
const REPLAY_MIN_STEP_MS = 180;

export interface TraceProgress {
  /** The step the pipeline says is running now. */
  step: string;
}

interface Row {
  key: string;
  label: string;
  detail: string | null;
  durationMs: number | null;
  state: "done" | "active" | "pending";
  trouble: boolean;
}

/**
 * The trace: what the run did, while it is doing it and after.
 *
 * One component for both, because they are the same list at different times — a separate
 * "progress" component and "trace" component would have drifted the first time a step was
 * renamed, and the reader would have watched one list only for a different one to replace it.
 *
 * Three states per row, and the distinction is the whole point. A finished step shows its number
 * and how long it took. The running step shows a turning ring where its number will be, and its
 * label shimmers. Steps still to come are drawn faded with no time at all — never a zero, which
 * would read as "took no time" rather than "has not happened".
 *
 * Replay exists because the trace is the product's central claim — that the schedule and the
 * coverage check are arithmetic rather than something a model asserted — and that claim is much
 * easier to believe watched than read. It replays the real spans at their real relative
 * durations, compressed so the whole run reads in about three seconds.
 */
export function Trace({
  spans,
  progress = null,
  defaultOpen = false,
}: {
  spans: readonly Span[];
  progress?: TraceProgress | null;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const finished = useMemo(() => toStreamRows(spans), [spans]);

  const trueTotal = useMemo(
    () => finished.reduce((sum, span) => sum + span.durationMs, 0),
    [finished],
  );

  // ── replay ────────────────────────────────────────────────────────────────
  // `null` when not replaying; otherwise how many rows have finished so far.
  const [replayAt, setReplayAt] = useState<number | null>(null);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);

  const stopReplay = useCallback(() => {
    for (const timer of timers.current) clearTimeout(timer);
    timers.current = [];
    setReplayAt(null);
  }, []);

  useEffect(() => stopReplay, [stopReplay]);

  const replay = useCallback(() => {
    stopReplay();
    if (finished.length === 0) return;

    // Real durations, scaled to fit the budget, with a floor so the quick ones are still seen.
    const weights = finished.map((span) => Math.max(span.durationMs, 1));
    const weighed = weights.reduce((sum, value) => sum + value, 0);
    const delays = weights.map((weight) =>
      Math.max(REPLAY_MIN_STEP_MS, (weight / weighed) * REPLAY_TOTAL_MS),
    );

    setReplayAt(0);
    setOpen(true);

    let elapsed = 0;
    finished.forEach((_, index) => {
      elapsed += delays[index] ?? REPLAY_MIN_STEP_MS;
      timers.current.push(
        setTimeout(() => setReplayAt(index + 1 === finished.length ? null : index + 1), elapsed),
      );
    });
  }, [finished, stopReplay]);

  // A real run arriving takes the screen back from a replay of an older one.
  useEffect(() => {
    if (progress !== null) stopReplay();
  }, [progress, stopReplay]);

  // ── what to draw ──────────────────────────────────────────────────────────
  const replaying = replayAt !== null;
  const live = progress !== null || replaying;

  const rows: Row[] = useMemo(() => {
    const describe = (span: Span, state: Row["state"]): Row => {
      const tone = spanTone(span);
      const result = spanResult(span);
      const consequence = tone === "trouble" ? spanConsequence(span) : null;
      return {
        key: span.id,
        label: stepLabel(span.step, span.attrs),
        detail: [result, consequence].filter(Boolean).join(" — ") || null,
        durationMs: span.durationMs,
        state,
        trouble: tone === "trouble",
      };
    };

    if (replaying) {
      const at = replayAt;
      return finished.map((span, index) =>
        describe(span, index < at ? "done" : index === at ? "active" : "pending"),
      );
    }

    const done = finished.map((span) => describe(span, "done"));
    if (progress === null) return done;

    // Live. The finished rows are real spans; the running step is a name and nothing else, and
    // the rest are drawn from the canonical order so the list has its full height from the start.
    const seen = new Set(finished.map((span) => parseStep(span.step).base));
    const activeBase = parseStep(progress.step).base;
    const active: Row = {
      key: `active:${progress.step}`,
      label: stepLabel(progress.step),
      detail: null,
      durationMs: null,
      state: "active",
      trouble: false,
    };
    const activeIndex = PIPELINE_STEP_ORDER.indexOf(activeBase);
    const pending: Row[] = PIPELINE_STEP_ORDER.filter(
      (step, index) => index > activeIndex && !seen.has(step),
    ).map((step) => ({
      key: `pending:${step}`,
      label: stepLabel(step),
      detail: null,
      durationMs: null,
      state: "pending" as const,
      trouble: false,
    }));

    return [...done, active, ...pending];
  }, [finished, progress, replaying, replayAt]);

  // ── the elapsed clock ─────────────────────────────────────────────────────
  const elapsedMs = useElapsed({ rows, live, trueTotal, replaying });

  if (rows.length === 0 && !live) return null;

  const stepCount = rows.filter((row) => row.state !== "pending").length;

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
          className={`font-head rounded-pill inline-flex h-7 items-center gap-2 px-3 text-xs tracking-widest uppercase transition-colors ${
            open || live
              ? "bg-steel-100 text-steel-700"
              : "bg-tint text-ink/55 hover:bg-steel-100 hover:text-steel-700"
          }`}
        >
          <span>
            Trace · {stepCount} {stepCount === 1 ? "step" : "steps"}
          </span>
          <span className="tracking-normal tabular-nums">{seconds(elapsedMs)}</span>
          <svg
            aria-hidden
            width="10"
            height="6"
            viewBox="0 0 10 6"
            fill="none"
            className={`transition-transform duration-200 ${open ? "rotate-180" : ""}`}
          >
            <path
              d="M1 1l4 4 4-4"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>

        {!live && finished.length > 0 ? (
          <button
            type="button"
            onClick={replay}
            className="font-head text-ink/40 hover:bg-steel-100 hover:text-steel-700 rounded-pill inline-flex h-7 items-center gap-1.5 px-2.5 text-xs tracking-widest uppercase transition-colors"
          >
            <span aria-hidden>↻</span> Run again
          </button>
        ) : null}
      </div>

      {open ? (
        <ol className="flex list-none flex-col gap-0.5 pt-0.5">
          {rows.map((row, index) => (
            <TraceRow key={row.key} row={row} index={index} />
          ))}
        </ol>
      ) : null}
    </div>
  );
}

function TraceRow({ row, index }: { row: Row; index: number }) {
  const active = row.state === "active";
  const pending = row.state === "pending";

  return (
    <li
      className={`flex items-baseline gap-3 rounded-[10px] px-3 py-2 transition-[background-color,opacity] duration-300 ${
        active ? "bg-steel-100" : "hover:bg-tint"
      } ${pending ? "opacity-40" : "opacity-100"}`}
    >
      <span className="flex w-4 shrink-0 justify-center self-center">
        {active ? (
          <Ring size={11} />
        ) : (
          <span className="font-head text-steel-400 text-xs tabular-nums">
            {String(index + 1).padStart(2, "0")}
          </span>
        )}
      </span>

      <span
        className={`min-w-0 truncate text-[13.5px] font-medium md:shrink-0 ${
          row.trouble ? "text-alarm" : ""
        } ${active ? "shimmer-text" : ""}`}
      >
        {row.label}
        {active ? "…" : ""}
      </span>

      {row.detail ? (
        <span className="text-ink/40 hidden min-w-0 flex-1 truncate text-xs sm:block">
          {row.detail}
        </span>
      ) : (
        <span className="flex-1" />
      )}

      {/* No time until there is one. A pending step showing 0.0s would read as instant. */}
      <span className="font-head text-ink/40 w-10 shrink-0 text-right text-[13px] tabular-nums">
        {row.durationMs === null || row.state !== "done" ? "" : seconds(row.durationMs)}
      </span>
    </li>
  );
}

/**
 * The number on the collapsed pill, counting up while something is happening.
 *
 * It is anchored to real durations rather than to the wall clock, so it lands on exactly the
 * total the finished trace reports. While a step is in flight it advances from the sum of the
 * finished steps at real speed — which is honest for a live run and, during a replay, means the
 * count races through the same seconds the run actually took.
 */
function useElapsed({
  rows,
  live,
  trueTotal,
  replaying,
}: {
  rows: Row[];
  live: boolean;
  trueTotal: number;
  replaying: boolean;
}): number {
  const settled = rows
    .filter((row) => row.state === "done")
    .reduce((sum, row) => sum + (row.durationMs ?? 0), 0);

  const [drift, setDrift] = useState(0);
  const since = useRef<number>(0);

  useEffect(() => {
    if (!live) {
      setDrift(0);
      return;
    }
    // Restart the within-step clock whenever a step completes.
    since.current = performance.now();
    setDrift(0);

    let frame = 0;
    const tick = () => {
      setDrift(performance.now() - since.current);
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [live, settled]);

  if (!live) return trueTotal;

  // The active step's own duration is the ceiling, so the count never overshoots what the row
  // will report the moment it settles.
  const active = rows.find((row) => row.state === "active");
  const ceiling = replaying && active?.durationMs != null ? active.durationMs : Infinity;
  return settled + Math.min(drift, ceiling);
}
