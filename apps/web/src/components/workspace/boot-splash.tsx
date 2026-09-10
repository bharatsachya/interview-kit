"use client";

import { useEffect, useState } from "react";
import { Mark } from "@/components/industry/mark";

const HOLD_MS = 1500;
const FADE_MS = 420;

/**
 * What the app shows while it is coming up.
 *
 * Rendered on the server as well as the client, and visible from the first paint, so it covers
 * hydration rather than appearing after it — a splash that arrives once the app is already
 * drawn is a worse experience than none at all.
 *
 * It is an overlay on the same ground the app uses, not a layout state. Nothing behind it moves
 * when it goes: the workspace has been sitting there at its final size the whole time, and the
 * splash simply stops being opaque. The element stays mounted through the fade and unmounts
 * after, so the transition has something to run on.
 */
export function BootSplash() {
  const [phase, setPhase] = useState<"holding" | "fading" | "gone">("holding");

  useEffect(() => {
    const hold = setTimeout(() => setPhase("fading"), HOLD_MS);
    const done = setTimeout(() => setPhase("gone"), HOLD_MS + FADE_MS);
    return () => {
      clearTimeout(hold);
      clearTimeout(done);
    };
  }, []);

  if (phase === "gone") return null;

  return (
    <div
      role="status"
      aria-label="Opening your kits"
      className={`bg-paper fixed inset-0 z-100 flex flex-col items-center justify-center gap-5 transition-opacity duration-[420ms] ease-out ${
        phase === "fading" ? "pointer-events-none opacity-0" : "opacity-100"
      }`}
    >
      <Mark size={30} live ring={58} />

      <div className="flex flex-col items-center gap-1.5">
        <p className="font-head text-[15px] font-bold tracking-[0.3em] uppercase">Prep Kit</p>
        <p className="text-ink/45 text-[13px]">Opening your kits…</p>
      </div>

      {/* Indeterminate on purpose. There is no honest percentage for "the app is starting", and
          a bar that fills to 90% and waits is a lie with a progress indicator drawn on it. */}
      <div className="bg-tint h-1 w-[180px] overflow-hidden rounded-full">
        <div className="motion-safe:animate-bar-sweep bg-steel-500 h-full w-[42%] rounded-full" />
      </div>
    </div>
  );
}
