import type { ReactNode } from "react";

/**
 * Cards are hairline frames on paper with registration marks, never filled panels.
 *
 * The marks sit outside the border, so the frame must not clip.
 *
 * `trouble` is the dashed red variant — incomplete or unverified. `empty` is dashed in ink, for
 * a section that is legitimately empty: a gap worth seeing, but not a failure, and the one red
 * is not spent on it.
 */
export function Frame({
  children,
  className = "",
  trouble = false,
  empty = false,
  marks = true,
  as: Tag = "div",
}: {
  children: ReactNode;
  className?: string;
  trouble?: boolean;
  empty?: boolean;
  marks?: boolean;
  as?: "div" | "article" | "section" | "li";
}) {
  return (
    <Tag
      className={`blueprint ${trouble ? "blueprint-trouble" : ""} ${empty ? "blueprint-empty" : ""} ${className}`}
    >
      {marks ? (
        <>
          <span aria-hidden className="corner corner-tl" />
          <span aria-hidden className="corner corner-tr" />
          <span aria-hidden className="corner corner-bl" />
          <span aria-hidden className="corner corner-br" />
        </>
      ) : null}
      {children}
    </Tag>
  );
}
