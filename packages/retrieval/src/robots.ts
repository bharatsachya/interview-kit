/**
 * robots.txt, enough of it.
 *
 * Group selection, `Disallow`, `Allow`, and longest-match-wins. Not `Crawl-delay` (we throttle
 * to a fixed rate regardless) and not wildcards beyond a trailing `*`, because a company site's
 * robots file is rarely subtle and guessing wrong in the permissive direction is the failure
 * that matters.
 *
 * A file we cannot fetch or cannot parse means **allow**. That is the convention, and treating
 * a 404 as "disallow everything" would silently produce an empty brief for most of the web.
 */

export interface RobotsRules {
  /** Longest-match-wins pairs, already narrowed to the group that applies to us. */
  rules: { path: string; allow: boolean }[];
}

export const ALLOW_ALL: RobotsRules = { rules: [] };

export function parseRobots(text: string, userAgent: string): RobotsRules {
  const ua = userAgent.toLowerCase();
  const groups: { agents: string[]; rules: { path: string; allow: boolean }[] }[] = [];
  let current: { agents: string[]; rules: { path: string; allow: boolean }[] } | null = null;
  let lastLineWasAgent = false;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.split("#")[0]?.trim() ?? "";
    if (line.length === 0) continue;

    const separator = line.indexOf(":");
    if (separator === -1) continue;
    const field = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();

    if (field === "user-agent") {
      // Consecutive User-agent lines share one group of rules.
      if (current === null || !lastLineWasAgent) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastLineWasAgent = true;
      continue;
    }

    lastLineWasAgent = false;
    if (current === null) continue;
    if (field === "disallow") current.rules.push({ path: value, allow: false });
    if (field === "allow") current.rules.push({ path: value, allow: true });
  }

  // A group naming us specifically wins over the wildcard group entirely — that is how the
  // standard works, and merging the two would apply rules meant for someone else.
  const specific = groups.find((group) => group.agents.some((agent) => agent !== "*" && ua.includes(agent)));
  const wildcard = groups.find((group) => group.agents.includes("*"));
  const chosen = specific ?? wildcard;

  return { rules: chosen?.rules ?? [] };
}

export function isAllowed(rules: RobotsRules, pathname: string): boolean {
  let best: { length: number; allow: boolean } | null = null;

  for (const rule of rules.rules) {
    // "Disallow:" with an empty value means allow everything, and matches nothing.
    if (rule.path === "") continue;
    if (!matches(rule.path, pathname)) continue;
    if (best === null || rule.path.length > best.length) {
      best = { length: rule.path.length, allow: rule.allow };
    } else if (rule.path.length === best.length && rule.allow) {
      // Equal-length conflict resolves to allow, per the convention.
      best = { length: rule.path.length, allow: true };
    }
  }

  return best?.allow ?? true;
}

function matches(rulePath: string, pathname: string): boolean {
  if (rulePath.endsWith("*")) return pathname.startsWith(rulePath.slice(0, -1));
  return pathname.startsWith(rulePath);
}
