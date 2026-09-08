"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { InternalKit } from "@trao/kit";
import { api } from "@/lib/api/client";
import { Button } from "@/components/industry/button";
import { ErrorNotice, Loading, Skeleton } from "@/components/industry/states";
import { KitTabPanel, KitTabStrip, type KitTabId } from "@/components/workspace/kit-tabs";

/**
 * The panel's contents: fetch the kit, remember where you were in it, render one tab.
 *
 * Everything it draws comes from `getKitForBuilder` on the server — active items only, with
 * provenance intact. Archived items never arrive here, so no view can render one by mistake.
 *
 * Tab and scroll position are remembered per kit. This component is never unmounted while the
 * panel is closed (the panel animates to zero width instead), so closing and reopening restores
 * exactly what you were looking at; switching kits and coming back restores it too, because the
 * positions are keyed by kit and tab rather than held in the DOM.
 */
export function KitDrawer({ kitId }: { kitId: string | null }) {
  const [loaded, setLoaded] = useState<{ kitId: string; kit: InternalKit } | null>(null);
  const [failed, setFailed] = useState<{ kitId: string; message: string } | null>(null);
  const [tabByKit, setTabByKit] = useState<Record<string, KitTabId>>({});
  const [attempt, setAttempt] = useState(0);

  const scroller = useRef<HTMLDivElement>(null);
  const positions = useRef(new Map<string, number>());

  const kit = loaded?.kitId === kitId ? loaded.kit : null;
  const error = failed?.kitId === kitId ? failed.message : null;
  // Derived rather than a `loading` flag set inside an effect: there is exactly one truth here,
  // which is whether the kit we hold is the kit we were asked for.
  const loading = kitId !== null && kit === null && error === null;

  const tab: KitTabId = (kitId && tabByKit[kitId]) || "brief";
  const scrollKey = `${kitId ?? ""}:${tab}`;

  useEffect(() => {
    if (kitId === null) return;
    const controller = new AbortController();

    api
      .getKit(kitId, controller.signal)
      .then((view) => {
        if (controller.signal.aborted) return;
        setLoaded({ kitId, kit: view.kit });
        setFailed(null);
      })
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return;
        setFailed({ kitId, message: cause instanceof Error ? cause.message : "Could not load this kit." });
      });

    return () => controller.abort();
  }, [kitId, attempt]);

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

  const selectTab = useCallback(
    (next: KitTabId) => {
      if (!kitId) return;
      setTabByKit((previous) => ({ ...previous, [kitId]: next }));
    },
    [kitId],
  );

  if (kitId === null) {
    return (
      <div className="flex-1 overflow-y-auto p-4">
        <p className="text-sm opacity-55">No kit open.</p>
      </div>
    );
  }

  return (
    <>
      <KitTabStrip active={tab} onSelect={selectTab} />
      <div ref={scroller} onScroll={onScroll} className="min-h-0 flex-1 overflow-y-auto">
        {loading ? (
          <div className="flex flex-col gap-4 p-4">
            <Loading label="Opening the kit" />
            <Skeleton lines={3} />
            <Skeleton lines={4} />
          </div>
        ) : error ? (
          <div className="p-4">
            <ErrorNotice
              title="Could not open this kit"
              actions={
                <Button variant="secondary" onClick={() => setAttempt((count) => count + 1)}>
                  Try again
                </Button>
              }
            >
              {error}
            </ErrorNotice>
          </div>
        ) : kit ? (
          <KitTabPanel tab={tab} kit={kit} />
        ) : null}
      </div>
    </>
  );
}
