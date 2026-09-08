"use client";

import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { UserButton } from "@clerk/nextjs";
import { api } from "@/lib/api/client";
import type { KitSummary } from "@/lib/api/types";
import { DESKTOP, useMediaQuery } from "@/lib/use-media-query";
import { Button } from "@/components/industry/button";
import { HistorySidebar } from "@/components/workspace/history-sidebar";
import { KitPanel } from "@/components/workspace/kit-panel";

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
 */
export function Workspace() {
  const searchParams = useSearchParams();

  // Read once. After mount this component owns the state and mirrors it back to the URL.
  const [activeKitId, setActiveKitId] = useState<string | null>(() => searchParams.get("kit"));
  const [jobIds, setJobIds] = useState<string[]>(() => splitIds(searchParams.get("jobs")));

  const [panelOpen, setPanelOpen] = useState(() => searchParams.get("kit") !== null);

  // The history column follows the viewport until somebody says otherwise: open on a laptop,
  // closed on a phone. `null` means "no opinion yet", which is what keeps the default from
  // being sticky the first time the window is resized across the breakpoint.
  const isDesktop = useMediaQuery(DESKTOP);
  const [historyOverride, setHistoryOverride] = useState<boolean | null>(null);
  const historyOpen = historyOverride ?? isDesktop;

  const [kits, setKits] = useState<KitSummary[]>([]);
  const [kitsLoading, setKitsLoading] = useState(true);
  const [kitsError, setKitsError] = useState<string | null>(null);
  const [historyNonce, setHistoryNonce] = useState(0);

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
    setActiveKitId(kitId);
    setPanelOpen(true);
    setHistoryOverride((open) => (open === true ? null : open));
  }, []);

  const startNew = useCallback(() => {
    setJobIds([]);
    setActiveKitId(null);
    setPanelOpen(false);
    setHistoryOverride((open) => (open === true ? null : open));
  }, []);

  const activeKit = kits.find((kit) => kit.id === activeKitId) ?? null;

  return (
    <div className="flex h-dvh w-full overflow-hidden">
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
        className={`border-divider bg-paper fixed inset-y-0 left-0 z-40 shrink-0 overflow-hidden border-r duration-300 ease-out motion-safe:transition-[width,transform] md:relative md:inset-y-auto md:z-auto ${
          historyOpen ? "w-sidebar translate-x-0" : "w-sidebar -translate-x-full md:w-0 md:translate-x-0"
        }`}
      >
        <HistorySidebar
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

      {/* Centre region. */}
      <main className="flex min-w-0 flex-1 flex-col">
        <header className="border-divider flex items-center gap-3 border-b px-4 py-3">
          <Button
            variant="ghost"
            onClick={() => setHistoryOverride(!historyOpen)}
            aria-expanded={historyOpen}
            aria-label={historyOpen ? "Hide history" : "Show history"}
          >
            History
          </Button>
          <span className="font-head ml-auto text-sm tracking-tight">Interview Prep Kit</span>
          {activeKitId && !panelOpen ? (
            <Button variant="secondary" onClick={() => setPanelOpen(true)}>
              Open kit
            </Button>
          ) : null}
          <UserButton />
        </header>

        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
          <div className="mx-auto flex w-full max-w-read flex-1 flex-col justify-center px-4 py-10">
            <p className="text-2xl">Composer lands here next.</p>
            <p className="mt-3 text-sm opacity-55">
              Shell first: history, the three regions, and the panel animation.
            </p>
          </div>
        </div>
      </main>

      {/* Right region. */}
      <KitPanel
        open={panelOpen}
        title={activeKit?.company ?? "Kit"}
        subtitle={activeKit?.title}
        onClose={closePanel}
      >
        <div className="flex-1 overflow-y-auto p-4">
          <p className="text-sm opacity-55">Tabs land here in step 3.</p>
        </div>
      </KitPanel>
    </div>
  );
}

function splitIds(raw: string | null): string[] {
  return (raw ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter((id) => id.length > 0);
}
