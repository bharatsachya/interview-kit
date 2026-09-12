"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Span } from "@trao/contracts";
import type { InternalKit, QuestionCategory } from "@trao/kit";
import { KIT_OUTPUTS, outputCount, outputDuration, outputText, type KitOutputId } from "@/lib/kit-outputs";
import { Button, IconButton } from "@/components/industry/button";
import { ErrorNotice, Loading, Skeleton } from "@/components/industry/states";
import { Kicker } from "@/components/industry/text";
import type { BuilderState } from "@/lib/use-builder";
import { ConflictBanner } from "@/components/workspace/conflict-banner";
import { KitIndex } from "@/components/workspace/kit-index";
import { KitOutputBody } from "@/components/workspace/kit-outputs-body";
import { usePractice } from "@/lib/use-practice";
import { api } from "@/lib/api/client";
import { copyText } from "@/lib/copy";
import type { Rewrite } from "@/lib/rewrite";

/**
 * The panel's contents: remember where you were in the kit, and render one output of it.
 *
 * Everything it draws comes from `getKitForBuilder` on the server — active items only, with
 * provenance intact. Archived items never arrive here, so no view can render one by mistake.
 *
 * Scroll position is remembered per kit and per output. This component is never unmounted while
 * the panel is closed (the panel animates to zero width instead), so closing and reopening
 * restores exactly what you were looking at; switching kits and coming back restores it too,
 * because the positions are keyed by kit and output rather than held in the DOM.
 *
 * Which output is open is owned by the workspace, not by this component: the card grid in the
 * conversation selects it too, and two components each holding their own idea of "the open one"
 * is how the dot ends up on a different card than the panel is showing.
 */
