"use client";

import { useCallback, useRef, useState } from "react";

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
  onToggle,
}: {
  storageKey: string;
  defaultWidth: number;
  min: number;
  max: number;
  edge: "left" | "right";
  label: string;
  onToggle?: () => void;
}): Resizable {
  const [width, setWidthState] = useState(() => readStored(storageKey) ?? defaultWidth);
  const [dragging, setDragging] = useState(false);
  const widthRef = useRef(width);

  const ceiling = useCallback(() => {
    if (typeof window === "undefined") return max;
    // Leave the conversation a readable column no matter how hard someone drags.
    return Math.max(min, Math.min(max, window.innerWidth - CENTRE_MIN));
  }, [min, max]);

  const apply = useCallback(
    (next: number) => {
      const clamped = Math.round(Math.min(ceiling(), Math.max(min, next)));
      widthRef.current = clamped;
      setWidthState(clamped);
    },
    [ceiling, min],
  );

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
      "aria-valuenow": width,
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
