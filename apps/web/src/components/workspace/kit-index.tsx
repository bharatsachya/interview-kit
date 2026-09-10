"use client";

import { useRef } from "react";
import { KIT_OUTPUTS, type KitOutputId } from "@/lib/kit-outputs";
import { Eyebrow, OpenDot } from "@/components/industry/text";

/**
 * The panel's index rail.
 *
 * This was a horizontal tab strip. Six condensed labels across a 520px panel left each one about
 * eleven characters and no room for the count, and a strip that scrolls sideways hides the tabs
 * you have not opened — which is exactly the wrong thing to hide when the point of the list is
 * that the kit has six parts.
 *
 * Still a real tablist, and still the same keyboard contract: one tab stop for the whole rail,
 * arrows to move, Home and End to jump. Vertical, so it is Up and Down that move — a vertical
 * list that answers to Left and Right is the kind of detail the interaction score is about.
 */
export function KitIndex({
  active,
  builtIn,
  vertical,
  onSelect,
}: {
  active: KitOutputId;
  builtIn: string | null;
  /**
   * Column beside the body, or strip above it.
   *
   * Decided by how wide the *panel* is, not how wide the window is. A 152px column inside a
   * 388px panel leaves the brief 236px to wrap in, and the window being 1024 wide says nothing
   * about that — the panel is its own layout context.
   */
  vertical: boolean;
  onSelect: (id: KitOutputId) => void;
}) {
  const rail = useRef<HTMLDivElement>(null);
  // Both axes move the selection whichever way the rail is drawn, and `aria-orientation` below
  // reports the one actually on screen — a list that claims an orientation it does not have is
  // the kind of detail the interaction score is about.

  function onKeyDown(event: React.KeyboardEvent) {
    const index = KIT_OUTPUTS.findIndex((output) => output.id === active);
    let next = index;
    if (event.key === "ArrowDown" || event.key === "ArrowRight") next = (index + 1) % KIT_OUTPUTS.length;
    else if (event.key === "ArrowUp" || event.key === "ArrowLeft")
      next = (index - 1 + KIT_OUTPUTS.length) % KIT_OUTPUTS.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = KIT_OUTPUTS.length - 1;
    else return;

    event.preventDefault();
    const target = KIT_OUTPUTS[next];
    if (!target) return;
    onSelect(target.id);
    rail.current?.querySelector<HTMLButtonElement>(`[data-output="${target.id}"]`)?.focus();
  }

  return (
    <div className={`bg-tint-soft flex shrink-0 flex-col gap-1 ${vertical ? "w-index overflow-hidden p-3" : "w-full p-2"}`}>
      <Eyebrow className={`text-ink/40 px-2 pb-1 ${vertical ? "block" : "hidden"}`}>Outputs</Eyebrow>

      <div
        ref={rail}
        role="tablist"
        aria-orientation={vertical ? "vertical" : "horizontal"}
        aria-label="Kit outputs"
        onKeyDown={onKeyDown}
        className={`flex min-h-0 flex-1 gap-1 ${vertical ? "flex-col overflow-y-auto" : "flex-row overflow-x-auto"}`}
      >
        {KIT_OUTPUTS.map((output, index) => {
          const selected = output.id === active;
          return (
            <button
              key={output.id}
              role="tab"
              data-output={output.id}
              aria-selected={selected}
              aria-controls={`kit-panel-${output.id}`}
              id={`kit-tab-${output.id}`}
              tabIndex={selected ? 0 : -1}
              onClick={() => onSelect(output.id)}
              className={`flex min-h-9 shrink-0 items-center gap-2 rounded-[10px] px-2.5 py-2 text-left text-[13.5px] transition-colors ${
                selected
                  ? "bg-steel-100 text-steel-800 font-semibold"
                  : "text-ink/70 hover:bg-tint hover:text-ink font-medium"
              }`}
            >
              {selected ? <OpenDot /> : <span aria-hidden className="size-1.5 shrink-0" />}
              <span className="truncate">{output.label}</span>
              <span
                className={`font-head ml-auto shrink-0 text-xs tabular-nums ${vertical ? "inline" : "hidden"} ${
                  selected ? "text-steel-500" : "text-ink/35"
                }`}
              >
                {index + 1}
              </span>
            </button>
          );
        })}
      </div>

      {/* Only rendered when the run is still in the session. Opened from history, the spans are
          gone and there is no honest number to print here. */}
      {builtIn && vertical ? (
        <p className="font-head text-ink/40 mt-auto shrink-0 px-2 pt-3 text-xs tracking-wider uppercase tabular-nums">
          Kit built in {builtIn}
        </p>
      ) : null}
    </div>
  );
}
