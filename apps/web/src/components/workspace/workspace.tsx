"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import type { Span } from "@trao/contracts";
import { api } from "@/lib/api/client";
import { nextRewriteKey, rewritePrompt, rewritingLabel, type Rewrite } from "@/lib/rewrite";
import { kitsOf, sessionOfKit, settledLine } from "@/lib/history";
import type { SessionSummary, SessionTurnView } from "@/lib/api/types";
import { AskDocument } from "@/components/workspace/ask-document";
import { KIT_OUTPUTS, seconds, type KitOutputId } from "@/lib/kit-outputs";
import { DESKTOP, WIDE, useMediaQuery } from "@/lib/use-media-query";
import { useHydrated } from "@/lib/use-hydrated";
import { copyText } from "@/lib/copy";
import { useBuilder } from "@/lib/use-builder";
import { useResizable } from "@/lib/use-resizable";
import { useStickToBottom } from "@/lib/use-stick-to-bottom";
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
  /**
   * What this run did, when it was not a first generation.
   *
   * Absent for a build. Present for a rewrite, because "Built your kit in 4s" is a false claim
   * about a run that replaced one section of a kit that already existed.
   */
  changed?: string;
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
  /**
   * The conversation on screen.
   *
   * One id where the URL used to carry a kit and a comma-separated list of jobs that grew by one
   * on every rewrite. `?kit=` is still *read*, because links to it exist — it is resolved to the
   * session that holds it once the rail lands, and the URL rewrites itself to `?session=`.
   */
  const [activeSessionId, setActiveSessionId] = useState<string | null>(() => searchParams.get("session"));
  const [activeKitId, setActiveKitId] = useState<string | null>(() => searchParams.get("kit"));
  /** A `?kit=` from an older link, waiting for the rail to say which session it holds it. */
  const [, setPendingKitLink] = useState<string | null>(() =>
    searchParams.get("session") === null ? searchParams.get("kit") : null,
  );

  const [panelOpen, setPanelOpen] = useState(() => searchParams.get("kit") !== null);
  // Deliberately not in the URL. Which of two ways you are reading a panel is a preference of
  // the moment, not a property of the kit, and a shared link should not force it on anyone.
  const [panelExpanded, setPanelExpanded] = useState(false);
  const [activeOutput, setActiveOutput] = useState<KitOutputId>("brief");
  // The centre column has two things it can be: the conversation, or the comparison across
  // kits. Not a route — navigating would remount the shell and lose the run in progress.
  const [comparing, setComparing] = useState(false);

  /**
   * The transcript: every turn of the open conversation, oldest first.
   *
   * Loaded from the API rather than accumulated in the browser. The asks used to live here as
   * React state, which meant a reload returned the runs and their traces and lost what had
   * actually been asked for — the half a transcript is for. Sending something appends a turn
   * optimistically in the same shape the server will hand back, so there is one shape rather
   * than a local one and a remote one that drift.
   */
  const [turns, setTurns] = useState<SessionTurnView[]>([]);
  // Finished runs, keyed by job. The spans are what the trace and the per-output build times are
  // read from — a run watched in an earlier browser session has none (they are not persisted),
  // and both simply say less rather than guess.
  const [runs, setRuns] = useState<Record<string, Run>>({});

  // The history column follows the viewport until somebody says otherwise: open on a laptop,
  // closed on a phone. `null` means "no opinion yet", which is what keeps the default from
  // being sticky the first time the window is resized across the breakpoint.
  // The conversation follows its newest turn unless the reader has scrolled away from it.
  const transcript = useStickToBottom<HTMLDivElement, HTMLDivElement>();

  const isDesktop = useMediaQuery(DESKTOP);
  // The rail can be a column from 768 up; the panel needs 1024 before it can sit beside the
  // conversation instead of over it.
  const isWide = useMediaQuery(WIDE);
  const [historyOverride, setHistoryOverride] = useState<boolean | null>(null);
  const historyOpen = historyOverride ?? isDesktop;

  // Conversations, grouped by the API. A kit does not exist until its job succeeds, so a list
  // built from kits alone loses every failure the moment the page reloads — and a rewrite forks,
  // so a list of kits alone shows four rows for one piece of work. See lib/history.ts.
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [kitsLoading, setKitsLoading] = useState(true);
  const [kitsError, setKitsError] = useState<string | null>(null);
  const [historyNonce, setHistoryNonce] = useState(0);
  const [transcriptNonce, setTranscriptNonce] = useState(0);

  const [staleKitId, setStaleKitId] = useState<string | null>(null);

  /**
   * A rewrite the kit panel has asked for, waiting in the composer to be sent.
   *
   * Staged rather than sent, because a rewrite costs several model calls and produces a whole
   * new kit — the same weight as a first run, which nobody would expect from one click on the
   * edge of a side panel. See `lib/rewrite.ts`.
   */
  const [rewrite, setRewrite] = useState<Rewrite | null>(null);

  const forgetStaleKit = useCallback((missingId: string) => {
    setStaleKitId(missingId);
    setActiveKitId(null);
    setPanelOpen(false);
    // Including anything staged against it — a rewrite of a kit that is not there can only fail.
    setRewrite((staged) => (staged?.kitId === missingId ? null : staged));
  }, []);

  // One builder for the whole workspace, so the output grid counts the same kit the panel edits
  // and deleting a question updates the card in the conversation without a second fetch.
  const builder = useBuilder(activeKitId, forgetStaleKit);
  const { kit, loading: kitLoading, error: kitError } = builder;
  const retryKit = builder.refetch;

  /**
   * Regenerate, pressed in the panel: write the prompt into the composer and stop.
   *
   * The kit is named on the staged rewrite rather than read from `activeKitId` when it is sent,
   * because the two can drift — the panel can be closed, another kit opened out of history, and
   * a prompt sitting in the composer must still rewrite the kit it was staged from.
   */
  const stageRewrite = useCallback(
    (target: Pick<Rewrite, "section" | "category">) => {
      if (activeKitId === null || kit === null) return;
      setRewrite({
        key: nextRewriteKey(),
        kitId: activeKitId,
        kitLabel: `${kit.role.company} — ${kit.role.title}`,
        section: target.section,
        ...(target.category !== undefined ? { category: target.category } : {}),
        id: target.section === "questions" ? `questions:${target.category}` : target.section,
        prompt: rewritePrompt(target.section, target.category),
      });
      setComparing(false);
      // On a phone the panel covers the composer, so staging a prompt into something the user
      // cannot see would look like the button did nothing at all.
      if (!isWide) setPanelOpen(false);
    },
    [activeKitId, kit, isWide],
  );

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

  // One request where there used to be two. The grouping of kits and runs into conversations
  // moved to the API, which already holds both lists — see lib/history.ts.
  useEffect(() => {
    const controller = new AbortController();
    api
      .listSessions(controller.signal)
      .then((view) => {
        setSessions(view.sessions);
        setKitsError(null);
        // A `?kit=` link written before the URL carried a session, resolved once against the list
        // that just arrived and then forgotten. Those links are real — they were the shareable
        // thing for as long as the workspace existed — and answering one with an empty workspace
        // because the parameter changed name would be worse than any amount of migration code. A
        // kit that no longer exists simply stops pending; the panel reports it as it always did.
        setPendingKitLink((pending) => {
          if (pending === null) return null;
          const found = sessionOfKit(view.sessions, pending);
          if (found !== null) setActiveSessionId(found);
          return null;
        });
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

  /**
   * Load the open conversation's transcript.
   *
   * Turns already on screen are kept while it is in flight, so sending a rewrite does not blink
   * the conversation away and back — the optimistic turn is already correct, and this is
   * reconciling rather than replacing.
   */
  useEffect(() => {
    if (activeSessionId === null) return;
    const controller = new AbortController();
    api
      .getSession(activeSessionId, controller.signal)
      .then((view) => {
        setTurns(view.turns);
        // Opening a conversation shows its newest kit unless a link named a revision.
        setActiveKitId((current) => current ?? view.kits[0]?.id ?? null);
        if (view.kits.length > 0) setPanelOpen(true);
      })
      .catch(() => {
        // A session that is not there is not worth an error banner: the rail is the way back and
        // it is right there. The stale-link notice below covers the one case worth naming.
      });
    return () => controller.abort();
  }, [activeSessionId, transcriptNonce]);

  useEffect(() => {
    const query = new URLSearchParams();
    // The session is the address. The kit rides along so a link can point at one revision of a
    // conversation rather than at its newest, which is what the rail's nested rows select.
    if (activeSessionId) query.set("session", activeSessionId);
    if (activeKitId) query.set("kit", activeKitId);
    const search = query.toString();
    window.history.replaceState(null, "", search === "" ? window.location.pathname : `?${search}`);
  }, [activeSessionId, activeKitId]);

  const closePanel = useCallback(() => {
    setPanelOpen(false);
    // Not a sticky mode. Expanded is how you were reading *this* kit; the next thing you open
    // should not arrive covering the conversation you opened it from.
    setPanelExpanded(false);
  }, []);

  // Escape unwinds one layer at a time: expanded first, then the panel. Registered once, on the
  // document, because focus could legitimately be anywhere inside the panel when someone reaches
  // for it. Collapsing straight to closed would throw away two states on one keypress, and the
  // one people mean by Escape here is "give me the conversation back", which shrinking does.
  useEffect(() => {
    if (!panelOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (panelExpanded) setPanelExpanded(false);
      else closePanel();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [panelOpen, panelExpanded, closePanel]);

  /**
   * Open a conversation.
   *
   * The transcript comes from the API; the kit shown is the session's newest unless a specific
   * revision was asked for. Nothing here has to reconcile which runs belong with which kit any
   * more — that question only existed because the transcript was a list of job ids the workspace
   * maintained by hand, and a conversation is now a thing the server can hand over whole.
   */
  const openSession = useCallback((sessionId: string, kitId?: string) => {
    setStaleKitId(null);
    setComparing(false);
    setActiveSessionId(sessionId);
    setPendingKitLink(null);
    if (kitId !== undefined) {
      setActiveKitId(kitId);
      setPanelOpen(true);
    }
    setHistoryOverride((open) => (open === true ? null : open));
  }, []);

  const openOutput = useCallback((id: KitOutputId) => {
    setActiveOutput(id);
    setPanelOpen(true);
  }, []);

  const startNew = useCallback(() => {
    setPanelExpanded(false);
    setStaleKitId(null);
    setComparing(false);
    setTurns([]);
    setActiveSessionId(null);
    setActiveKitId(null);
    setPanelOpen(false);
    // A staged rewrite belongs to the kit it came from, and New means there is no kit. Leaving
    // it armed would put an empty workspace in front of someone whose composer still says it is
    // about to rewrite the technical questions of something they can no longer see.
    setRewrite(null);
    setHistoryOverride((open) => (open === true ? null : open));
  }, []);

  /**
   * Something was sent: a posting, a batch, or a rewrite.
   *
   * The turns are appended in the same shape the server will hand back, so the conversation on
   * screen now and the one a reload reads are the same thing. A posting starts a conversation —
   * the kit you had open is not what the run is about, so the panel closes and the transcript
   * begins again. A rewrite is the next turn of the one you are already having.
   */
  const startRun = useCallback((sessionId: string, fresh: SessionTurnView[], opensNew: boolean) => {
    setStaleKitId(null);
    setComparing(false);
    setActiveSessionId(sessionId);
    setPendingKitLink(null);
    if (opensNew) {
      setTurns(fresh);
      setActiveKitId(null);
      setPanelOpen(false);
    } else {
      setTurns((previous) => [...previous, ...fresh.filter((t) => !previous.some((p) => p.job_id === t.job_id))]);
    }
  }, []);

  /** A turn settled, however it settled: record it so the transcript stops calling it live. */
  const settleTurn = useCallback((jobId: string, status: SessionTurnView["status"], kitId: string | null) => {
    setTurns((previous) =>
      previous.map((turn) => (turn.job_id === jobId ? { ...turn, status, kit_id: kitId ?? turn.kit_id } : turn)),
    );
    setKitsLoading(true);
    setHistoryNonce((nonce) => nonce + 1);
  }, []);

  /**
   * A run that produced nothing. There is no kit to open — only a row to update in the rail.
   *
   * The refetch is the whole point: the job has been in the store since it was accepted, so the
   * row exists server-side already and the rail simply has not asked since.
   */
  const onRunFailed = useCallback((jobId: string) => settleTurn(jobId, "failed", null), [settleTurn]);

  /**
   * A retry started. Show the new run in place of the one it came from.
   *
   * The retry joins the same conversation on the server, so the transcript simply reloads and
   * the new turn arrives where it belongs — below the failure it repeats, which is the order it
   * happened in.
   */
  const onRetried = useCallback(() => {
    setKitsLoading(true);
    setHistoryNonce((nonce) => nonce + 1);
    setTranscriptNonce((nonce) => nonce + 1);
  }, []);

  // The panel opens on the first kit to finish. In a batch the others are reachable from
  // history; opening and reopening the drawer under someone as each one lands would be hostile.
  const onKitReady = useCallback(
    (jobId: string, kitId: string, spans: Span[]) => {
      const ask = turns.find((turn) => turn.job_id === jobId)?.ask ?? null;
      const changed = ask?.kind === "rewrite" ? sectionId(ask) : undefined;
      setRuns((previous) => ({
        ...previous,
        [jobId]: { jobId, kitId, spans, ...(changed !== undefined ? { changed } : {}) },
      }));
      settleTurn(jobId, "done", kitId);
      // A rewrite forks, so this kit id is a NEW document and the one on screen is its parent,
      // untouched. Switching is the point: you asked for these questions to be rewritten, and
      // leaving the parent open would show you the questions you were trying to replace while
      // claiming the rewrite had landed. The parent is one row away in the rail.
      setActiveKitId((current) => (changed !== undefined ? kitId : (current ?? kitId)));
      setPanelOpen(true);
    },
    [turns, settleTurn],
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

  const kits = kitsOf(sessions);
  const activeKitSummary = kits.find((entry) => entry.id === activeKitId) ?? null;
  const activeRun = Object.values(runs).find((run) => run.kitId === activeKitId) ?? null;
  // A turn the server has not settled yet. `runs` is not consulted: a turn is live or it is not,
  // and that is now one field rather than a fact assembled from two collections.
  const running = turns.some((turn) => turn.status === "queued" || turn.status === "running");
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
              sessions={sessions}
              loading={kitsLoading}
              error={kitsError}
              activeSessionId={activeSessionId}
              activeKitId={activeKitId}
              onOpenSession={(sessionId) => openSession(sessionId)}
              onOpenKit={openSession}
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

          <div ref={transcript.viewport} className="flex min-h-0 flex-1 flex-col overflow-y-auto px-4 md:px-8">
            {/* A query container, so what is inside responds to this column's real width. The
                  output grid used viewport breakpoints, which is wrong in a three-pane layout:
                  at 1180px the viewport says "wide, three columns" while this column is 444px
                  and the cards are 140px each. */}
              <div
                ref={transcript.content}
                className="@container max-w-centre mx-auto flex w-full flex-1 flex-col gap-5 pb-6"
              >
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
                <CompareView
                  kits={kits}
                  onOpenKit={(kitId) => {
                    const session = sessionOfKit(sessions, kitId);
                    if (session !== null) openSession(session, kitId);
                  }}
                  onClose={() => setComparing(false)}
                />
              ) : activeSessionId === null && turns.length === 0 && !activeKitId ? (
                <div className="flex flex-1 flex-col justify-center gap-2 py-10">
                  <h1 className="text-[26px] md:text-[34px]">What are you preparing for?</h1>
                  <p className="text-ink/55 text-[14px] md:text-[15px]">
                    Paste the posting, tell us where they live on the web, and how long you have.
                  </p>
                </div>
              ) : (
                <>
                  {turns.map((turn) => {
                    const run = runs[turn.job_id];
                    const ask = turn.ask;
                    const live = turn.status === "queued" || turn.status === "running";
                    return (
                      <div key={turn.job_id} className="flex flex-col gap-5">
                        {/* A posting is a document you can open; a rewrite is the sentence you
                            sent, in the words you sent it. */}
                        {ask?.kind === "posting" ? (
                          <AskDocument ask={{ kind: "posting", jd: ask.jd, url: ask.companyUrl, days: ask.days, at: turn.created_at }} />
                        ) : ask?.kind === "rewrite" ? (
                          <AskBubble at={turn.created_at}>{ask.prompt}</AskBubble>
                        ) : null}

                        {run ? (
                          <>
                            <Assistant>
                              {run.changed === undefined ? (
                                <>
                                  Built your kit in {seconds(totalMs(run.spans))} — {KIT_OUTPUTS.length}{" "}
                                  outputs, ready to open.
                                </>
                              ) : (
                                <>
                                  {changedLabel(run.changed)} in {seconds(totalMs(run.spans))}, into a
                                  new kit — now open. The one you rewrote is unchanged, in your
                                  history.
                                </>
                              )}
                            </Assistant>
                            <div className="md:ml-[38px]">
                              <Trace spans={run.spans} />
                            </div>
                          </>
                        ) : live ? (
                          <div className="md:ml-[38px]">
                            <GenerationStream
                              jobId={turn.job_id}
                              showLabel={turns.length > 1}
                              {...(ask?.kind === "rewrite" ? { running: rewritingLabel(sectionId(ask)) } : {})}
                              onComplete={onKitReady}
                              onFailed={onRunFailed}
                              onRetried={onRetried}
                            />
                          </div>
                        ) : (
                          /* Settled, but not in this browser session — so there are no spans to
                             draw and no duration to claim. Traces live in the API process and
                             are not persisted; saying what the turn did without inventing how
                             long it took is the honest version of that. */
                          <SettledTurn turn={turn} />
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
              <Composer onStarted={startRun} rewrite={rewrite} onCancelRewrite={() => setRewrite(null)} />
            </div>
          </div>
        </main>

        {/* Right region. */}
        <KitPanel
          expanded={panelExpanded}
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
            expanded={panelExpanded}
            onToggleExpand={() => setPanelExpanded((on) => !on)}
            onRewrite={stageRewrite}
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
/**
 * What a rewrite says it did, in the past tense.
 *
 * Deliberately narrower than "regenerated the kit". A rewrite rewrites one section, copies
 * everything else across byte-identical, and puts the result in a new document — so the sentence
 * has two halves to be honest about, and overstating either would make people check.
 */
function changedLabel(section: string): string {
  if (section === "company_brief") return "Rewrote the brief";
  if (section === "schedule") return "Rebuilt the schedule";
  const [, category] = section.split(":");
  return category === undefined ? "Rewrote the questions" : `Rewrote the ${category} questions`;
}

/**
 * The section an ask names, as the one string the rest of the UI keys rewrites by.
 *
 * `questions:technical` rather than a section and a category held apart, because every label
 * function downstream — the running line, the past-tense line — takes one string and splits it.
 */
function sectionId(ask: { section: string; category?: string }): string {
  return ask.section === "questions" && ask.category !== undefined
    ? `questions:${ask.category}`
    : ask.section;
}

/**
 * A turn that finished before this page was open.
 *
 * Traces live in the API process and are not persisted, so a conversation reopened tomorrow has
 * the asks and the outcomes and no spans. This says what the turn did and declines to say how
 * long it took, which is the difference between a thinner transcript and a transcript that
 * invents a duration of zero seconds.
 */
function SettledTurn({ turn }: { turn: SessionTurnView }) {
  return <Assistant>{settledLine(turn, KIT_OUTPUTS.length)}</Assistant>;
}

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

