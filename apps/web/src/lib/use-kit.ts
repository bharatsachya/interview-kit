"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { InternalKit } from "@trao/kit";
import { api } from "@/lib/api/client";
import { ApiError } from "@/lib/api/types";

export interface KitState {
  kit: InternalKit | null;
  loading: boolean;
  error: string | null;
  /**
   * The kit is not there, as opposed to unreachable.
   *
   * Worth its own flag because the two need opposite treatment. A server that is down deserves
   * "Try again"; a kit that does not exist can never be fetched however many times you ask, and
   * offering a retry for it is a button that is guaranteed to fail. The commonest way to reach
   * this state is a link — or a tab left open — pointing at a kit that has since been deleted,
   * or that was never really there.
   */
  notFound: boolean;
  retry: () => void;
}

/**
 * One kit, fetched once.
 *
 * It lives above both readers rather than inside either. The output grid in the conversation and
 * the panel body are two views of the same kit, and when each fetched its own there were two
 * requests, two loading states, and a window where the grid could be counting a kit the panel
 * had not received yet.
 *
 * `loading` is derived, not a flag set inside the effect: there is exactly one truth here, which
 * is whether the kit we hold is the kit we were asked for. A separate boolean is a second copy
 * of that truth, and the two go out of step the first time a request is aborted.
 */
export function useKit(kitId: string | null, onNotFound?: (kitId: string) => void): KitState {
  // Held in a ref so a caller passing an inline function cannot restart the request, and so the
  // effect's dependencies stay honest.
  const notify = useRef(onNotFound);
  useEffect(() => {
    notify.current = onNotFound;
  }, [onNotFound]);

  const [loaded, setLoaded] = useState<{ kitId: string; kit: InternalKit } | null>(null);
  const [failed, setFailed] = useState<{ kitId: string; message: string; missing: boolean } | null>(null);
  const [attempt, setAttempt] = useState(0);

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
        const missing = cause instanceof ApiError && (cause.code === "NOT_FOUND" || cause.status === 404);
        setFailed({
          kitId,
          message: cause instanceof Error ? cause.message : "Could not load this kit.",
          missing,
        });
        // Told here, where it is discovered, rather than from an effect watching the derived
        // flag: this is a promise callback reacting to an event, which is what a state update
        // belongs in. Watching `notFound` afterwards was a second render doing the same job.
        if (missing) notify.current?.(kitId);
      });

    return () => controller.abort();
  }, [kitId, attempt]);

  const retry = useCallback(() => setAttempt((count) => count + 1), []);

  const kit = loaded?.kitId === kitId ? loaded.kit : null;
  const error = failed?.kitId === kitId ? failed.message : null;

  return {
    kit,
    loading: kitId !== null && kit === null && error === null,
    error,
    notFound: failed?.kitId === kitId && failed.missing,
    retry,
  };
}
