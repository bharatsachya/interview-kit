import type { ReactNode } from "react";
import { HeroStage } from "@/components/hero/hero-stage";

/**
 * The shell both auth screens share: the object on the left, the form on the right.
 *
 * The split collapses below `lg` rather than stacking. On a phone the form is the entire reason
 * the page exists, and a hero above it would push the fields under the fold — the object is
 * decoration, and decoration does not get to come first.
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
    <div className="grid min-h-screen grid-cols-1 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
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
      <div className="flex items-center justify-center bg-paper px-6 py-16">
        {/*
          Clerk ships a floating white card with a drop shadow, and its own injected CSS outranks
          a utility class passed through `appearance.elements` — so the flattening is done here,
          with the specificity to win.

          Industry took the frames off everything on purpose: surfaces are separated by tinted
          fills and gaps, not by borders and lift. The form sits on the paper ground like every
          other panel in the product. Scoped to this screen, so the `UserButton` popover in the
          app keeps the raised card it should have.
        */}
        <div
          className="w-full max-w-[26rem] [&_.cl-card]:!bg-transparent [&_.cl-card]:!shadow-none [&_.cl-cardBox]:!border-0 [&_.cl-cardBox]:!bg-transparent [&_.cl-cardBox]:!shadow-none [&_.cl-footer]:!border-0 [&_.cl-footer]:!bg-transparent [&_.cl-footer]:!shadow-none [&_.cl-footer_*]:!bg-transparent [&_.cl-footer_*]:!border-t-0"
        >
          {children}
        </div>
      </div>
    </div>
  );
}
