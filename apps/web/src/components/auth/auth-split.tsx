import type { ReactNode } from "react";
import { HeroStage } from "@/components/hero/hero-stage";

/**
 * The shell both auth screens share: the object on the left, the form on the right.
 *
 * The split collapses below `lg` rather than stacking. On a phone the form is the entire reason
 * the page exists, and a hero above it would push the fields under the fold — the object is
 * decoration, and decoration does not get to come first.
 *
 * Hiding the hero was only half of it, though, and the half that is easy to check. What was left
 * was a card sized for a desktop: `min-h-screen` reserving height a phone browser's toolbars
 * occupy, 64px of vertical padding on a 700px screen, and — the actual break — Clerk's 400px-wide
 * box inside a container that is 286px on a 390px phone, overflowing and clipping every control
 * at the right edge. See the width note on the card.
 *
 * The plate is the copy from the standalone export, unchanged. It says what the product does in
 * three beats, which is the whole job of a sign-in page that nobody asked to be on.
 */

const BEATS = [
  { swatch: "#f4f4f5", ring: true, label: "the posting", detail: "paste it" },
  { swatch: "#5980a6", ring: false, label: "we build it", detail: "nine steps, traced" },
  { swatch: "#2f4359", ring: false, label: "the kit", detail: "questions, brief, schedule" },
] as const;

export function AuthSplit({ children }: { children: ReactNode }) {
  return (
    <div className="grid min-h-dvh grid-cols-1 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
      {/* Left: the object. Hidden outright on small screens — not scaled down, not stacked. */}
      <div className="relative hidden overflow-hidden bg-tint-soft lg:block">
        <div className="absolute inset-x-0 top-0 z-10 p-10">
          <p className="font-head text-[11px] font-semibold tracking-[0.16em] text-steel-600 uppercase">
            Interview Prep Kit
          </p>
          <h1 className="mt-1.5 font-head text-[34px] leading-[1.05] font-semibold text-ink">
            Paste a posting.
            <br />
            Get the kit.
          </h1>
          <dl className="mt-7 grid max-w-[22rem] gap-2.5">
            {BEATS.map((beat, index) => (
              <div key={beat.label} className="flex items-baseline gap-3 text-[13px]">
                <span
                  aria-hidden="true"
                  className="size-[11px] shrink-0 translate-y-[1px] rounded-[3px]"
                  style={{
                    background: beat.swatch,
                    ...(beat.ring ? { outline: "1px solid #dcdce0" } : {}),
                  }}
                />
                <dt className="font-medium text-ink">
                  {index + 1} — {beat.label}
                </dt>
                <dd className="ml-auto text-right text-steel-700">{beat.detail}</dd>
              </div>
            ))}
          </dl>
        </div>

        <HeroStage className="h-full w-full" />
      </div>

      {/* Right: the form, and nothing else. */}
      <div className="flex items-center justify-center bg-paper px-4 py-8 sm:px-6 sm:py-16">
        {/*
          One card, and one card only.

          Clerk ships its own raised white card *and* a second, lighter panel behind the footer —
          which on a page whose ground is already near-white produced three stacked surfaces and
          put the loudest one under "Secured by Clerk". The branding cannot be removed on this
          plan and does not need to be; it needs to stop being the brightest thing on the screen.

          So Clerk's surfaces are flattened to nothing and this element is the card: the same
          fill, hairline and radius as every other panel in the product. Clerk's injected CSS
          outranks a class passed through `appearance.elements`, so the overrides are written
          here with the specificity to win, and scoped to this screen — the `UserButton` popover
          in the app still wants the raised card it ships with.
        */}
        <div
          className={[
            // 28.5rem = Clerk's own 400px box plus this card's padding on both sides, measured
            // rather than guessed. At 26rem the box overflowed and every control was clipped at
            // the right edge; forcing the box to 100% instead collapsed it to 238px, because
            // that width resolves against a wrapper of Clerk's own and not against this card.
            // Letting it keep the width it wants and sizing the card around it is the version
            // that survives Clerk changing its internals.
            "w-full max-w-[28.5rem] rounded-card border border-tint-line bg-surface px-4 py-6 sm:px-7 sm:py-8",
            // Clerk's box is 400px WIDE — not max-width — and on a phone there is no 400px to
            // give it. Under a 390px viewport the available content width is about 286px, so the
            // box overflowed its card and every control was clipped at the right edge: the exact
            // symptom the desktop comment below describes, arriving from the other direction.
            //
            // `max-width` rather than `width`. Setting `width: 100%` was tried and collapses the
            // box to 238px, because that percentage resolves against a wrapper of Clerk's own
            // rather than against this card. A max-width caps the 400px it asks for without
            // giving it a different basis to resolve against, so it stays 400px wherever there
            // is room and shrinks to the card everywhere else.
            "[&_.cl-cardBox]:!max-w-full [&_.cl-card]:!max-w-full",
            // Long provider labels and the email a person is signing in with are the two strings
            // that overflow a 286px box, and neither may push the page sideways.
            "[&_.cl-formButtonPrimary]:!whitespace-normal",
            "overflow-hidden",
            "[&_.cl-cardBox]:!mx-auto",
            "shadow-[0_1px_2px_rgba(29,31,32,0.04),0_8px_24px_-12px_rgba(29,31,32,0.10)]",
            // Clerk's own surfaces, removed so they cannot stack inside this one.
            "[&_.cl-cardBox]:!rounded-none [&_.cl-cardBox]:!border-0 [&_.cl-cardBox]:!bg-transparent [&_.cl-cardBox]:!shadow-none",
            "[&_.cl-card]:!rounded-none [&_.cl-card]:!bg-transparent [&_.cl-card]:!px-0 [&_.cl-card]:!py-0 [&_.cl-card]:!shadow-none",
            // The footer: a hairline and quiet text, not a panel of its own.
            // `bg-none`, and that is the whole fix.
            //
            // The footer's grey is a `linear-gradient`, not a background *colour* — so
            // `bg-transparent`, which only ever sets `background-color`, left it exactly as it
            // was. Three passes at this failed for that reason: the computed backgroundColor
            // read `rgba(0,0,0,0)` and looked correct while the panel was still plainly on
            // screen, painted by a property nobody was looking at.
            "[&_.cl-footer]:!mt-7 [&_.cl-footer]:!rounded-none [&_.cl-footer]:!bg-none [&_.cl-footer]:!bg-transparent [&_.cl-footer]:!px-0 [&_.cl-footer]:!pt-0 [&_.cl-footer]:!pb-0 [&_.cl-footer]:!shadow-none",
            // Clerk's own divider between the two footer rows, which only made sense while they
            // sat in a panel of their own.
            "[&_.cl-footerItem]:!border-t-0",
            "[&_.cl-footer_*]:!bg-transparent [&_.cl-footer_*]:!shadow-none",
            "[&_.cl-footerAction]:!border-0 [&_.cl-footerAction]:!px-0",
            // "Secured by Clerk" and the development badge, turned down to a footnote. Both are
            // true and neither is the point of the page. Targeted by role rather than by
            // Clerk's hashed internal class names, which are not ours to depend on.
            "[&_.cl-footer]:!text-[12px] [&_.cl-footer_svg]:!opacity-55",
            // The one thing in the footer worth clicking keeps its weight.
            "[&_.cl-footerActionLink]:!text-[13px] [&_.cl-footerActionLink]:!font-medium [&_.cl-footerActionLink]:!text-steel-700",
            "[&_.cl-footerActionText]:!text-[13px]",
          ].join(" ")}
        >
          {children}
        </div>
      </div>
    </div>
  );
}
