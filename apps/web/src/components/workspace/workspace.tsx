"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import type { Span } from "@trao/contracts";
import { api } from "@/lib/api/client";
import type { KitSummary } from "@/lib/api/types";
import { KIT_OUTPUTS, seconds, type KitOutputId } from "@/lib/kit-outputs";
import { DESKTOP, WIDE, useMediaQuery } from "@/lib/use-media-query";
import { useHydrated } from "@/lib/use-hydrated";
import { copyText } from "@/lib/copy";
import { useBuilder } from "@/lib/use-builder";
import { useResizable } from "@/lib/use-resizable";
import { Button } from "@/components/industry/button";
import { Assistant } from "@/components/workspace/assistant";
import { BootSplash } from "@/components/workspace/boot-splash";
import { CompareView } from "@/components/workspace/compare-view";
import { Composer } from "@/components/workspace/composer";
import { GenerationStream } from "@/components/workspace/generation-stream";
import { HistorySidebar } from "@/components/workspace/history-sidebar";
import { KitDrawer } from "@/components/workspace/kit-drawer";
import { KitPanel } from "@/components/workspace/kit-panel";
import { OutputGrid } from "@/components/workspace/output-grid";
import { ResizeHandle } from "@/components/workspace/resize-handle";
import { Trace } from "@/components/workspace/trace";

/** Below this the panel cannot spare 152px for a column of labels, so the index lies down. */
const INDEX_RAIL_MIN_PANEL = 448;

/** What a finished run left behind: the kit it made, and the trace that proves how. */
interface Run {
  jobId: string;
  kitId: string;
  spans: Span[];
  ask: string;
}

/**
 * The workspace: history on the left, the conversation in the middle, the kit on the right.
 *
 * One route holds all three. Selecting a kit or starting a run changes state here rather than
 * navigating, because a navigation would remount the shell — and remounting is what loses the
 * panel's scroll position, the conversation so far, and the animation you were in the middle of.
 *
 * The URL still carries `?kit=` and `?jobs=` so a run or a kit can be linked to. It is written
 * with `history.replaceState` rather than the router: the router would round-trip to the server
 * to re-render a page whose only job is to mount this component.
 *
 * Which of the six outputs is open lives here rather than in the panel, because two things
 * select it — the card grid in the conversation and the index rail in the panel — and two
 * components each holding their own idea of "the open one" is how the accent dot ends up on a
 * different card than the panel is showing.
 */
