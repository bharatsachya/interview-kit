"use client";

import type { Requirement } from "@trao/kit";

/**
 * Must-haves are solid — the only filled small objects in the product, so a scan of the role
 * breakdown reads as a weight map. Nice-to-haves are outlined. The word is always printed too;
 * the fill is reinforcement, not the message.
 *
 * Selecting a chip filters the question bank to that requirement. Clicking the MUST / NICE
 * word alone toggles priority — a one-tap correction, no menu — which is why the word is a
 * nested control rather than part of the chip's own label.
 *
 * Both are buttons only when a handler is supplied. In the read-only kit view there is nothing
 * to act on, and a control that looks pressable but does nothing is worse than plain text.
 */
export function RequirementChip({
  requirement,
  selected = false,
  dimmed = false,
  onSelect,
  onTogglePriority,
}: {
  requirement: Requirement;
  selected?: boolean;
  dimmed?: boolean;
  onSelect?: (id: string) => void;
  onTogglePriority?: (id: string) => void;
}) {
  const must = requirement.priority === "must";

  const tone = must
    ? "bg-steel-800 text-paper border-steel-800"
    : "bg-transparent text-steel-800 border-steel-600";
  const selection = selected ? "outline-2 outline-offset-2 outline-steel-700" : "";

  return (
    <span
      className={`inline-flex min-h-11 items-center gap-3 border px-3 py-1 text-sm transition-opacity ${tone} ${selection} ${dimmed ? "opacity-40" : ""}`}
    >
      {onSelect ? (
        <button
          type="button"
          className="text-left"
          aria-pressed={selected}
          onClick={() => onSelect(requirement.id)}
        >
          {requirement.text}
        </button>
      ) : (
        <span>{requirement.text}</span>
      )}

      {onTogglePriority ? (
        <button
          type="button"
          className={`font-head shrink-0 text-xs tracking-widest uppercase ${must ? "text-paper" : "text-steel-700"}`}
          aria-label={`${requirement.text} is a ${must ? "must" : "nice"}-have. Change to ${must ? "nice" : "must"}-have.`}
          onClick={() => onTogglePriority(requirement.id)}
        >
          {must ? "Must" : "Nice"}
        </button>
      ) : (
        <span className={`font-head shrink-0 text-xs tracking-widest uppercase ${must ? "text-paper" : "text-steel-700"}`}>
          {must ? "Must" : "Nice"}
        </span>
      )}
    </span>
  );
}
