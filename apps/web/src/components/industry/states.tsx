import type { ReactNode } from "react";
import { Frame } from "./frame";
import { Eyebrow } from "./text";

/**
 * The loading, empty and error states, defined once.
 *
 * They exist here rather than being written per screen because three of the four states a
 * component has are the ones that decide whether the app feels honest, and states invented
 * separately on each screen end up inconsistent exactly when it matters.
 */

/**
 * Loading says what is happening and how far along it is. Never a bare spinner, and never a
 * percentage the system cannot actually compute.
 */
export function Loading({ label, detail }: { label: string; detail?: string }) {
  return (
    <div role="status" className="flex flex-col gap-2 py-6">
      <p className="text-sm font-medium tabular-nums">{label}…</p>
      {detail ? <p className="text-xs opacity-55">{detail}</p> : null}
    </div>
  );
}

/** A placeholder with the shape of the thing that is coming, so nothing reflows when it lands. */
const SKELETON_WIDTHS = ["w-full", "w-4/5", "w-3/5", "w-2/3", "w-1/2"] as const;

export function Skeleton({ lines = 3 }: { lines?: number }) {
  return (
    <div aria-hidden>
      <Frame className="flex flex-col gap-3 p-4">
        {Array.from({ length: lines }, (_, index) => (
          <span key={index} className={`bg-ink/10 block h-3 ${SKELETON_WIDTHS[index % SKELETON_WIDTHS.length]}`} />
        ))}
      </Frame>
    </div>
  );
}

/**
 * Empty is drawn dashed in ink, not red, and left in place rather than hidden. An absence is
 * worth seeing; it is not a failure, and the one red is not spent on it.
 */
export function EmptyState({
  title,
  children,
  actions,
}: {
  title?: string;
  children: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <Frame empty className="flex flex-col gap-3 p-4">
      {title ? <Eyebrow className="opacity-70">{title}</Eyebrow> : null}
      <div className="max-w-read text-sm leading-relaxed">{children}</div>
      {actions ? <div className="flex flex-wrap gap-3">{actions}</div> : null}
    </Frame>
  );
}

/**
 * A message that needs an answer: retry, or carry on without it.
 *
 * Repeated failure is counted and printed rather than made louder — the red is already the
 * only red in the product, so it never has to shout twice.
 */
export function ErrorNotice({
  title,
  children,
  attempts,
  actions,
}: {
  title: string;
  children?: ReactNode;
  attempts?: number;
  actions?: ReactNode;
}) {
  return (
    <div role="alert" className="border-alarm flex flex-col gap-3 border-l-4 py-3 pl-4">
      <div className="flex flex-wrap items-baseline gap-3">
        <Eyebrow className="text-alarm">{title}</Eyebrow>
        {attempts && attempts > 1 ? (
          <span className="text-alarm text-xs font-medium tabular-nums">×{attempts} attempts</span>
        ) : null}
      </div>
      {children ? <div className="max-w-read text-sm leading-relaxed">{children}</div> : null}
      {actions ? <div className="flex flex-wrap gap-3">{actions}</div> : null}
    </div>
  );
}
