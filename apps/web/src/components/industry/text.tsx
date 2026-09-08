import type { ReactNode } from "react";

/** Condensed 600 · 12 · .14em. Section labels and small headers, never body copy. */
export function Eyebrow({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <span className={`font-head text-xs tracking-widest uppercase ${className}`}>{children}</span>
  );
}

/** Barlow 500 · 12 · tabular. Counts and units that sit next to each other must not jitter. */
export function Meta({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <span className={`text-xs font-medium tabular-nums ${className}`}>{children}</span>
  );
}
