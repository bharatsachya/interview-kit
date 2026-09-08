"use client";

import type { ReactNode } from "react";
import { Button } from "@/components/industry/button";
import { ResizeHandle } from "@/components/workspace/resize-handle";
import type { Resizable } from "@/lib/use-resizable";

/**
 * The kit drawer.
 *
 * It compresses the centre column rather than overlaying it, so nothing the conversation said
 * is hidden while you work on the kit — the two are meant to be read together. On a phone there
 * is no room to compress anything, so it becomes a full-screen sheet with the same slide, and
 * the drag edge is hidden because there is nothing to trade width with.
 *
 * Closed is width zero, so collapsing and resizing are the same property rather than two
 * competing ideas. The width transition is dropped mid-drag: interpolating towards a target
 * that moves every pointer event is what makes a resize feel like it is lagging behind.
 */
export function KitPanel({
  open,
  desktop,
  hydrated,
  resize,
  title,
  subtitle,
  onClose,
  children,
}: {
  open: boolean;
  desktop: boolean;
  hydrated: boolean;
  resize: Resizable;
  title: string;
  subtitle?: string;
  onClose: () => void;
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
      className={`border-divider bg-paper fixed inset-y-0 right-0 z-40 w-full shrink-0 overflow-hidden border-l duration-300 ease-out md:relative md:inset-y-auto md:z-auto ${
        resize.dragging ? "" : "motion-safe:transition-[width,transform]"
      } ${open ? "translate-x-0 md:w-panel" : "translate-x-full md:w-0 md:translate-x-0"}`}
    >
      {open ? <ResizeHandle edge="left" separatorProps={resize.separatorProps} dragging={resize.dragging} /> : null}

      {/* Fixed inner width: the content must not reflow line by line while the panel moves. */}
      <div style={innerStyle} className="flex h-full w-full flex-col md:w-panel">
        <header className="border-divider flex items-start gap-3 border-b p-4">
          <div className="flex min-w-0 flex-col gap-1">
            <h2 className="truncate text-xl">{title}</h2>
            {subtitle ? <p className="truncate text-xs opacity-55">{subtitle}</p> : null}
          </div>
          <Button
            variant="ghost"
            onClick={onClose}
            className="ml-auto shrink-0"
            aria-label="Close the kit panel"
          >
            Close
          </Button>
        </header>
        {children}
      </div>
    </aside>
  );
}
