"use client";

import { useEffect, useRef, useState } from "react";
import { askPlainText, askSize, askTitle, type Posting } from "@/lib/ask";
import { copyText } from "@/lib/copy";
import { glimpseUrl } from "@/lib/url-glimpse";
import { IconButton } from "@/components/industry/button";

/**
 * The posting you sent, as a document rather than as a wall of text.
 *
 * A job description is a page long. Printed into the conversation it pushes the run — the thing
 * you are actually waiting on — off the screen, and truncating it to two hundred characters
 * meant the full text existed nowhere you could reach: the composer clears on submit, so if a
 * run went wrong, getting your own posting back meant finding the original tab.
 *
 * So the turn shows a card that names it and says how long it is, and the text lives one click
 * away in a dialog with room to read. The settings that went with it — the site, the days —
 * stay on the card, because those are the parts you check at a glance.
 */
export function AskDocument({ ask }: { ask: Posting }) {
  const [open, setOpen] = useState(false);

  return (
    <div className="flex flex-col items-end gap-1">
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
        className="bg-tint hover:bg-tint-strong focus-visible:ring-steel-400 flex max-w-[86%] min-w-0 items-center gap-3 rounded-[16px] rounded-br-[6px] px-3.5 py-3 text-left transition-colors focus-visible:ring-2 focus-visible:outline-none"
      >
        <span className="bg-steel-100 text-steel-700 grid size-9 shrink-0 place-items-center rounded-lg">
          <DocumentIcon />
        </span>
        <span className="flex min-w-0 flex-col">
          <span className="truncate text-sm font-semibold">{askTitle(ask.jd)}</span>
          <span className="text-ink/55 truncate text-xs">
            {askSize(ask.jd)} · {glimpseUrl(ask.url, 26)} ·{" "}
            {ask.days === 1 ? "1 day" : `${ask.days} days`}
          </span>
        </span>
      </button>

      <Timestamp at={ask.at} />

      {open ? <AskDialog ask={ask} onClose={() => setOpen(false)} /> : null}
    </div>
  );
}

/**
 * The posting, full size.
 *
 * A dialog rather than an expanding card: the conversation behind it keeps its scroll position,
 * and a page of text unfolding inline would push everything below it out from under the cursor.
 */
function AskDialog({ ask, onClose }: { ask: Posting; onClose: () => void }) {
  const panel = useRef<HTMLDivElement | null>(null);
  const [copied, setCopied] = useState(false);

  // Focus moves in on open, so the first Tab lands inside and a screen reader is told where it
  // now is. Escape closes, which is the only way out someone reaching for the keyboard will try.
  useEffect(() => {
    panel.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose();
      }
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [onClose]);

  // The page behind must not scroll under the dialog — on a phone that is how a modal ends up
  // showing the bottom of a conversation nobody asked to move.
  useEffect(() => {
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, []);

  async function copy() {
    setCopied(await copyText(askPlainText(ask)));
    if (!copied) setTimeout(() => setCopied(false), 1600);
  }

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/30 p-4 backdrop-blur-[2px]"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-label="The job description you sent"
        tabIndex={-1}
        className="bg-surface flex max-h-[86vh] w-full max-w-3xl flex-col rounded-2xl shadow-2xl outline-none"
      >
        <header className="flex shrink-0 items-start gap-3 border-b border-[var(--color-tint-line)] px-5 py-4">
          <span className="bg-steel-100 text-steel-700 grid size-9 shrink-0 place-items-center rounded-lg">
            <DocumentIcon />
          </span>
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="truncate text-sm font-semibold">{askTitle(ask.jd)}</span>
            <span className="text-ink/55 truncate text-xs">
              {askSize(ask.jd)} · {ask.url} ·{" "}
              {ask.days === 1 ? "1 day" : `${ask.days} days`} until the interview
            </span>
          </span>
          <span className="flex shrink-0 items-center gap-0.5">
            <IconButton label={copied ? "Copied" : "Copy the posting"} onClick={() => void copy()}>
              {copied ? <TickIcon /> : <CopyIcon />}
            </IconButton>
            <IconButton label="Close" onClick={onClose}>
              <CloseIcon />
            </IconButton>
          </span>
        </header>

        {/* `whitespace-pre-wrap`: a posting's blank lines and bullet indentation are most of its
            structure, and collapsing them turns a readable advert into a paragraph. */}
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          <p className="text-ink/80 text-sm leading-relaxed whitespace-pre-wrap">{ask.jd}</p>
        </div>
      </div>
    </div>
  );
}

function Timestamp({ at }: { at: number }) {
  return (
    <span className="text-ink/35 pr-1 text-[11px] tabular-nums">
      {new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
    </span>
  );
}

function DocumentIcon() {
  return (
    <svg aria-hidden width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <path d="M14 2v6h6M8 13h8M8 17h5" />
    </svg>
  );
}

function CopyIcon() {
  return (
    <svg aria-hidden width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="9" y="9" width="12" height="12" rx="2" />
      <path d="M5 15V5a2 2 0 0 1 2-2h10" />
    </svg>
  );
}

function TickIcon() {
  return (
    <svg aria-hidden width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M20 6L9 17l-5-5" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg aria-hidden width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <path d="M18 6L6 18M6 6l12 12" />
    </svg>
  );
}
