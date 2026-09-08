"use client";

import { useSyncExternalStore } from "react";

const subscribe = () => () => {};

/**
 * False while rendering on the server and during hydration, true afterwards.
 *
 * Used to hold back inline widths until the client is in charge. The server has no idea how
 * wide anyone dragged their sidebar, so it renders the CSS default; applying a remembered width
 * before hydration finishes would be a mismatch React would have to repair.
 *
 * `useSyncExternalStore` with differing snapshots is the sanctioned way to ask this. An effect
 * that sets a `mounted` flag would do the same job and cost a cascading render.
 */
export function useHydrated(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => true,
    () => false,
  );
}
