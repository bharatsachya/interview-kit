"use client";

import type { Resizable } from "@/lib/use-resizable";

/**
 * The grab edge between two regions.
 *
 * Wider than it looks: the line is a hairline, the target is eight pixels, because a
 * one-pixel drag target is a joke on anyone without a steady mouse. It is also focusable and
 * driven by arrow keys, so the region can be sized without a pointer at all.
 *
 * Double-click restores the default width, which is the escape hatch for a drag that went
 * somewhere silly.
 */
export function ResizeHandle({
  edge,
  separatorProps,
  dragging,
}: {
  edge: "left" | "right";
  separatorProps: Resizable["separatorProps"];
  dragging: boolean;
}) {
  return (
    <div
      {...separatorProps}
      title="Drag to resize · double-click to reset"
      className={`group absolute inset-y-0 z-10 hidden w-2 cursor-col-resize touch-none md:block ${
        edge === "right" ? "right-0" : "left-0"
      }`}
    >
      <span
        aria-hidden
        className={`absolute inset-y-0 w-px ${edge === "right" ? "right-0" : "left-0"} ${
          dragging ? "bg-teal-700" : "bg-transparent group-hover:bg-teal-500"
        }`}
      />
    </div>
  );
}
