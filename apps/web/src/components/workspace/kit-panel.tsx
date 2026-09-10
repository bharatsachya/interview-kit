"use client";

import type { ReactNode } from "react";
import { ResizeHandle } from "@/components/workspace/resize-handle";
import type { Resizable } from "@/lib/use-resizable";

/**
 * The kit panel: the shell only.
 *
 * It compresses the centre column rather than overlaying it, so nothing the conversation said
 * is hidden while you work on the kit — the two are meant to be read together. On a phone there
 * is no room to compress anything, so it becomes a full-screen sheet with the same slide, and
 * the drag edge is hidden because there is nothing to trade width with.
 *
 * Closed is width zero, so collapsing and resizing are the same property rather than two
 * competing ideas. The width transition is dropped mid-drag: interpolating towards a target
 * that moves every pointer event is what makes a resize feel like it is lagging behind.
 *
 * The header used to live here. It moved into the drawer when the index rail arrived, because
 * the rail runs the full height of the panel and the header only spans the body beside it —
 * a header owned by the shell would have had to sit above both.
 */
export function KitPanel({
  open,
  desktop,
  hydrated,
  resize,
  sideBySide,
  children,
}: {
  open: boolean;
  desktop: boolean;
  hydrated: boolean;
  resize: Resizable;
  /**
   * Whether the index rail sits beside the body or above it.
   *
   * The same decision the rail itself makes, and it has to be made once for both: a rail drawn
   * as a full-width strip inside a row-direction panel takes the whole panel and leaves the body
   * forty pixels.
   */
  sideBySide: boolean;
  children: ReactNode;
}) {
  // Held back until hydration: the server cannot know how wide this was dragged, so it renders
  // the CSS default and the remembered width takes over once the client is in charge.
  const sized = hydrated && desktop;
  const style = sized ? { width: open ? resize.width : 0 } : undefined;
  const innerStyle = sized ? { width: resize.width } : undefined;

  return (
    <aside
      aria-label="Kit"
      aria-hidden={!open}
      inert={!open}
      style={style}
      className={`bg-surface fixed inset-y-0 right-0 z-40 w-full shrink-0 overflow-hidden duration-300 ease-out lg:relative lg:inset-y-auto lg:z-auto ${
        resize.dragging ? "" : "motion-safe:transition-[width,transform]"
      } ${open ? "translate-x-0 lg:w-panel" : "translate-x-full lg:w-0 lg:translate-x-0"}`}
    >
      {open ? (
        <ResizeHandle edge="left" separatorProps={resize.separatorProps} dragging={resize.dragging} />
      ) : null}

      {/* Fixed inner width: the content must not reflow line by line while the panel moves. */}
      <div
        style={innerStyle}
        className={`flex h-full w-full lg:w-panel ${sideBySide ? "flex-row" : "flex-col"}`}
      >
        {children}
      </div>
    </aside>
  );
}
