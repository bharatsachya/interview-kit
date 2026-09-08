"use client";

import type { ReactNode } from "react";
import { Button } from "@/components/industry/button";

/**
 * The kit drawer.
 *
 * It compresses the centre column rather than overlaying it, so nothing the conversation said
 * is hidden while you work on the kit — the two are meant to be read together. On a phone
 * there is no room to compress anything, so it becomes a full-screen sheet with the same slide.
 *
 * The width animates between two tokens, and the closed state is zero of the same token, so
 * there is exactly one number in play and the transition cannot land somewhere unintended.
 * `motion-safe:` keeps the whole thing out of the way of anyone who has asked for less motion.
 */
export function KitPanel({
  open,
  title,
  subtitle,
  onClose,
  children,
}: {
  open: boolean;
  title: string;
  subtitle?: string;
  onClose: () => void;
  children: ReactNode;
}) {
  return (
    <aside
      aria-label="Kit"
      aria-hidden={!open}
      inert={!open}
      className={`border-divider bg-paper fixed inset-y-0 right-0 z-40 w-full shrink-0 overflow-hidden border-l duration-300 ease-out motion-safe:transition-[width,transform] md:relative md:inset-y-auto md:z-auto ${
        open ? "translate-x-0 md:w-panel" : "translate-x-full md:w-0 md:translate-x-0"
      }`}
    >
      {/* Fixed inner width: the content must not reflow line by line while the panel slides. */}
      <div className="flex h-full w-full flex-col md:w-panel">
        <header className="border-divider flex items-start gap-3 border-b p-4">
          <div className="flex min-w-0 flex-col gap-1">
            <h2 className="truncate text-xl">{title}</h2>
            {subtitle ? <p className="truncate text-xs opacity-55">{subtitle}</p> : null}
          </div>
          <Button variant="ghost" onClick={onClose} className="ml-auto shrink-0" aria-label="Close the kit panel">
            Close
          </Button>
        </header>
        {children}
      </div>
    </aside>
  );
}
