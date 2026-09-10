import type { ButtonHTMLAttributes, ReactNode } from "react";

type Tone = "accent" | "faded" | "trouble";

const TONE: Readonly<Record<Tone, string>> = {
  accent: "bg-steel-100 text-steel-700 hover:bg-steel-200 hover:text-steel-800",
  faded: "bg-tint text-ink/40 hover:bg-tint-strong hover:text-ink/60",
  // A badge whose value is missing or unusable. Dashed rather than filled red: the composer is
  // not broken, one of its two settings is, and a solid red pill beside a solid blue one reads
  // as an alarm rather than as a field that wants filling in.
  trouble: "text-alarm border border-dashed border-alarm hover:bg-alarm/10",
};

/**
 * A composer badge: the company URL, the days until the interview, the file of roles.
 *
 * These are settings, not fields. A setting whose value is already known should read as a token
 * you can pick up and change, not as a labelled input with an empty box next to it — so the
 * value *is* the control, and the label is folded into the sentence it makes ("8 days until the
 * interview" rather than "Days: 8").
 */
export function Badge({
  children,
  icon,
  tone = "accent",
  className = "",
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  children: ReactNode;
  icon?: ReactNode;
  tone?: Tone;
}) {
  return (
    <button
      {...rest}
      className={`rounded-pill inline-flex h-8 max-w-full items-center gap-1.5 px-3 text-[13px] font-medium whitespace-nowrap transition-colors ${TONE[tone]} ${className}`}
    >
      {icon}
      <span className="truncate">{children}</span>
    </button>
  );
}

/** The globe on the company badge. Sized to sit on the text baseline, not above it. */
export function GlobeIcon() {
  return (
    <svg aria-hidden width="13" height="13" viewBox="0 0 14 14" fill="none" className="shrink-0">
      <circle cx="7" cy="7" r="5.6" stroke="currentColor" strokeWidth="1.2" />
      <path
        d="M1.4 7h11.2M7 1.4c1.5 1.6 2.2 3.5 2.2 5.6S8.5 10.9 7 12.6C5.5 10.9 4.8 9.1 4.8 7S5.5 3 7 1.4z"
        stroke="currentColor"
        strokeWidth="1.2"
      />
    </svg>
  );
}

/** The calendar on the days badge. */
export function CalendarIcon() {
  return (
    <svg aria-hidden width="13" height="13" viewBox="0 0 14 14" fill="none" className="shrink-0">
      <rect x="1.6" y="2.6" width="10.8" height="9.8" rx="2" stroke="currentColor" strokeWidth="1.2" />
      <path
        d="M1.6 5.6h10.8M4.6 1.4v2.4M9.4 1.4v2.4"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
      />
    </svg>
  );
}
