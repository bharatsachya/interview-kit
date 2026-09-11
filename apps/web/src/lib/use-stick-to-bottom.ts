"use client";

import { useCallback, useEffect, useRef } from "react";

/** Close enough to the end that the person is following along rather than reading back. */
const NEAR_BOTTOM_PX = 96;

/**
 * Keep a transcript pinned to its newest turn, the way a chat does.
 *
 * Two things make this more than one `scrollTop` assignment.
 *
 * The content grows without this component re-rendering: a run's steps arrive inside
 * `GenerationStream`'s own state, so the conversation gets taller with nothing here to react to.
 * A `ResizeObserver` on the content watches the height itself, which covers a new turn and a
 * streaming one with the same mechanism.
 *
 * And it must stop when the reader takes over. Scrolling up to re-read an earlier turn while a
 * run is still writing is exactly when being yanked back to the bottom is worst — so the pin is
 * dropped the moment they leave the end, and taken again when they return to it.
 */
export function useStickToBottom<T extends HTMLElement, C extends HTMLElement>(): {
  viewport: (node: T | null) => void;
  content: (node: C | null) => void;
} {
  const viewportRef = useRef<T | null>(null);
  const observer = useRef<ResizeObserver | null>(null);
  const pinned = useRef(true);

  const toBottom = useCallback(() => {
    const node = viewportRef.current;
    if (node === null || !pinned.current) return;
    node.scrollTop = node.scrollHeight;
  }, []);

  const onScroll = useCallback(() => {
    const node = viewportRef.current;
    if (node === null) return;
    pinned.current = node.scrollHeight - node.scrollTop - node.clientHeight <= NEAR_BOTTOM_PX;
  }, []);

  const viewport = useCallback(
    (node: T | null) => {
      viewportRef.current?.removeEventListener("scroll", onScroll);
      viewportRef.current = node;
      node?.addEventListener("scroll", onScroll, { passive: true });
    },
    [onScroll],
  );

  const content = useCallback(
    (node: C | null) => {
      observer.current?.disconnect();
      if (node === null) return;
      observer.current = new ResizeObserver(toBottom);
      observer.current.observe(node);
    },
    [toBottom],
  );

  useEffect(() => () => observer.current?.disconnect(), []);

  return { viewport, content };
}
