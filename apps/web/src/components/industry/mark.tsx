/**
 * The loading identity.
 *
 * One glyph, two states. It is a registration mark — a hairline square, four crosshair ticks
 * pointing inward, a solid dot at the centre — which is the same vocabulary the window frame's
 * corner marks were drawn in. A generic spinner would have been a borrowed shape that says
 * nothing about this product; this one is the product's own mark, and the only difference
 * between "working" and "done" is whether it is moving.
 *
 * That matters more than it sounds. Because the settled state is the same glyph, the assistant's
 * avatar in the conversation can *be* this mark: it comes alive while the run is going and
 * settles when the run does, rather than a spinner being swapped out for an unrelated icon.
 *
 * Live: the square's dashes crawl, the dot breathes, and a thin arc turns around the whole
 * thing. Settled: identical geometry, solid stroke, still dot, no ring.
 */
export function Mark({
  size = 22,
  live = false,
  ring,
  className = "",
}: {
  size?: number;
  live?: boolean;
  /** Diameter of the turning arc. Defaults to a ring that clears the square when live. */
  ring?: number | false;
  className?: string;
}) {
  const ringSize = ring === false ? 0 : (ring ?? (live ? Math.round(size * 1.9) : 0));
  const box = Math.max(size, ringSize);
  // Stroke widths live in the 24-unit viewBox, so a fixed value thins out as the mark shrinks —
  // at 11px a 1.6 stroke renders at 0.7px and the glyph turns to grey mush. Scaling the width by
  // the same factor the viewBox is scaled by holds every size at one optical hairline.
  const unit = 24 / size;

  return (
    <span
      aria-hidden
      className={`relative inline-grid shrink-0 place-items-center ${className}`}
      style={{ width: box, height: box }}
    >
      {ringSize > 0 ? <Ring size={ringSize} className="absolute" /> : null}

      <svg width={size} height={size} viewBox="0 0 24 24" fill="none" className="relative">
        {/* 15 a side → perimeter 60 → the 6+4 dash pattern divides it exactly six times, which
            is what lets the crawl loop with no seam. */}
        <rect
          x="4.5"
          y="4.5"
          width="15"
          height="15"
          stroke="var(--color-steel-300)"
          strokeWidth={unit}
          {...(live
            ? { strokeDasharray: "6 4", className: "motion-safe:animate-mark-crawl" }
            : {})}
        />

        <g stroke="var(--color-steel-500)" strokeWidth={unit * 1.3} strokeLinecap="round">
          <path d="M12 4.5V8.2" />
          <path d="M12 19.5v-3.7" />
          <path d="M4.5 12H8.2" />
          <path d="M19.5 12h-3.7" />
        </g>

        <circle
          cx="12"
          cy="12"
          r="2.3"
          fill="var(--color-steel-700)"
          className={live ? "motion-safe:animate-mark-breathe" : ""}
          // SVG scales about the user-space origin unless told otherwise, which would fling the
          // dot to the corner instead of pulsing it in place.
          style={live ? { transformBox: "fill-box", transformOrigin: "center" } : undefined}
        />
      </svg>
    </span>
  );
}

/**
 * The turning arc on its own.
 *
 * Used at 11px in place of a trace row's step number, where there is no room for the full mark
 * but the row still has to say it is the one running.
 */
export function Ring({ size = 16, className = "" }: { size?: number; className?: string }) {
  const unit = 24 / size;
  return (
    <svg
      aria-hidden
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      className={`shrink-0 motion-safe:animate-ring-spin ${className}`}
    >
      <circle
        cx="12"
        cy="12"
        r="9.6"
        stroke="var(--color-steel-500)"
        strokeWidth={unit * 1.5}
        strokeLinecap="round"
        // Circumference ≈ 60.3; a 14-unit arc is a little under a quarter turn. The radius leaves
        // room for the thickest stroke this scales to, so the small ring is not clipped by its
        // own viewBox.
        strokeDasharray="14 47"
      />
    </svg>
  );
}
