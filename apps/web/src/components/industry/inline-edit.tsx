"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Text that becomes an input where it sits.
 *
 * The builder edits a document, so the editor is the document. A modal would mean the thing you
 * are changing is covered by the thing you are changing it with, and the surrounding questions —
 * the reason you are editing this one — go with it.
 *
 * Saving on blur is deliberate and is why there is no Save button. Clicking away from a field
 * you have typed in means you are done with it; asking you to confirm that is a second gesture
 * for no information. Escape reverts, which is the one intent blur genuinely cannot express.
 *
 * Nothing is sent when nothing changed. Every write bumps the kit's version, and a version bump
 * for a field somebody tabbed through would invalidate another tab's work for no reason at all.
 */
export function InlineEdit({
  value,
  onSave,
  multiline = false,
  placeholder = "Empty",
  label,
  className = "",
  textClassName = "",
  busy = false,
}: {
  value: string;
  onSave: (next: string) => void;
  multiline?: boolean;
  placeholder?: string;
  label: string;
  className?: string;
  textClassName?: string;
  busy?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const field = useRef<HTMLTextAreaElement | HTMLInputElement>(null);

  // Someone else's change landing while this sits idle should show through; while it is being
  // typed in, it must not.
  useEffect(() => {
    if (!editing) setDraft(value);
  }, [value, editing]);

  useEffect(() => {
    if (!editing) return;
    const element = field.current;
    if (!element) return;
    element.focus();
    element.setSelectionRange(element.value.length, element.value.length);
  }, [editing]);

  function commit() {
    setEditing(false);
    const next = draft.trim();
    if (next !== value.trim()) onSave(next);
  }

  if (!editing) {
    return (
      <button
        type="button"
        onClick={() => setEditing(true)}
        aria-label={`Edit ${label}`}
        className={`hover:bg-steel-100 -mx-1.5 -my-0.5 w-full rounded-md px-1.5 py-0.5 text-left transition-colors ${
          busy ? "opacity-50" : ""
        } ${className}`}
      >
        {/* Outlines are one point per line, and a span collapses those into a paragraph. The
            displayed text has to break where the editable text breaks or the two disagree about
            what the user wrote. */}
        <span
          className={`${multiline ? "whitespace-pre-line" : ""} ${
            value.trim() === "" ? "text-ink/35 italic" : textClassName
          }`}
        >
          {value.trim() === "" ? placeholder : value}
        </span>
      </button>
    );
  }

  const shared = {
    ref: field as never,
    value: draft,
    "aria-label": label,
    onBlur: commit,
    onChange: (event: { target: { value: string } }) => setDraft(event.target.value),
    onKeyDown: (event: React.KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setDraft(value);
        setEditing(false);
      }
      // Enter commits a single line; in a paragraph it is a paragraph break, so there ⌘↵ does it.
      if (event.key === "Enter" && (!multiline || event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        commit();
      }
    },
    className: `bg-surface rounded-control -mx-1.5 -my-0.5 w-full px-1.5 py-0.5 outline-none ring-2 ring-steel-400 ${className}`,
  };

  if (!multiline) return <input {...shared} />;

  // In a paragraph, Enter is a paragraph break and the commit key is the one nobody guesses. So it
  // is written under the field for as long as the field is open — a hint that is only there while
  // it applies costs nothing when it does not. Hidden on touch, where there is no ⌘ to press and
  // tapping away already saves.
  return (
    <span className="flex flex-col gap-1">
      <textarea {...shared} rows={Math.min(10, Math.max(2, draft.split("\n").length + 1))} />
      <span aria-hidden className="text-ink/35 hidden text-[11px] [@media(hover:hover)]:block">
        ⌘↵ / Ctrl↵ to save · Esc to cancel · click away saves too
      </span>
    </span>
  );
}
