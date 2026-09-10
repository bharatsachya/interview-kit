"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useHydrated } from "@/lib/use-hydrated";

/**
 * A draggable region edge.
 *
 * The width lives in React state during a drag so the frame is cheap, and is written to
 * localStorage only when the drag ends — a write per pointermove would be dozens of synchronous
 * storage writes per second for a value nobody reads until the next page load.
 *
 * `edge` says which side the handle sits on, which is the only difference between the two
 * regions: dragging the sidebar's right edge rightwards widens it, and dragging the panel's
 * left edge leftwards widens it.
 *
 * The centre column is never allowed to be squeezed away. The maximum is recomputed at drag
 * time against the actual viewport rather than fixed, so a narrow laptop cannot end up with a
 * conversation four words wide.
 */

const KEYBOARD_STEP = 16;
const CENTRE_MIN = 420;

export interface Resizable {
  width: number;
  dragging: boolean;
  /** Spread onto the handle element. */
  separatorProps: {
    role: "separator";
    "aria-orientation": "vertical";
    "aria-valuenow": number;
    "aria-valuemin": number;
    "aria-valuemax": number;
    "aria-label": string;
    tabIndex: number;
    onPointerDown: (event: React.PointerEvent<HTMLElement>) => void;
    onKeyDown: (event: React.KeyboardEvent<HTMLElement>) => void;
    onDoubleClick: () => void;
  };
}

