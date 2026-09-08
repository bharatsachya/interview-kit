"use client";

import type { KitSummary } from "@/lib/api/types";
import { Button } from "@/components/industry/button";
import { EmptyState, Skeleton } from "@/components/industry/states";
import { Eyebrow } from "@/components/industry/text";

/**
 * Kit history. Newest first, because the last thing you built is the thing you are working on.
 *
 * On a laptop this is a column that collapses to nothing. On a phone it is a drawer over the
 * left edge, closed by default — the same list, placed where each viewport has room for it.
 */
export function HistorySidebar({
  kits,
  loading,
  error,
  activeKitId,
  onSelect,
  onNew,
  onRetry,
}: {
  kits: KitSummary[];
  loading: boolean;
  error: string | null;
  activeKitId: string | null;
  onSelect: (kitId: string) => void;
  onNew: () => void;
  onRetry: () => void;
}) {
  return (
    <div className="flex h-full w-full flex-col gap-6 overflow-y-auto p-4">
      <Button variant="secondary" onClick={onNew} className="w-full">
        New kit
      </Button>

      <div className="flex flex-col gap-3">
        <Eyebrow className="opacity-55">
          <h2 className="inline">History</h2>
        </Eyebrow>

        {loading && kits.length === 0 ? (
          <div className="flex flex-col gap-3">
            <Skeleton lines={2} />
            <Skeleton lines={2} />
          </div>
        ) : error ? (
          <EmptyState
            actions={
              <Button variant="ghost" onClick={onRetry}>
                Try again
              </Button>
            }
          >
            {error}
          </EmptyState>
        ) : kits.length === 0 ? (
          <EmptyState>Nothing built yet. Paste a job description to start one.</EmptyState>
        ) : (
          <ul className="flex list-none flex-col gap-1">
            {kits.map((kit) => {
              const active = kit.id === activeKitId;
              return (
                <li key={kit.id}>
                  <button
                    type="button"
                    onClick={() => onSelect(kit.id)}
                    aria-current={active ? "true" : undefined}
                    className={`flex min-h-11 w-full flex-col gap-1 px-3 py-2 text-left ${
                      active ? "bg-mint" : "hover:bg-ink/5"
                    }`}
                  >
                    <span className="font-head truncate text-sm">{kit.company}</span>
                    <span className="truncate text-xs opacity-70">{kit.title}</span>
                    <span className="text-xs tabular-nums opacity-45">
                      {kit.days === 1 ? "1 day" : `${kit.days} days`}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
