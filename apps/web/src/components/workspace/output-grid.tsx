"use client";

import type { Span } from "@trao/contracts";
import type { InternalKit } from "@trao/kit";
import { KIT_OUTPUTS, outputCount, outputDuration, type KitOutputId } from "@/lib/kit-outputs";
import { Kicker, OpenDot } from "@/components/industry/text";

/**
 * The six outputs, as a grid you open one of.
 *
 * This is the result of the run, sitting in the conversation where the result belongs, rather
 * than a "your kit is ready" line with nothing under it. Clicking a card opens that output in
 * the panel — the same selection the index rail drives, which is why both read their labels
 * from `KIT_OUTPUTS` and both draw the accent dot on whichever one is open.
 */
export function OutputGrid({
  kit,
  spans,
  activeId,
  onOpen,
}: {
  kit: InternalKit;
  spans: readonly Span[];
  activeId: KitOutputId | null;
  onOpen: (id: KitOutputId) => void;
}) {
  return (
    <ul className="@sm:grid-cols-2 @xl:grid-cols-3 grid list-none grid-cols-1 gap-3">
      {KIT_OUTPUTS.map((output) => {
        const open = output.id === activeId;
        const took = outputDuration(output.id, spans);
        return (
          <li key={output.id} className="flex">
            <button
              type="button"
              onClick={() => onOpen(output.id)}
              aria-current={open ? "true" : undefined}
              className={`rounded-card flex h-full w-full flex-col items-start gap-0.5 p-4 text-left transition-all duration-150 ${
                open
                  ? "bg-steel-100"
                  : "bg-tint hover:bg-steel-100 hover:-translate-y-0.5 hover:shadow-[0_6px_16px_rgba(35,51,67,0.09)]"
              }`}
            >
              <span className="flex items-center gap-1.5">
                {open ? <OpenDot /> : null}
                <Kicker>{output.kicker}</Kicker>
              </span>
              <span
                className={`font-head text-[19px] font-semibold ${open ? "text-steel-800" : ""}`}
              >
                {output.label}
              </span>
              <span className="text-ink/55 text-xs">
                {outputCount(output.id, kit)}
                {took ? ` · ${took}` : ""}
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