export function useResizable({
  storageKey,
  defaultWidth,
  min,
  max,
  edge,
  label,
  reserve = 0,
  onToggle,
}: {
  storageKey: string;
  defaultWidth: number;
  min: number;
  max: number;
  edge: "left" | "right";
  label: string;
  /**
   * Width taken by the *other* region, which this one must not also spend.
   *
   * Without it the ceiling reserved the conversation's minimum out of the whole viewport and
   * forgot the rail was standing in it: at 1024px the panel was allowed its full 520 and the
   * conversation got 288 — well under the 420 the ceiling believed it was protecting.
   */
  reserve?: number;
  onToggle?: () => void;
}): Resizable {
  // Starts at the default on both sides of the render, deliberately.
  //
  // This used to read localStorage in the initial state, which meant the server rendered
  // `aria-valuenow="216"` and a client that had ever dragged the handle hydrated with
  // `aria-valuenow={321}`. React does not patch attribute mismatches — it warns and leaves the
  // server's value in the DOM — so the separator ended up reporting a width it did not have to
  // every screen reader, and the console carried a hydration error on every load. The remembered
  // width is adopted just below, once the client is unambiguously in charge.
  // The remembered width is the initial state, not something adopted afterwards. Nothing
  // flashes and nothing mismatches: the regions only take an inline width once `useHydrated`
  // is true, and this initialiser has already run by then.
  const [width, setWidthState] = useState(() => readStored(storageKey) ?? defaultWidth);
  const [dragging, setDragging] = useState(false);
  // Read below, for `aria-valuenow` only. See the note on it.
  const hydrated = useHydrated();
  const widthRef = useRef(width);

  const ceiling = useCallback(() => {
    if (typeof window === "undefined") return max;
    // Leave the conversation a readable column no matter how hard someone drags.
    return Math.max(min, Math.min(max, window.innerWidth - reserve - CENTRE_MIN));
  }, [min, max, reserve]);

  const apply = useCallback(
    (next: number) => {
      const clamped = Math.round(Math.min(ceiling(), Math.max(min, next)));
      widthRef.current = clamped;
      setWidthState(clamped);
    },
    [ceiling, min],
  );

  /**
   * Give ground when the window does.
   *
   * The ceiling was only consulted while dragging, so a panel sized for a wide screen kept its
   * full width on a narrower one and took the difference out of the conversation — at 834px the
   * centre column was 98 pixels of a 520-pixel panel's leftovers. The region is only allowed to
   * be as wide as the window can spare, and that has to be re-checked when the window changes
   * rather than only when a pointer is on the handle.
   *
   * Run on mount too: a width remembered from a larger screen is the same problem arriving by
   * a different route.
   */
  useEffect(() => {
    const clamp = () => {
      const limit = ceiling();
      if (widthRef.current > limit) apply(limit);
    };
    clamp();
    window.addEventListener("resize", clamp);
    return () => window.removeEventListener("resize", clamp);
  }, [ceiling, apply]);

  const persist = useCallback(() => {
    try {
      window.localStorage.setItem(storageKey, String(widthRef.current));
    } catch {
      // Private mode, a full quota, a browser that refuses. A width that does not survive a
      // reload is not worth breaking a drag over.
    }
  }, [storageKey]);

  const onPointerDown = useCallback(
    (event: React.PointerEvent<HTMLElement>) => {
      if (event.button !== 0) return;
      event.preventDefault();

      const handle = event.currentTarget;
      const startX = event.clientX;
      const startWidth = widthRef.current;
      handle.setPointerCapture(event.pointerId);
      setDragging(true);
      document.body.classList.add("is-resizing");

      const onMove = (moveEvent: PointerEvent) => {
        const delta = edge === "right" ? moveEvent.clientX - startX : startX - moveEvent.clientX;
        apply(startWidth + delta);
      };

      const onUp = () => {
        handle.removeEventListener("pointermove", onMove);
        handle.removeEventListener("pointerup", onUp);
        handle.removeEventListener("pointercancel", onUp);
        document.body.classList.remove("is-resizing");
        setDragging(false);
        persist();
      };

      handle.addEventListener("pointermove", onMove);
      handle.addEventListener("pointerup", onUp);
      handle.addEventListener("pointercancel", onUp);
    },
    [apply, edge, persist],
  );

  /**
   * The keyboard half of the same control, which is the half people skip.
   *
   * Arrows resize, Home and End jump to the limits, Enter and Space collapse — so a region can
   * be sized and put away without a pointer.
   */
  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLElement>) => {
      const grow = edge === "right" ? "ArrowRight" : "ArrowLeft";
      const shrink = edge === "right" ? "ArrowLeft" : "ArrowRight";

      if (event.key === grow) apply(widthRef.current + KEYBOARD_STEP);
      else if (event.key === shrink) apply(widthRef.current - KEYBOARD_STEP);
      else if (event.key === "Home") apply(min);
      else if (event.key === "End") apply(ceiling());
      else if (event.key === "Enter" || event.key === " ") onToggle?.();
      else return;

      event.preventDefault();
      if (event.key !== "Enter" && event.key !== " ") persist();
    },
    [apply, ceiling, edge, min, onToggle, persist],
  );

  const onDoubleClick = useCallback(() => {
    apply(defaultWidth);
    persist();
  }, [apply, defaultWidth, persist]);

  return {
    width,
    dragging,
    separatorProps: {
      role: "separator",
      "aria-orientation": "vertical",
      // The one value here the server also renders, so the one that has to agree with it.
      //
      // The inline widths above are already held back until `useHydrated`, which is what keeps
      // the *layout* from mismatching. This attribute is not — it is rendered unconditionally,
      // so a client that had ever dragged the handle hydrated with `aria-valuenow={321}` against
      // a server that wrote 216. React does not patch attribute mismatches: it warns and leaves
      // the server's number in the DOM, so the separator went on reporting a width it did not
      // have to every screen reader, and the console carried a hydration error on every load.
      //
      // Reporting the default until the client is in charge costs one frame of a number nobody
      // is reading yet, and is the whole fix. Do not remove the guard without moving the
      // remembered width out of the initial state as well — one or the other has to give.
      "aria-valuenow": hydrated ? width : defaultWidth,
      "aria-valuemin": min,
      "aria-valuemax": max,
      "aria-label": label,
      tabIndex: 0,
      onPointerDown,
      onKeyDown,
      onDoubleClick,
    },
  };
}

function readStored(key: string): number | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(key);
    if (raw === null) return null;
    const value = Number(raw);
    return Number.isFinite(value) && value > 0 ? value : null;
  } catch {
    return null;
  }
}
