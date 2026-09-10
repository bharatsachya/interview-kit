"use client";

import { useMemo, useState } from "react";
import type { KitSummary } from "@/lib/api/types";
import { buildComparison, type ComparisonRow } from "@/lib/compare";
import { useKits } from "@/lib/use-kits";
import { Button } from "@/components/industry/button";
import { EmptyState, Loading } from "@/components/industry/states";
import { Eyebrow, Kicker } from "@/components/industry/text";

const KIND_LABEL: Readonly<Record<string, string>> = {
  technical: "Technical",
  behavioural: "Behavioural",
  domain: "Domain",
};

/**
 * Several openings, one scorecard.
 *
 * The kits are already four documents; what they are not is one answer to "what should I spend
 * this week on". Every posting that wants distributed systems is a reason to study distributed
 * systems, and that count only exists once the scorecards are laid over each other.
 *
 * Rows are sorted by how many postings want the thing, so the top of the table is the study
 * order. Nothing here is generated — it is the requirements the pipeline already extracted,
 * grouped by vocabulary overlap in code.
 */
export function CompareView({
  kits,
  onOpenKit,
  onClose,
}: {
  kits: KitSummary[];
  onOpenKit: (kitId: string) => void;
  onClose: () => void;
}) {
  // Everything is compared by default. Someone who opens a comparison wants the comparison, not
  // an empty table and a checklist to fill in first.
  const [excluded, setExcluded] = useState<string[]>([]);
  const chosen = useMemo(
    () => kits.filter((kit) => !excluded.includes(kit.id)).map((kit) => kit.id),
    [kits, excluded],
  );

  const { loaded, pending, failed } = useKits(chosen);
  const comparison = useMemo(() => buildComparison(loaded), [loaded]);

  if (kits.length < 2) {
    return (
      <div className="py-10">
        <EmptyState title="Nothing to compare yet">
          A comparison needs two kits. Build another and this shows what both postings want.
        </EmptyState>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-5 py-1">
      <div className="flex flex-wrap items-baseline gap-3">
        <h1 className="text-[24px] md:text-[27px]">What every posting wants</h1>
        <span className="text-ink/55 text-xs">
          {comparison.kits.length} {comparison.kits.length === 1 ? "kit" : "kits"} ·{" "}
          {comparison.rows.length} distinct{" "}
          {comparison.rows.length === 1 ? "requirement" : "requirements"}
        </span>
        <Button variant="ghost" onClick={onClose} className="ml-auto">
          Back to the conversation
        </Button>
      </div>

      {/* Which kits are in. A toggle rather than a picker: the default is everything, and this
          is for taking one out when a role is no longer live. */}
      <div className="flex flex-wrap gap-1.5">
        {kits.map((kit) => {
          const on = !excluded.includes(kit.id);
          return (
            <button
              key={kit.id}
              type="button"
              aria-pressed={on}
              onClick={() =>
                setExcluded((previous) =>
                  on ? [...previous, kit.id] : previous.filter((id) => id !== kit.id),
                )
              }
              className={`rounded-pill inline-flex h-8 items-center gap-2 px-3 text-[13px] font-medium transition-colors ${
                on ? "bg-steel-100 text-steel-700" : "bg-tint text-ink/40 line-through"
              }`}
            >
              {kit.company}
            </button>
          );
        })}
      </div>

      {failed.length > 0 ? (
        <p className="text-alarm text-xs font-medium">
          {failed.length} {failed.length === 1 ? "kit" : "kits"} could not be loaded and{" "}
          {failed.length === 1 ? "is" : "are"} missing from this table.
        </p>
      ) : null}

      {loaded.length === 0 ? (
        <Loading label="Reading the kits" />
      ) : (
        <>
          {comparison.shared.length > 0 ? (
            <div className="bg-steel-100 text-steel-900 rounded-card px-4 py-3">
              <Kicker>Wanted by all {comparison.kits.length}</Kicker>
              <p className="mt-1 text-[13.5px] leading-relaxed">
                {sentence(joinWords(comparison.shared.map((row) => row.label.toLowerCase())))}. Every posting
                asks for {comparison.shared.length === 1 ? "it" : "these"}, so
                {comparison.shared.length === 1 ? " it is" : " they are"} worth more of the week
                than anything below.
              </p>
            </div>
          ) : (
            <p className="text-ink/55 text-[13.5px]">
              Nothing is wanted by all {comparison.kits.length}. These roles overlap less than
              their titles suggest — the rows below are still ordered by how many want each thing.
            </p>
          )}

          <Table comparison={comparison} onOpenKit={onOpenKit} />

          {pending > 0 ? (
            <p className="text-ink/40 text-xs">
              {pending} more still loading — the table fills in as they arrive.
            </p>
          ) : null}

          <p className="text-ink/40 text-xs leading-relaxed">
            Requirements are grouped by shared wording, not by meaning, and the grouping is done
            in code rather than by the model. Two postings that say the same thing in different
            words appear as two rows — the comparison would rather show you one row too many than
            claim an overlap neither posting made.
          </p>
        </>
      )}
    </div>
  );
}

function Table({
  comparison,
  onOpenKit,
}: {
  comparison: ReturnType<typeof buildComparison>;
  onOpenKit: (kitId: string) => void;
}) {
  return (
    <div className="-mx-4 overflow-x-auto px-4 md:mx-0 md:px-0">
      <table className="w-full min-w-[34rem] border-separate border-spacing-y-1 text-left">
        <thead>
          <tr>
            <th scope="col" className="w-[40%] px-3 pb-1">
              <Eyebrow className="text-ink/40">Requirement</Eyebrow>
            </th>
            {comparison.kits.map((kit) => (
              <th key={kit.kitId} scope="col" className="px-2 pb-1">
                <button
                  type="button"
                  onClick={() => onOpenKit(kit.kitId)}
                  title={kit.title}
                  className="font-head text-steel-700 hover:text-steel-900 max-w-[8rem] truncate text-xs tracking-widest uppercase underline-offset-4 hover:underline"
                >
                  {kit.company}
                </button>
              </th>
            ))}
            <th scope="col" className="px-2 pb-1 text-right">
              <Eyebrow className="text-ink/40">Wanted</Eyebrow>
            </th>
          </tr>
        </thead>
        <tbody>
          {comparison.rows.map((row) => (
            <Row key={`${row.kind}:${row.label}`} row={row} kits={comparison.kits} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Row({
  row,
  kits,
}: {
  row: ComparisonRow;
  kits: ReturnType<typeof buildComparison>["kits"];
}) {
  const everyone = row.wanted === kits.length && kits.length > 1;

  return (
    <tr className={everyone ? "bg-steel-100" : "bg-tint-soft"}>
      <td className="rounded-l-[11px] px-3 py-2.5 align-middle">
        <span className="block text-[13.5px] font-semibold">{row.label}</span>
        <span className="text-ink/45 block text-xs">{KIND_LABEL[row.kind] ?? row.kind}</span>
      </td>

      {kits.map((kit) => {
        const priority = row.byKit[kit.kitId];
        return (
          <td key={kit.kitId} className="px-2 py-2.5 align-middle">
            {priority === undefined ? (
              // An em dash, not a blank: "this posting did not ask for it" is a finding, and a
              // blank cell reads as missing data.
              <span aria-label="not asked for" className="text-ink/25 text-sm">
                —
              </span>
            ) : (
              <span
                className={`font-head text-[11.5px] font-semibold tracking-widest uppercase ${
                  priority === "must" ? "text-steel-700" : "text-ink/40"
                }`}
              >
                {priority === "must" ? "Must" : "Nice"}
              </span>
            )}
          </td>
        );
      })}

      <td className="rounded-r-[11px] px-2 py-2.5 text-right align-middle">
        <span className="font-head text-[13px] tabular-nums">
          {row.wanted}
          <span className="text-ink/35">/{kits.length}</span>
        </span>
      </td>
    </tr>
  );
}

/** Requirement labels are written as fragments, so the joined list needs a capital to start. */
function sentence(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** "a, b and c" — spoken, not comma-separated. */
function joinWords(items: string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}
