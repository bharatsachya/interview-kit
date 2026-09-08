"use client";

import { useCallback, useSyncExternalStore } from "react";

/**
 * Subscribe to a media query.
 *
 * `useSyncExternalStore` rather than an effect that calls setState: the viewport is an external
 * system, which is exactly what this hook is for, and it means no mount flash and no cascading
 * render. It also makes the layout respond to a window resize, which an on-mount read would not.
 *
 * The server snapshot is the laptop, because that is the layout whose default we want rendered
 * before the client can say otherwise.
 */
export function useMediaQuery(query: string, serverSnapshot = true): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      const list = window.matchMedia(query);
      list.addEventListener("change", onChange);
      return () => list.removeEventListener("change", onChange);
    },
    [query],
  );

  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(query).matches,
    () => serverSnapshot,
  );
}

export const DESKTOP = "(min-width: 768px)";
