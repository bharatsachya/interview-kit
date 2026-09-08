import type { ButtonHTMLAttributes, ReactNode } from "react";

type Variant = "primary" | "secondary" | "ghost" | "danger";

const VARIANT: Readonly<Record<Variant, string>> = {
  primary: "bg-teal-700 text-paper border-teal-700 hover:bg-teal-800 active:bg-teal-900",
  secondary: "border-divider hover:bg-ink/7 active:bg-ink/14",
  ghost: "border-transparent text-teal-700 hover:bg-teal-700/10 active:bg-teal-700/20",
  // The one red. Deletion and failure only — nothing else in the product may use it.
  danger: "border-alarm text-alarm hover:bg-alarm/10 active:bg-alarm/20",
};

/**
 * Every hit target is at least 44px on phone, including this one — which is why the height is
 * on the component and not left to each caller to remember.
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
      className={`font-head rounded-control inline-flex min-h-11 items-center justify-center gap-3 border px-4 text-sm tracking-wide disabled:cursor-not-allowed disabled:opacity-45 md:min-h-9 ${VARIANT[variant]} ${className}`}
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