export function Workspace() {
  const searchParams = useSearchParams();

  // Read once. After mount this component owns the state and mirrors it back to the URL.
  const [activeKitId, setActiveKitId] = useState<string | null>(() => searchParams.get("kit"));
  const [jobIds, setJobIds] = useState<string[]>(() => splitIds(searchParams.get("jobs")));

  const [panelOpen, setPanelOpen] = useState(() => searchParams.get("kit") !== null);
  const [activeOutput, setActiveOutput] = useState<KitOutputId>("brief");
  // The centre column has two things it can be: the conversation, or the comparison across
  // kits. Not a route — navigating would remount the shell and lose the run in progress.
  const [comparing, setComparing] = useState(false);

  // Finished runs, keyed by job. The spans are what the trace and the per-output build times are
  // read from — a kit opened from history has none, and both simply say less rather than guess.
  const [runs, setRuns] = useState<Record<string, Run>>({});
  // The ask and the moment it was made. The time is captured at submit rather than derived from
  // the job later: what the conversation shows is when *you* sent it, which is not the same as
  // when the server got round to it.
  const [asks, setAsks] = useState<Record<string, { text: string; at: number }>>({});

  // The history column follows the viewport until somebody says otherwise: open on a laptop,
  // closed on a phone. `null` means "no opinion yet", which is what keeps the default from
  // being sticky the first time the window is resized across the breakpoint.
  const isDesktop = useMediaQuery(DESKTOP);
  // The rail can be a column from 768 up; the panel needs 1024 before it can sit beside the
  // conversation instead of over it.
  const isWide = useMediaQuery(WIDE);
  const [historyOverride, setHistoryOverride] = useState<boolean | null>(null);
  const historyOpen = historyOverride ?? isDesktop;

  const [kits, setKits] = useState<KitSummary[]>([]);
  const [kitsLoading, setKitsLoading] = useState(true);
  const [kitsError, setKitsError] = useState<string | null>(null);
  const [historyNonce, setHistoryNonce] = useState(0);

  const [staleKitId, setStaleKitId] = useState<string | null>(null);

  const forgetStaleKit = useCallback((missingId: string) => {
    setStaleKitId(missingId);
    setActiveKitId(null);
    setPanelOpen(false);
  }, []);

  // One builder for the whole workspace, so the output grid counts the same kit the panel edits
  // and deleting a question updates the card in the conversation without a second fetch.
  const builder = useBuilder(activeKitId, forgetStaleKit);
  const { kit, loading: kitLoading, error: kitError } = builder;
  const retryKit = builder.refetch;

  /**
   * A `?kit=` pointing at a kit that is not there.
   *
   * Reached by a bookmark, a shared link, or a tab left open across a change of storage — the
   * id survives in the URL long after the thing it names. Left alone it is a trap: the panel
   * shows an error with a Try again that can never succeed, and reloading replays it forever
   * because the dead id is still in the address bar.
   *
   * So the id is dropped, the panel closes, and the workspace says once what happened. The
   * conversation and anything running are untouched — only the pointer was stale.
   */

  useEffect(() => {
    const controller = new AbortController();
    api
      .listKits(controller.signal)
      .then((view) => {
        setKits(view.kits);
        setKitsError(null);
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setKitsError(error instanceof Error ? error.message : "Could not load your kits.");
      })
      .finally(() => {
        if (!controller.signal.aborted) setKitsLoading(false);
      });
    return () => controller.abort();
  }, [historyNonce]);

  useEffect(() => {
    const query = new URLSearchParams();
    if (jobIds.length > 0) query.set("jobs", jobIds.join(","));
    if (activeKitId) query.set("kit", activeKitId);
    const search = query.toString();
    window.history.replaceState(null, "", search === "" ? window.location.pathname : `?${search}`);
  }, [jobIds, activeKitId]);

  const closePanel = useCallback(() => setPanelOpen(false), []);

  // Escape closes the panel. Registered once, on the document, because focus could legitimately
  // be anywhere inside the panel when someone reaches for it.
  useEffect(() => {
    if (!panelOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") closePanel();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [panelOpen, closePanel]);

  const selectKit = useCallback((kitId: string) => {
    setStaleKitId(null);
    setActiveKitId(kitId);
    setComparing(false);
    setPanelOpen(true);
    setHistoryOverride((open) => (open === true ? null : open));
  }, []);

  const openOutput = useCallback((id: KitOutputId) => {
    setActiveOutput(id);
    setPanelOpen(true);
  }, []);

  const startNew = useCallback(() => {
    setStaleKitId(null);
    setComparing(false);
    setJobIds([]);
    setActiveKitId(null);
    setPanelOpen(false);
    setHistoryOverride((open) => (open === true ? null : open));
  }, []);

  const startRun = useCallback((ids: string[], ask: string) => {
    setStaleKitId(null);
    setComparing(false);
    setJobIds(ids);
    setActiveKitId(null);
    setPanelOpen(false);
    const at = Date.now();
    setAsks((previous) => {
      const next = { ...previous };
      for (const id of ids) next[id] = { text: ask, at };
      return next;
    });
  }, []);

  // The panel opens on the first kit to finish. In a batch the others are reachable from
  // history; opening and reopening the drawer under someone as each one lands would be hostile.
  const onKitReady = useCallback(
    (jobId: string, kitId: string, spans: Span[]) => {
      setRuns((previous) => ({
        ...previous,
        [jobId]: { jobId, kitId, spans, ask: asks[jobId]?.text ?? "" },
      }));
      setKitsLoading(true);
      setHistoryNonce((nonce) => nonce + 1);
      setActiveKitId((current) => current ?? kitId);
      setPanelOpen(true);
    },
    [asks],
  );

  // Both edges are draggable and both collapse, and the two are the same property: collapsed
  // is width zero. The defaults match the CSS tokens the server renders with, so nothing jumps
  // when the remembered width takes over after hydration.
  const hydrated = useHydrated();
  const sidebarResize = useResizable({
    storageKey: "workspace.sidebar.width",
    defaultWidth: 216,
    min: 192,
    max: 448,
    edge: "right",
    label: "Resize the history column",
    onToggle: () => setHistoryOverride(!historyOpen),
  });
  const panelResize = useResizable({
    // The rail is standing in the same viewport, so the panel may not count its width as space
    // it could take. Zero when the rail is collapsed, which is when the panel really can be wider.
    reserve: historyOpen && isDesktop ? sidebarResize.width : 0,
    storageKey: "workspace.panel.width",
    defaultWidth: 520,
    min: 380,
    max: 880,
    edge: "left",
    label: "Resize the kit panel",
    onToggle: closePanel,
  });

  // One decision, read by the panel and by the rail inside it.
  const railBeside = isWide && panelResize.width >= INDEX_RAIL_MIN_PANEL;

  const activeKitSummary = kits.find((entry) => entry.id === activeKitId) ?? null;
  const activeRun = Object.values(runs).find((run) => run.kitId === activeKitId) ?? null;
  const running = jobIds.some((jobId) => runs[jobId] === undefined);
  const sidebarSized = hydrated && isDesktop;

  const spans = activeRun?.spans ?? [];
  const elapsed = spans.length > 0 ? seconds(totalMs(spans)) : null;

  return (
    <>
      <BootSplash />
      <div className="fixed inset-0 overflow-hidden">
      <div className="flex h-full w-full overflow-hidden">
        {/* Left region. A column on a laptop, a drawer over the left edge on a phone. */}
        {historyOpen && !isDesktop ? (
          <button
            type="button"
            aria-label="Close history"
            onClick={() => setHistoryOverride(false)}
            className="bg-ink/40 fixed inset-0 z-30 md:hidden"
          />
        ) : null}
        <div
          style={sidebarSized ? { width: historyOpen ? sidebarResize.width : 0 } : undefined}
          className={`fixed inset-y-0 left-0 z-40 shrink-0 overflow-hidden duration-300 ease-out md:relative md:inset-y-auto md:z-auto ${
            sidebarResize.dragging ? "" : "motion-safe:transition-[width,transform]"
          } ${historyOpen ? "w-sidebar translate-x-0" : "w-sidebar -translate-x-full md:w-0 md:translate-x-0"}`}
        >
          {historyOpen ? (
            <ResizeHandle
              edge="right"
              separatorProps={sidebarResize.separatorProps}
              dragging={sidebarResize.dragging}
            />
          ) : null}
          <div
            style={sidebarSized ? { width: sidebarResize.width } : undefined}
            className="w-sidebar h-full"
          >
            <HistorySidebar
              comparing={comparing}
              onCompare={() => setComparing(true)}
              kits={kits}
              loading={kitsLoading}
              error={kitsError}
              activeKitId={activeKitId}
              onSelect={selectKit}
              onNew={startNew}
              onRetry={() => {
                setKitsLoading(true);
                setHistoryNonce((nonce) => nonce + 1);
              }}
            />
          </div>
        </div>

        {/* Centre region: the conversation. */}
        <main className="flex min-w-0 flex-1 flex-col">
          {/* The phone's only route back to the rail. The desktop header renders solely when
              there is a kit or a run to describe, which on a laptop is fine — the rail is a
              column you can already see. On a phone the rail is a drawer, so with no kit open
              there would be no way to reach history at all. */}
          <div className="flex shrink-0 items-center gap-2 px-3 pt-3 md:hidden">
            <Button
              variant="ghost"
              onClick={() => setHistoryOverride(!historyOpen)}
              aria-expanded={historyOpen}
              aria-label={historyOpen ? "Hide history" : "Show history"}
            >
              <svg
                aria-hidden
                width="16"
                height="16"
                viewBox="0 0 16 16"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
              >
                <path d="M2 4h12M2 8h12M2 12h12" />
              </svg>
              History
            </Button>
            <span className="font-head ml-auto text-sm font-bold tracking-[0.16em] uppercase">
              Prep Kit
            </span>
            {activeKitId && !panelOpen ? (
              <Button variant="secondary" onClick={() => setPanelOpen(true)}>
                Kit
              </Button>
            ) : null}
          </div>

          {/* The header only exists once there is something for it to describe. On an empty
              workspace it would say the product's name back to someone who just opened it, and
              the composer below already asks the question. */}
          {(activeKitSummary || running) && !comparing ? (
            <header className="shrink-0 px-4 pt-4 pb-3 md:px-8 md:pt-5 md:pb-4">
              <div className="max-w-centre mx-auto flex items-start gap-4">
                <div className="min-w-0">
                  <h1 className="truncate text-[22px] md:text-[27px]">
                    {activeKitSummary
                      ? `${activeKitSummary.company} — ${activeKitSummary.title}`
                      : "Building your kit"}
                  </h1>
                  <p className="text-ink/55 mt-1 text-xs">
                    {activeKitSummary
                      ? `${activeKitSummary.days === 1 ? "1 day" : `${activeKitSummary.days} days`} until the interview`
                      : "Reading the posting, then the site."}
                  </p>
                </div>
                <div className="ml-auto flex shrink-0 items-center gap-2.5 pt-1">
                  {running ? (
                    <span className="bg-steel-100 text-steel-700 font-head rounded-pill inline-flex h-6 items-center gap-1.5 px-3 text-xs tracking-widest uppercase">
                      <span
                        aria-hidden
                        className="bg-steel-500 motion-safe:animate-dot-blink size-1.5 rounded-full"
                      />
                      Running
                    </span>
                  ) : activeKitId && !kitLoading ? (
                    <span className="bg-steel-100 text-steel-700 font-head rounded-pill inline-flex h-6 items-center px-3 text-xs tracking-widest uppercase">
                      Complete
                    </span>
                  ) : null}
                  {elapsed ? (
                    <span className="font-head text-ink/40 text-[17px] tabular-nums">{elapsed}</span>
                  ) : null}
                  {activeKitId && !panelOpen ? (
                    <Button variant="secondary" onClick={() => setPanelOpen(true)}>
                      Open kit
                    </Button>
                  ) : null}
                </div>
              </div>
            </header>
          ) : null}

          <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-4 md:px-8">
            {/* A query container, so what is inside responds to this column's real width. The
                  output grid used viewport breakpoints, which is wrong in a three-pane layout:
                  at 1180px the viewport says "wide, three columns" while this column is 444px
                  and the cards are 140px each. */}
              <div className="@container max-w-centre mx-auto flex w-full flex-1 flex-col gap-5 pb-6">
              {staleKitId ? (
                <div className="bg-tint rounded-card flex items-start gap-3 px-4 py-3">
                  <p className="text-ink/70 min-w-0 flex-1 text-[13px] leading-relaxed">
                    That link points at a kit that no longer exists, so it has been cleared from
                    the address bar. Anything in your history is still here.
                  </p>
                  <Button variant="ghost" onClick={() => setStaleKitId(null)} className="shrink-0">
                    Dismiss
                  </Button>
                </div>
              ) : null}

              {comparing ? (
                <CompareView kits={kits} onOpenKit={selectKit} onClose={() => setComparing(false)} />
              ) : jobIds.length === 0 && !activeKitId ? (
                <div className="flex flex-1 flex-col justify-center gap-2 py-10">
                  <h1 className="text-[26px] md:text-[34px]">What are you preparing for?</h1>
                  <p className="text-ink/55 text-[14px] md:text-[15px]">
                    Paste the posting, tell us where they live on the web, and how long you have.
                  </p>
                </div>
              ) : (
                <>
                  {jobIds.map((jobId) => {
                    const run = runs[jobId];
                    const ask = asks[jobId];
                    return (
                      <div key={jobId} className="flex flex-col gap-5">
                        {ask ? <AskBubble at={ask.at}>{ask.text}</AskBubble> : null}

                        {run ? (
                          <>
                            <Assistant>
                              Built your kit in {seconds(totalMs(run.spans))} — {KIT_OUTPUTS.length}{" "}
                              outputs, ready to open.
                            </Assistant>
                            <div className="md:ml-[38px]">
                              <Trace spans={run.spans} />
                            </div>
                          </>
                        ) : (
                          <div className="md:ml-[38px]">
                            <GenerationStream
                              jobId={jobId}
                              showLabel={jobIds.length > 1}
                              onComplete={onKitReady}
                            />
                          </div>
                        )}
                      </div>
                    );
                  })}

                  {/* The kit itself, in the conversation where the result belongs. Rendered from
                      the kit rather than from the run, so a kit opened out of history gets the
                      same grid — only without the trace and the per-output times above it. */}
                  {kit && activeKitId ? (
                    <>
                      {activeRun ? (
                        <Assistant>
                          {summarise(
                            kit.requirements.length,
                            kit.questions.length,
                            kit.coverage.passes,
                          )}
                        </Assistant>
                      ) : null}
                      <div className="mt-1 flex flex-wrap items-baseline gap-3">
                        <h2 className="text-[20px] md:text-[23px]">Interview kit for {kit.role.company}</h2>
                        <span className="text-ink/55 text-xs">
                          {kit.role.title}
                          {activeKitSummary
                            ? ` · ${activeKitSummary.days === 1 ? "1 day" : `${activeKitSummary.days} days`} out`
                            : ""}
                        </span>
                      </div>
                      <OutputGrid
                        kit={kit}
                        spans={spans}
                        activeId={panelOpen ? activeOutput : null}
                        onOpen={openOutput}
                      />
                    </>
                  ) : null}
                </>
              )}
            </div>
          </div>

          {/* One placement, always. The composer used to move to the middle of an empty
              workspace and dock once there was a conversation, which meant the thing you type
              into was in a different place depending on state — and on a wide screen the centred
              version stretched to the full region and put its own button a foot from its own
              badges. It sits on the band at the bottom, at the conversation's measure. */}
          <div className="bg-tint shrink-0 px-3 py-3 md:px-8 md:py-4">
            <div className="max-w-centre mx-auto">
              <Composer onStarted={startRun} />
            </div>
          </div>
        </main>

        {/* Right region. */}
        <KitPanel
          open={panelOpen}
          desktop={isWide}
          hydrated={hydrated}
          resize={panelResize}
          sideBySide={railBeside}
        >
          <KitDrawer
            kitId={activeKitId}
            builder={builder}
            kit={kit}
            loading={kitLoading}
            error={kitError}
            onRetry={retryKit}
            spans={spans}
            indexVertical={railBeside}
            activeOutput={activeOutput}
            onSelectOutput={setActiveOutput}
            onClose={closePanel}
          />
        </KitPanel>
        </div>
      </div>
    </>
  );
}

/**
 * The posting you sent, as the turn that started this — with the time you sent it and a way to
 * get it back.
 *
 * Copy matters more here than it looks: the composer clears on submit, so before this the text
 * you pasted existed nowhere you could reach it. If a run went wrong, getting your own posting
 * back meant finding the original tab again.
 */
function AskBubble({ children, at }: { children: string; at: number }) {
  // "idle" until you press it, then what actually happened. A button that says "Copied" when
  // nothing was copied is worse than one that says nothing.
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => () => clearTimeout(timer.current), []);

  async function copy() {
    const ok = await copyText(children);
    setState(ok ? "copied" : "failed");
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setState("idle"), ok ? 1600 : 2600);
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <p className="bg-tint text-ink/70 max-w-[74%] rounded-[16px] rounded-br-[6px] px-4 py-2.5 text-sm whitespace-pre-line">
        {children}
      </p>
      <div className="flex items-center gap-2 pr-1">
        <button
          type="button"
          onClick={() => void copy()}
          aria-label={state === "copied" ? "Copied" : "Copy this posting"}
          className="text-ink/35 hover:bg-tint hover:text-ink/70 grid size-6 place-items-center rounded-md transition-colors"
        >
          {state === "copied" ? (
            <svg aria-hidden width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="20 6 9 17 4 12" />
            </svg>
          ) : (
            <svg aria-hidden width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
              <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
            </svg>
          )}
        </button>
        <span className="text-ink/35 text-[11px] tabular-nums" aria-live="polite">
          {state === "copied" ? "Copied" : state === "failed" ? "Select and copy" : <AskedAt at={at} />}
        </span>
      </div>
    </div>
  );
}

/**
 * When the query was sent.
 *
 * Rendered only after mount. `toLocaleTimeString` reads the machine's locale and timezone, and
 * the server's are not the reader's — formatting it during the first render is the textbook
 * hydration mismatch, and this component exists to keep that out of the conversation.
 */
function AskedAt({ at }: { at: number }) {
  const hydrated = useHydrated();
  if (!hydrated) return null;
  return (
    <time dateTime={new Date(at).toISOString()}>
      {new Date(at).toLocaleTimeString(undefined, { timeStyle: "short" })}
    </time>
  );
}

/**
 * The line before the grid.
 *
 * It says what the run actually found, which is the only thing worth saying here — a sentence
 * that would read the same for every kit is furniture. Every number in it is counted off the
 * kit, including the pass count, which is recorded honestly and is sometimes one.
 */
function summarise(requirements: number, questions: number, passes: number): string {
  const passClause =
    passes > 1
      ? ` A second coverage pass ran, so anything still uncovered is a gap the pipeline could not close rather than one it skipped.`
      : ` One coverage pass was enough.`;
  return `${requirements} ${requirements === 1 ? "requirement" : "requirements"} came out of the posting, and ${questions} ${questions === 1 ? "question" : "questions"} across four tracks came out of those.${passClause}`;
}

function totalMs(spans: readonly Span[]): number {
  const parentIds = new Set(
    spans.map((span) => span.parentId).filter((id): id is string => id !== null),
  );
  return spans
    .filter((span) => !parentIds.has(span.id))
    .reduce((sum, span) => sum + span.durationMs, 0);
}

function splitIds(raw: string | null): string[] {
  return (raw ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter((id) => id.length > 0);
}