export function KitDrawer({
  kitId,
  builder,
  kit,
  loading,
  error,
  onRetry,
  spans,
  activeOutput,
  indexVertical,
  onSelectOutput,
  onClose,
  expanded,
  onToggleExpand,
  onRewrite,
}: {
  kitId: string | null;
  builder: BuilderState;
  kit: InternalKit | null;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  spans: readonly Span[];
  activeOutput: KitOutputId;
  indexVertical: boolean;
  onSelectOutput: (id: KitOutputId) => void;
  onClose: () => void;
  /** Whether the panel has taken the whole window. Only ever true where there is a window to take. */
  expanded: boolean;
  onToggleExpand: () => void;
  /** Stage a rewrite of one section in the composer. Nothing is sent from this panel. */
  onRewrite: (target: Pick<Rewrite, "section" | "category">) => void;
}) {

  // Flashcard confidence comes from the server now, keyed by kit by the hook itself. It used to
  // be a `useState` here, which meant a reload threw away every rating — and the deck tells the
  // user their ratings feed the weak-spots report, which a report rebuilt from nothing on every
  // refresh does not honour.
  //
  // The questions track filter stays local: it is a filter on what is on screen, it means
  // nothing tomorrow, and Practice's Start hands it to Questions on its way out.
  const practice = usePractice(kitId);
  const [track, setTrack] = useState<QuestionCategory | null>(null);

  // Copy puts the open output on the clipboard; Export downloads the whole kit as Appendix A.
  const copyState = useTransientAction("Copy");
  const exportState = useTransientAction("Export");

  const copyOutput = useCallback(async () => {
    if (kit === null) return;
    // `copyText` returns a boolean rather than throwing, because a button that says "Copied"
    // when nothing was copied is worse than one that quietly does nothing.
    copyState.settle(await copyText(outputText(activeOutput, kit)), "Copied", "Could not copy");
  }, [kit, activeOutput, copyState]);

  const exportKit = useCallback(async () => {
    if (kitId === null) return;
    exportState.start();
    try {
      const json = await api.exportKit(kitId);
      download(`kit-${kitId}.json`, JSON.stringify(json, null, 2));
      exportState.settle(true, "Downloaded", "");
    } catch {
      exportState.settle(false, "", "Could not export");
    }
  }, [kitId, exportState]);

  const scroller = useRef<HTMLDivElement>(null);
  const positions = useRef(new Map<string, number>());

  const scrollKey = `${kitId ?? ""}:${activeOutput}`;

  // Restoring scroll is a DOM write, not state, so it belongs in an effect and nowhere else.
  useEffect(() => {
    const element = scroller.current;
    if (!element) return;
    element.scrollTop = positions.current.get(scrollKey) ?? 0;
  }, [scrollKey, kit]);

  const onScroll = useCallback(() => {
    const element = scroller.current;
    if (element) positions.current.set(scrollKey, element.scrollTop);
  }, [scrollKey]);

  const output = KIT_OUTPUTS.find((entry) => entry.id === activeOutput) ?? KIT_OUTPUTS[0];
  const builtIn = totalDuration(spans);

  if (kitId === null) {
    return (
      <div className="flex h-full w-full items-center justify-center p-6">
        <p className="text-ink/55 text-sm">No kit open.</p>
      </div>
    );
  }

  return (
    <>
      <KitIndex active={activeOutput} builtIn={builtIn} vertical={indexVertical} onSelect={onSelectOutput} />

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex shrink-0 flex-col gap-0.5 px-4 pt-3 pb-3 md:px-5 md:pt-4">
          <div className="flex items-center gap-2">
            <Kicker>{output.kicker}</Kicker>
            <span className="ml-auto flex shrink-0 items-center gap-0.5">
              {/* Both of these rendered for a while with no `onClick` at all — icons that looked
                  like controls and were decoration. `IconButton` already draws its `label` as a
                  tooltip, so changing the label is the whole feedback mechanism: the pointer is
                  still over the button at the moment it matters. */}
              <IconButton label={copyState.label} onClick={() => void copyOutput()} disabled={copyState.busy}>
                {copyState.done ? <TickIcon /> : <CopyIcon />}
              </IconButton>
              <IconButton label={exportState.label} onClick={() => void exportKit()} disabled={exportState.busy}>
                {exportState.done ? <TickIcon /> : <ExportIcon />}
              </IconButton>
              {/* Reading is the other half of what this panel is for, and a question with a
                  long answer outline is cramped in a third of the window. Beside Close rather
                  than in a menu: it is a two-state toggle people flip constantly. Hidden below
                  lg, where the panel is already a full-screen sheet and there is nothing to
                  expand into. */}
              <IconButton
                label={expanded ? "Shrink the kit panel" : "Expand the kit panel"}
                onClick={onToggleExpand}
                className="hidden lg:inline-grid"
              >
                {expanded ? <ShrinkIcon /> : <ExpandIcon />}
              </IconButton>
              <IconButton label="Close the kit panel" onClick={onClose}>
                <CloseIcon />
              </IconButton>
            </span>
          </div>
          <h2 className="text-2xl">{output.label}</h2>
          {kit ? (
            <p className="text-ink/55 mt-0.5 text-xs">
              {outputCount(output.id, kit)}
              {outputDuration(output.id, spans) ? ` · built in ${outputDuration(output.id, spans)}` : ""}
            </p>
          ) : null}
        </header>

        {builder.conflict ? (
          <div className="shrink-0 px-4 pb-3 md:px-5">
            <ConflictBanner
              conflict={builder.conflict}
              busy={builder.busy !== null}
              onReapply={builder.reapply}
              onReload={builder.refetch}
              onDismiss={builder.dismissConflict}
            />
          </div>
        ) : null}

        <div ref={scroller} onScroll={onScroll} className="min-h-0 flex-1 overflow-y-auto">
          {loading ? (
            <div className="flex flex-col gap-4 p-4 md:p-5">
              <Loading label="Opening the kit" />
              <Skeleton lines={3} />
              <Skeleton lines={4} />
            </div>
          ) : error ? (
            <div className="p-4 md:p-5">
              <ErrorNotice
                title="Could not open this kit"
                actions={
                  <Button variant="secondary" onClick={onRetry}>
                    Try again
                  </Button>
                }
              >
                {error}
              </ErrorNotice>
            </div>
          ) : kit ? (
            <KitOutputBody
              output={activeOutput}
              builder={builder}
              kit={kit}
              confidence={practice.confidence}
              deck={practice.deck}
              practiceError={practice.error}
              onRate={practice.rate}
              track={track}
              onTrack={setTrack}
              onOpenOutput={onSelectOutput}
              onRewrite={onRewrite}
            />
          ) : null}
        </div>
      </div>
    </>
  );
}

