"use client";

import type { Conflict } from "@/lib/use-builder";
import { Button } from "@/components/industry/button";

/**
 * Somebody else changed this kit while you were changing it.
 *
 * Two tabs on one document is the ordinary case, not the exotic one, and the honest response is
 * not an error — it is an offer. The write was refused before anything happened, so nothing is
 * half-applied and the user's own change is still describable.
 *
 * The distinction the two branches draw is the whole reason this is a component rather than a
 * toast. **An edit can be replayed**: `editQuestion(id, { prompt })` means the same thing against
 * version nine that it meant against version seven, so "reload and reapply" does exactly what it
 * says. **A regeneration cannot.** It never ran — the version is checked before a single model
 * call — so running it again is not restoring anything, it is generating new questions that will
 * differ from the ones on screen. Offering both under one button would make that button lie in
 * one of the two cases.
 */
export function ConflictBanner({
  conflict,
  busy,
  onReapply,
  onReload,
  onDismiss,
}: {
  conflict: Conflict;
  busy: boolean;
  onReapply: () => void;
  onReload: () => void;
  onDismiss: () => void;
}) {
  return (
    <div role="alert" className="bg-steel-100 rounded-card flex flex-col gap-2 px-4 py-3">
      <p className="font-head text-steel-700 text-xs tracking-widest uppercase">
        This kit moved on
      </p>

      <p className="text-steel-900 text-[13px] leading-relaxed">
        {conflict.replayable ? (
          <>
            Your change was not saved, because the kit changed somewhere else while you were
            working — it is on version {conflict.currentVersion} now. Nothing was half-applied.
            Reloading and reapplying will make the same change to the newer version.
          </>
        ) : (
          <>
            The regeneration did not run — the kit changed somewhere else first, and it is on
            version {conflict.currentVersion} now. Nothing was generated and nothing was spent.
            Running it again will work from the newer kit, so it will produce different questions
            from the ones you were looking at, not bring these back.
          </>
        )}
      </p>

      <div className="flex flex-wrap items-center gap-2 pt-0.5">
        {conflict.replayable ? (
          <Button variant="primary" onClick={onReapply} busy={busy} busyLabel="Reapplying">
            Reload and reapply
          </Button>
        ) : (
          <Button variant="secondary" onClick={onReload}>
            Reload the kit
          </Button>
        )}
        <Button variant="ghost" onClick={onDismiss}>
          Dismiss
        </Button>
      </div>
    </div>
  );
}
