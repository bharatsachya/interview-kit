import type { ReactNode } from "react";

/**
 * A card: a tinted fill with a 14px radius, no border and no marks.
 *
 * This used to be a hairline frame with registration marks at its corners, which is where the
 * name comes from. Both are gone: forty marks on one screen is a texture rather than an accent,
 * and a border around the application only redraws an edge the window already has. What is left
 * is the fill, and the fill is enough to say "this is an object" without drawing a line round it.
 *
 * `tone="tile"` is the recessed variant, for a card that sits inside another tint.
 * `tone="plain"` is for a card on the white artifact panel that wants only its radius.
 *
 * `trouble` and `empty` are the two states that still earn an edge, because both are claims
 * about the content rather than decoration: this failed, and this is genuinely empty. They are
 * dashed, they are never adjacent to each other, and they are the only borders left inside the
 * window.
 */
export function Frame({
  children,
  className = "",
  tone = "card",
  trouble = false,
  empty = false,
  as: Tag = "div",
}: {
  children: ReactNode;
  className?: string;
  tone?: "card" | "tile" | "plain";
  trouble?: boolean;
  empty?: boolean;
  as?: "div" | "article" | "section" | "li";
}) {
  const base = trouble
    ? "frame-trouble"
    : empty
      ? "frame-empty"
      : tone === "tile"
        ? "tile"
        : tone === "plain"
          ? "rounded-card"
          : "card";

  return <Tag className={`${base} ${className}`}>{children}</Tag>;
}
