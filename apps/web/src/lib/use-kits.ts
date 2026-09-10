"use client";

import { useEffect, useState } from "react";
import type { InternalKit } from "@trao/kit";
import { api } from "@/lib/api/client";

export interface LoadedKit {
  kitId: string;
  kit: InternalKit;
}

export interface KitsState {
  loaded: LoadedKit[];
  /** Ids still in flight. The comparison renders from what has arrived rather than waiting. */
  pending: number;
  failed: string[];
}

/**
 * Several kits at once, for the comparison.
 *
 * Fetched in parallel and rendered as they land, rather than behind one all-or-nothing spinner:
 * comparing four kits should not be held up by the slowest, and a comparison of three of them is
 * a useful thing to look at while the fourth arrives.
 *
 * A kit that fails is listed rather than dropped. A column quietly missing from a comparison is
 * worse than a named one that could not be loaded — the reader would draw conclusions from a
 * table with a hole in it and never know.
 */
export function useKits(kitIds: readonly string[]): KitsState {
  const [byId, setById] = useState<Record<string, InternalKit>>({});
  const [failed, setFailed] = useState<string[]>([]);

  // The ids as one primitive, so the effect re-runs when the set changes but not when a new
  // array with the same contents arrives on a re-render.
  const key = kitIds.join(",");

  useEffect(() => {
    const ids = key === "" ? [] : key.split(",");
    if (ids.length === 0) return;
    const controller = new AbortController();

    for (const id of ids) {
      api
        .getKit(id, controller.signal)
        .then((view) => {
          if (controller.signal.aborted) return;
          setById((previous) => ({ ...previous, [id]: view.kit }));
        })
        .catch(() => {
          if (controller.signal.aborted) return;
          setFailed((previous) => (previous.includes(id) ? previous : [...previous, id]));
        });
    }

    return () => controller.abort();
  }, [key]);

  const ids = key === "" ? [] : key.split(",");
  const loaded = ids
    .filter((id) => byId[id] !== undefined)
    .map((id) => ({ kitId: id, kit: byId[id] as InternalKit }));

  return {
    loaded,
    pending: ids.length - loaded.length - failed.filter((id) => ids.includes(id)).length,
    failed: failed.filter((id) => ids.includes(id)),
  };
}
