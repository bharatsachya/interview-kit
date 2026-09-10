import { jaccard } from "@trao/coverage";
import type { InternalKit, Requirement, RequirementKind, RequirementPriority } from "@trao/kit";

/**
 * Comparing the scorecards of several kits.
 *
 * The interesting question when you are interviewing at four places is not what any one of them
 * wants — it is what all four want. That is the thing worth spending a week on, and it is
 * invisible while the kits are four separate documents.
 *
 * Grouping is deterministic token overlap, reusing the same comparison the coverage gates run
 * on. No model call: this is a view over data you already have, and spending free-tier quota to
 * render a table would be indefensible. It is also honest about what it can do — see below.
 */

/** Shared vocabulary needed before two requirements are called the same requirement. */
const SAME_REQUIREMENT = 0.4;

export interface ComparedKit {
  kitId: string;
  company: string;
  title: string;
}

export interface ComparisonRow {
  /** The clearest phrasing in the group — the shortest, which is the least padded. */
  label: string;
  kind: RequirementKind;
  /** Priority per kit id. Absent means that posting never asked for this. */
  byKit: Readonly<Record<string, RequirementPriority | undefined>>;
  /** How many kits ask for it at all, and how many call it a must. */
  wanted: number;
  musts: number;
}

export interface Comparison {
  kits: ComparedKit[];
  rows: ComparisonRow[];
  /** Wanted by every kit compared. The week's highest-leverage study, named. */
  shared: ComparisonRow[];
}

interface Group {
  members: { requirement: Requirement; kitId: string }[];
  kind: RequirementKind;
}

/**
 * What this cannot do, stated rather than hidden: it matches words, not meaning. "Go or Java"
 * and "Golang in production" share no content tokens and will appear as two rows. Under-grouping
 * is the deliberate direction to fail in — showing two rows when there should be one is a
 * reader's mild annoyance, while merging two different requirements would put a claim on the
 * screen that no posting made.
 */
export function buildComparison(entries: readonly { kitId: string; kit: InternalKit }[]): Comparison {
  const kits: ComparedKit[] = entries.map(({ kitId, kit }) => ({
    kitId,
    company: kit.role.company,
    title: kit.role.title,
  }));

  const groups: Group[] = [];

  for (const { kitId, kit } of entries) {
    for (const requirement of kit.requirements) {
      // Never across kind. Two requirements that happen to share vocabulary but are one
      // technical and one behavioural are not the same requirement, and the same rule the
      // coverage clustering follows applies here for the same reason.
      const home = groups.find(
        (group) =>
          group.kind === requirement.kind &&
          // Against every member, not just the first: a group seeded by a terse phrasing should
          // still catch a wordy one that matches a later member.
          group.members.some((member) => jaccard(member.requirement.text, requirement.text) >= SAME_REQUIREMENT) &&
          // One requirement per kit per row. A posting that says "Postgres" twice must not make
          // its own column read as two votes.
          !group.members.some((member) => member.kitId === kitId),
      );

      if (home) home.members.push({ requirement, kitId });
      else groups.push({ kind: requirement.kind, members: [{ requirement, kitId }] });
    }
  }

  const rows: ComparisonRow[] = groups.map((group) => {
    const byKit: Record<string, RequirementPriority> = {};
    for (const member of group.members) byKit[member.kitId] = member.requirement.priority;

    const label = group.members
      .map((member) => member.requirement.text)
      .sort((a, b) => a.length - b.length)[0] as string;

    return {
      label,
      kind: group.kind,
      byKit,
      wanted: group.members.length,
      musts: group.members.filter((member) => member.requirement.priority === "must").length,
    };
  });

  // Most-wanted first, then most-insisted-upon, then alphabetical so the order is stable across
  // renders rather than depending on which kit happened to load first.
  rows.sort(
    (a, b) => b.wanted - a.wanted || b.musts - a.musts || a.label.localeCompare(b.label),
  );

  return {
    kits,
    rows,
    shared: kits.length > 1 ? rows.filter((row) => row.wanted === kits.length) : [],
  };
}
