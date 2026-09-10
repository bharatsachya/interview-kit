import type { ReactNode } from "react";

/** Condensed 600 · 12 · .14em. Section labels and small headers, never body copy. */
export function Eyebrow({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <span className={`font-head text-xs tracking-widest uppercase ${className}`}>{children}</span>
  );
}

/**
 * The accent-coloured eyebrow, used as a card's category line and the artifact panel's header.
 *
 * Separate from `Eyebrow` because the colour is the distinction that matters: an eyebrow in ink
 * labels a section of the page, and one in steel names the kind of thing you are looking at.
 * Steel 600 rather than 500 — 500 on a 100 tint fails contrast at this size.
 */
export function Kicker({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <span className={`font-head text-steel-600 text-xs tracking-widest uppercase ${className}`}>
      {children}
    </span>
  );
}

/** Barlow 500 · 12 · tabular. Counts and units that sit next to each other must not jitter. */
export function Meta({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <span className={`text-xs font-medium tabular-nums ${className}`}>{children}</span>;
}

/**
 * The accent dot that marks the open item — on an output card's kicker, and on the index rail.
 *
 * It is a component rather than three copies of a span because "which one is open" is drawn in
 * two places at once and they must not drift: the card and the index row are two views of one
 * selection, and a reader who sees the dot in one place looks for it in the other.
 */
export function OpenDot({ className = "" }: { className?: string }) {
  return <span aria-hidden className={`bg-steel-500 size-1.5 shrink-0 rounded-full ${className}`} />;
}
