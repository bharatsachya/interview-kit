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

/**
 * Where the kit panel can afford to sit *beside* the conversation rather than over it.
 *
 * Higher than DESKTOP on purpose. The rail is 216 and the panel 520; at 834px that leaves the
 * conversation 98 pixels, which is not a narrow column, it is a broken one. Between the two
 * breakpoints the panel behaves the way it does on a phone — a sheet over the top — and the
 * conversation keeps its full width underneath.
 */
export const WIDE = "(min-width: 1024px)";
