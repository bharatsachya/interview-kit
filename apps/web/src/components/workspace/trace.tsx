"use client";

import { useState } from "react";
import type { Span } from "@trao/contracts";
import { seconds } from "@/lib/kit-outputs";
import { spanConsequence, spanResult, spanTone, stepLabel, toStreamRows } from "@/lib/spans";

/**
 * The trace, collapsed to one line.
 *
 * A finished run does not need to keep showing its own working, but it must not throw it away
 * either: the whole argument of this product is that the schedule and the coverage check are
 * arithmetic rather than something a model asserted, and the trace is where that stops being a
 * claim. So it stays, one pill high, and opens when someone wants it.
 *
 * Every row is read from a real span. The detail clause is whatever attributes the pipeline
 * actually recorded, and a step that recorded nothing shows no clause rather than a sentence
 * invented to fill the space.
 */
export function Trace({ spans, defaultOpen = false }: { spans: Span[]; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);

  const rows = toStreamRows(spans);
  if (rows.length === 0) return null;

  const total = rows.reduce((sum, span) => sum + span.durationMs, 0);

  return (
    <div className="flex flex-col gap-1.5">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className={`font-head rounded-pill inline-flex h-7 w-fit items-center gap-2 px-3 text-xs tracking-widest uppercase transition-colors ${
          open ? "bg-steel-100 text-steel-700" : "bg-tint text-ink/55 hover:bg-steel-100 hover:text-steel-700"
        }`}
      >
        <span>
          Trace · {rows.length} {rows.length === 1 ? "step" : "steps"}
        </span>
        <span className="tracking-normal tabular-nums">{seconds(total)}</span>
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

      {open ? (
        <ol className="flex list-none flex-col gap-0.5 pt-0.5">
          {rows.map((span, index) => (
            <TraceRow key={span.id} span={span} index={index} />
          ))}
        </ol>
      ) : null}
    </div>
  );
}

function TraceRow({ span, index }: { span: Span; index: number }) {
  const tone = spanTone(span);
  const result = spanResult(span);
  const consequence = spanConsequence(span);

  // Failure is the one place the row says two things: what broke, and what the kit still has.
  // A red line with no second clause reads as "your kit is ruined", which is almost never true.
  const detail = [result, tone === "trouble" ? consequence : null].filter(Boolean).join(" — ");

  return (
    <li className="hover:bg-tint flex items-baseline gap-3 rounded-[10px] px-3 py-2 transition-colors">
      <span className="font-head text-steel-400 w-4 shrink-0 text-xs tabular-nums">
        {String(index + 1).padStart(2, "0")}
      </span>
      <span
        className={`min-w-0 truncate text-[13.5px] font-medium md:shrink-0 ${tone === "trouble" ? "text-alarm" : ""}`}
      >
        {stepLabel(span.step, span.attrs)}
      </span>
      {/* The detail clause is the first thing to go when the row runs out of width, and it is
          dropped entirely below `sm` — the step and how long it took are the row's point. */}
      {detail ? (
        <span className="text-ink/40 hidden min-w-0 flex-1 truncate text-xs sm:block">{detail}</span>
      ) : (
        <span className="flex-1" />
      )}
      <span className="font-head text-ink/40 shrink-0 text-[13px] tabular-nums">
        {seconds(span.durationMs)}
      </span>
    </li>
  );
}
