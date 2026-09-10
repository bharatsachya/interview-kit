import type { ReactNode } from "react";
import { Mark } from "@/components/industry/mark";

/**
 * A line from the assistant, marked by the registration glyph.
 *
 * The glyph is the same object in both states — it comes alive while a run is going and settles
 * when the run does. That is the reason it exists rather than a spinner: a spinner would have to
 * be swapped for something else at the end, and the swap is the moment the interface stops
 * feeling like one thing.
 *
 * The 30px box is held whatever the mark is doing. The ring appears and disappears inside it, so
 * a run settling does not nudge the sentence beside it sideways.
 */
export function Assistant({ children, live = false }: { children: ReactNode; live?: boolean }) {
  return (
    <div className="flex items-start gap-2.5">
      <span className="mt-px grid size-[30px] shrink-0 place-items-center">
        <Mark size={22} live={live} ring={live ? 30 : false} />
      </span>
      <p className="pt-1 text-[14.5px] leading-relaxed">{children}</p>
    </div>
  );
}
