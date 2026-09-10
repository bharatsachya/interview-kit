import type { ButtonHTMLAttributes, ReactNode } from "react";

type Variant = "primary" | "secondary" | "ghost" | "outline" | "danger";

const VARIANT: Readonly<Record<Variant, string>> = {
  primary: "bg-steel-500 text-white hover:bg-steel-600 active:bg-steel-700",
  secondary: "bg-tint text-ink hover:bg-tint-strong active:bg-tint-line",
  ghost: "text-ink/55 hover:bg-steel-100 hover:text-steel-700 active:bg-steel-200",
  // The one outline left in the product. It is the rail's "New kit" and nothing else: an empty
  // workspace has no card for it to sit on, so the shape has to come from somewhere.
  outline:
    "text-steel-700 shadow-[inset_0_0_0_1px_var(--color-steel-300)] hover:bg-steel-100 hover:text-steel-800 hover:shadow-[inset_0_0_0_1px_var(--color-steel-400)]",
  // The one red. Deletion and failure only — nothing else in the product may use it.
  danger: "text-alarm hover:bg-alarm/10 active:bg-alarm/20",
};

/**
 * Every hit target is at least 44px on phone, including this one — which is why the height is
 * on the component and not left to each caller to remember.
 *
 * Pill by default. Buttons are the one thing on the page you are meant to reach for, and the
 * radius is what separates them from the cards they sit on now that neither has a border.
 *
 * `busy` keeps the label in place and adds a word beside it rather than swapping in a spinner:
 * a button whose text disappears mid-click loses the thing the user was reading.
 */
export function Button({
  children,
  variant = "secondary",
  busy = false,
  busyLabel = "Working",
  className = "",
  disabled,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  children: ReactNode;
  variant?: Variant;
  busy?: boolean;
  busyLabel?: string;
}) {
  return (
    <button
      {...rest}
      disabled={disabled ?? busy}
      aria-busy={busy || undefined}
      className={`rounded-pill inline-flex min-h-11 items-center justify-center gap-2 px-4 text-sm font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-45 md:min-h-9 ${VARIANT[variant]} ${className}`}
    >
      {children}
      {busy ? (
        <span className="text-xs font-medium opacity-70" aria-live="polite">
          {busyLabel}…
        </span>
      ) : null}
    </button>
  );
}

/**
 * An icon-only action: no label, no chrome until hovered, and a tooltip that names it.
 *
 * The tooltip is not decoration. Removing the label is what buys the header its quiet, and an
 * unlabelled glyph with no way to find out what it does is where that trade stops being worth
 * making — so the two arrive together and neither is optional.
 */
export function IconButton({
  children,
  label,
  className = "",
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { children: ReactNode; label: string }) {
  return (
    <span className="group relative inline-flex">
      <button
        {...rest}
        aria-label={label}
        className={`text-ink/40 hover:bg-steel-100 hover:text-steel-700 inline-grid size-8 place-items-center rounded-full transition-colors ${className}`}
      >
        {children}
      </button>
      <span
        aria-hidden
        className="bg-steel-900 pointer-events-none absolute top-full right-0 z-30 mt-2 rounded-md px-2 py-1.5 text-[11px] leading-none font-medium whitespace-nowrap text-white opacity-0 transition-opacity group-hover:opacity-100"
      >
        {label}
      </span>
    </span>
  );
}
