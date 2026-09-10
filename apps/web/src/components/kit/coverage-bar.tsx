"use client";

import type { Requirement } from "@trao/kit";
import { Eyebrow } from "@/components/industry/text";

/**
 * Coverage of requirements — never a percentage alone.
 *
 * One cell per must-have: solid = covered, outline = uncovered. Each cell is focusable and
 * jumps to that requirement in the role breakdown, so the display is a list of things you can
 * go and fix rather than a score. No progress ring, no percentage.
 *
 * Nice-to-haves are counted separately and never block — an uncovered nice-to-have is not a
 * gap, and putting it in the same tally would make the number mean less.
 */
export function CoverageBar({
  requirements,
  uncoveredRequirementIds,
  passes,
}: {
  requirements: readonly Requirement[];
  uncoveredRequirementIds: readonly string[];
  passes: number;
}) {
  const uncovered = new Set(uncoveredRequirementIds);
  const musts = requirements.filter((r) => r.priority === "must");
  const uncoveredMusts = musts.filter((r) => uncovered.has(r.id));
  const coveredCount = musts.length - uncoveredMusts.length;
  const uncoveredNice = requirements.filter((r) => r.priority === "nice" && uncovered.has(r.id));

  if (musts.length === 0) {
    return (
      <p className="text-sm opacity-70">Coverage appears once there are requirements to cover.</p>
    );
  }

  return (
    <section aria-labelledby="coverage-heading" className="flex flex-col gap-3">
      <Eyebrow className="text-steel-700">
        <h2 id="coverage-heading" className="inline">
          Coverage
        </h2>
      </Eyebrow>

      <ul className="flex flex-wrap gap-2">
        {musts.map((requirement) => {
          const isUncovered = uncovered.has(requirement.id);
          return (
            <li key={requirement.id}>
              <a
                href={`#requirement-${requirement.id}`}
                title={`${requirement.text} — ${isUncovered ? "no question yet" : "covered"}`}
                className={`border-ink block h-6 w-6 border ${isUncovered ? "bg-transparent" : "bg-ink"}`}
              >
                <span className="sr-only">
                  {requirement.text} — {isUncovered ? "no question yet" : "covered"}
                </span>
              </a>
            </li>
          );
        })}
      </ul>

      <p className="text-sm tabular-nums">
        <strong className="font-medium">
          {coveredCount} of {musts.length}
        </strong>{" "}
        must-haves have a question
        {uncoveredMusts.length > 0 ? (
          <>
            {" · "}
            <span className="text-alarm font-medium">{uncoveredMusts.length} uncovered</span>
          </>
        ) : null}
        {uncoveredNice.length > 0 ? ` · ${uncoveredNice.length} nice-to-have not covered` : ""}
      </p>

      <p className="text-xs opacity-55 tabular-nums">
        {passes === 1 ? "One coverage pass" : `${passes} coverage passes`} — a gap left here is one
        the second pass could not close, not one we skipped.
      </p>
    </section>
  );
}
