"use client";

import { useEffect, useState } from "react";

/**
 * One switcher, two placements: a sticky rail on the laptop, the same list pinned to the
 * bottom of the phone where the thumb is. The laptop adds a column; it does not add furniture.
 *
 * These are plain anchors, so keyboard and screen-reader navigation come from the platform and
 * the browser's own back/forward still works. The active section is tracked by observing the
 * headings rather than by scroll maths — the sections are wildly different heights, and a
 * percentage-of-page guess would highlight the wrong one on every long question list.
 */
export function SectionSwitcher({
  sections,
}: {
  sections: readonly { id: string; label: string }[];
}) {
  const [active, setActive] = useState<string>(sections[0]?.id ?? "");

  useEffect(() => {
    const elements = sections
      .map((section) => document.getElementById(section.id))
      .filter((element) => element !== null);

    if (elements.length === 0) return;

    const observer = new IntersectionObserver(
      (entries) => {
        // The topmost section currently intersecting wins. Taking the last entry instead would
        // make the highlight jump to whatever happened to fire most recently.
        const visible = entries
          .filter((entry) => entry.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        const first = visible[0];
        if (first) setActive(first.target.id);
      },
      { rootMargin: "0px 0px -60% 0px", threshold: 0 },
    );

    for (const element of elements) observer.observe(element);
    return () => observer.disconnect();
  }, [sections]);

  return (
    <nav aria-label="Kit sections">
      {/* Laptop: sticky rail. */}
      <ul className="border-divider bg-paper fixed inset-x-0 bottom-0 z-10 flex list-none justify-between gap-2 overflow-x-auto border-t px-4 py-2 md:sticky md:top-6 md:z-auto md:w-40 md:flex-col md:justify-start md:gap-3 md:border-none md:px-0 md:py-0">
        {sections.map((section) => {
          const isActive = section.id === active;
          return (
            <li key={section.id}>
              <a
                href={`#${section.id}`}
                aria-current={isActive ? "true" : undefined}
                className={`font-head flex min-h-11 items-center px-2 text-xs tracking-widest uppercase md:min-h-0 md:px-0 md:py-1 ${
                  isActive ? "text-teal-800 underline underline-offset-4" : "opacity-55"
                }`}
              >
                {section.label}
              </a>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
