/**
 * What stands in the card until Clerk's form has mounted.
 *
 * `<SignIn />` renders nothing at all until its own bundle loads and hydrates. So the card had
 * its padding and no contents — a 60px sliver on a page otherwise empty — and then, a beat
 * later, snapped to the height of a full form. Everything on the screen moved at once, which is
 * the "all over the place" of it.
 *
 * The fix is the same one `BootSplash` uses on the workspace, and the reason is worth stating
 * because it is not "add a spinner": **the card is at its final size the whole time.** This
 * stands in at the height the real form occupies, so when Clerk arrives the placeholder is
 * replaced and nothing reflows. A spinner in a collapsed card would have been an animation
 * playing over the same jump.
 *
 * It is shaped like the form rather than like generic bars — a heading, two fields, a button, a
 * footer line. A placeholder that matches what is coming reads as "this is loading"; a stack of
 * identical grey rectangles reads as a broken page, which is the impression being fixed.
 *
 * Marked `aria-hidden` and paired with a live region in `AuthSplit`: a screen reader should be
 * told "signing you in" once, not handed a tree of meaningless boxes.
 */
export function AuthSkeleton() {
  return (
    <div aria-hidden className="flex flex-col gap-5 py-1">
      {/* Heading and its subtitle, which Clerk draws centred. */}
      <div className="flex flex-col items-center gap-2">
        <Bar className="h-4 w-40" />
        <Bar className="h-3 w-52" delay="0.1s" />
      </div>

      {/* The social buttons, when there are any. Two is the common case and the height is the
          same whether it is one or three — the card is sized for the form, not for this. */}
      <div className="flex flex-col gap-2">
        <Bar className="h-9 w-full rounded-[10px]" delay="0.16s" />
      </div>

      <div className="flex items-center gap-3">
        <span className="bg-tint-line h-px flex-1" />
        <Bar className="h-2.5 w-6" delay="0.2s" />
        <span className="bg-tint-line h-px flex-1" />
      </div>

      {/* Label over field, twice — the shape of every credential form there has ever been. */}
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-1.5">
          <Bar className="h-2.5 w-16" delay="0.26s" />
          <Bar className="h-9 w-full rounded-[10px]" delay="0.3s" />
        </div>
        <div className="flex flex-col gap-1.5">
          <Bar className="h-2.5 w-20" delay="0.34s" />
          <Bar className="h-9 w-full rounded-[10px]" delay="0.38s" />
        </div>
      </div>

      <Bar className="h-9 w-full rounded-[10px]" delay="0.44s" />

      <div className="flex justify-center pt-1">
        <Bar className="h-2.5 w-44" delay="0.5s" />
      </div>
    </div>
  );
}

/**
 * One placeholder bar, with the sweep the rest of the product already uses for work in flight.
 *
 * `motion-safe:` on the animation and not on the bar: somebody who has asked for less motion
 * still gets the layout held and the shape shown, just without the travelling highlight. The
 * staggered delays are what stop eight bars pulsing in lockstep, which reads as a pattern rather
 * than as loading.
 */
function Bar({ className = "", delay = "0s" }: { className?: string; delay?: string }) {
  return (
    <span className={`bg-tint relative block overflow-hidden rounded-[6px] ${className}`}>
      <span
        aria-hidden
        style={{ animationDelay: delay }}
        className="motion-safe:animate-bar-sweep absolute inset-y-0 left-0 w-1/3 bg-gradient-to-r from-transparent via-white/70 to-transparent"
      />
    </span>
  );
}