/** The whole run, as one number. Null when the spans are not in this session. */
function totalDuration(spans: readonly Span[]): string | null {
  if (spans.length === 0) return null;
  const parentIds = new Set(
    spans.map((span) => span.parentId).filter((id): id is string => id !== null),
  );
  const total = spans
    .filter((span) => !parentIds.has(span.id))
    .reduce((sum, span) => sum + span.durationMs, 0);
  return total === 0 ? null : `${(total / 1000).toFixed(1)}s`;
}

function CopyIcon() {
  return (
    <svg
      aria-hidden
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  );
}

function ExportIcon() {
  return (
    <svg
      aria-hidden
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="17 8 12 3 7 8" />
      <line x1="12" y1="3" x2="12" y2="15" />
    </svg>
  );
}

/** Arrows to the corners: the panel taking the window. Paired with ShrinkIcon, which reverses it. */
function ExpandIcon() {
  return (
    <svg aria-hidden width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 21H5a2 2 0 0 1-2-2v-4M15 3h4a2 2 0 0 1 2 2v4M21 15v4a2 2 0 0 1-2 2h-4M3 9V5a2 2 0 0 1 2-2h4" />
    </svg>
  );
}

function ShrinkIcon() {
  return (
    <svg aria-hidden width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 3v4a2 2 0 0 1-2 2H3M21 9h-4a2 2 0 0 1-2-2V3M15 21v-4a2 2 0 0 1 2-2h4M3 15h4a2 2 0 0 1 2 2v4" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg
      aria-hidden
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
    >
      <path d="M18 6L6 18M6 6l12 12" />
    </svg>
  );
}

/**
 * A control that reports what it just did, in its own label, and then forgets.
 *
 * `IconButton` renders its `label` as a hover tooltip, and the pointer is still over the button
 * in the moment after a click — so the label is the feedback surface an icon-only control
 * already has, and no new component is needed to say "Copied".
 *
 * The reset matters as much as the message: a tick that stays a tick makes the next click look
 * like it did nothing. `done` also drives the icon swap, so the two cannot disagree.
 */
function useTransientAction(idle: string) {
  const [label, setLabel] = useState(idle);
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => () => clearTimeout(timer.current), []);

  const reset = useCallback(() => {
    setLabel(idle);
    setDone(false);
  }, [idle]);

  const settle = useCallback(
    (ok: boolean, success: string, failure: string) => {
      setBusy(false);
      setDone(ok);
      setLabel(ok ? success : failure);
      clearTimeout(timer.current);
      // Failure lingers, because it is the one a reader has to notice and might look away from.
      timer.current = setTimeout(reset, ok ? 1_600 : 2_600);
    },
    [reset],
  );

  const start = useCallback(() => setBusy(true), []);

  return { label, done, busy, start, settle };
}

/**
 * Hand a file to the browser.
 *
 * An object URL rather than a `data:` one: a kit is tens of kilobytes of JSON, and a data URL
 * that long is a URL some browsers refuse. Revoked on the next frame — revoking synchronously
 * cancels the download in Safari, and never revoking leaks the blob for the life of the tab.
 */
function download(filename: string, contents: string): void {
  const url = URL.createObjectURL(new Blob([contents], { type: "application/json" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

function TickIcon() {
  return (
    <svg aria-hidden width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3.5 8.5l3 3 6-7" />
    </svg>
  );
}
