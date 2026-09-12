"use client";

import { UserButton, useClerk, useUser } from "@clerk/nextjs";
import { lineageLabel } from "@trao/kit";
import { kitCount, runLabel, type HistoryEntry } from "@/lib/history";
import { KIT_OUTPUTS } from "@/lib/kit-outputs";
import { Button } from "@/components/industry/button";
import { EmptyState, Skeleton } from "@/components/industry/states";
import { Eyebrow, OpenDot } from "@/components/industry/text";

/**
 * The left rail: what this is, how to start another, and everything you have built.
 *
 * Newest first, because the last thing you built is the thing you are working on. On a laptop
 * this is a column that collapses to nothing; on a phone it is a drawer over the left edge,
 * closed by default — the same list, placed where each viewport has room for it.
 *
 * The user chip is pinned to the foot rather than sitting in the centre column's header. Who
 * you are signed in as is an attribute of the application, not of the kit you happen to have
 * open, and the header has a run line to say instead.
 */
export function HistorySidebar({
  comparing,
  onCompare,
  entries,
  loading,
  error,
  activeKitId,
  activeJobId,
  onSelect,
  onOpenRun,
  onNew,
  onRetry,
}: {
  comparing: boolean;
  onCompare: () => void;
  entries: HistoryEntry[];
  loading: boolean;
  error: string | null;
  activeKitId: string | null;
  activeJobId: string | null;
  onSelect: (kitId: string) => void;
  onOpenRun: (jobId: string) => void;
  onNew: () => void;
  onRetry: () => void;
}) {
  const { user } = useUser();
  const { signOut } = useClerk();
  // Only finished kits can be compared, and only they are counted below — a failed run in the
  // list must not make "Compare 2 kits" appear when there is one kit to compare.
  const kits = kitCount(entries);

  return (
    <div className="bg-tint-soft flex h-full w-full flex-col gap-5 overflow-hidden p-4">
      <div className="flex items-center gap-2.5 px-1">
        <span
          aria-hidden
          className="bg-steel-500 font-head grid size-5 shrink-0 place-items-center rounded-[5px] text-xs font-bold text-white"
        >
          P
        </span>
        <span className="font-head text-base font-bold tracking-[0.16em] uppercase">Prep Kit</span>
      </div>

      <Button variant="outline" onClick={onNew} className="w-full justify-between">
        New kit
        <span aria-hidden className="text-steel-500 text-base leading-none">
          +
        </span>
      </Button>

      <div className="flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto">
        <Eyebrow className="text-ink/40 px-1.5 pb-1">
          <h2 className="inline">History</h2>
        </Eyebrow>

        {/* Only with something to compare. One kit has no comparison, and an always-visible
            control that does nothing five times out of six is worse than one that arrives when
            it becomes true. */}
        {kits > 1 ? (
          <button
            type="button"
            onClick={onCompare}
            aria-current={comparing ? "true" : undefined}
            className={`mb-0.5 flex w-full items-center gap-2 rounded-xl px-3 py-2 text-left text-[13px] font-semibold transition-colors ${
              comparing ? "bg-steel-100 text-steel-800" : "text-steel-700 hover:bg-tint"
            }`}
          >
            <svg aria-hidden width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
              <path d="M3 12V6M8 12V3M13 12V8" />
            </svg>
            Compare {kits} kits
          </button>
        ) : null}

        {loading && entries.length === 0 ? (
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
        ) : entries.length === 0 ? (
          <EmptyState>Nothing built yet. Paste a job description to start one.</EmptyState>
        ) : (
          <ul className="flex list-none flex-col gap-1">
            {entries.map((entry) => {
              // A run row and a kit row are the same row with different things known about it.
              // A failed run has no company and no role — the job's label, taken from the
              // posting's first line, is all there is, and inventing more would be a lie about
              // work that did not finish.
              if (entry.kind === "run") {
                const { job } = entry;
                const active = job.id === activeJobId;
                const failed = job.status === "failed";
                return (
                  <li key={job.id}>
                    <button
                      type="button"
                      onClick={() => onOpenRun(job.id)}
                      aria-current={active ? "true" : undefined}
                      className={`flex w-full flex-col rounded-xl px-3 py-2.5 text-left transition-colors ${
                        active ? "bg-steel-100" : "hover:bg-tint"
                      }`}
                    >
                      <span className="flex items-center gap-2">
                        {active ? <OpenDot /> : null}
                        <span
                          className={`font-head truncate text-[15px] font-semibold ${
                            active ? "text-steel-800" : failed ? "text-ink/70" : ""
                          }`}
                        >
                          {job.label === "" ? "Untitled run" : job.label}
                        </span>
                      </span>
                      {/* The reason, not just the state. Reaching a failure from the rail and
                          being told only "Failed" would mean opening it to learn anything. */}
                      <span className="text-ink/55 truncate text-xs">
                        {failed ? (job.error?.message ?? "No kit could be produced") : "In progress"}
                      </span>
                      <span
                        className={`font-head mt-0.5 flex items-center gap-1.5 text-xs tracking-wider uppercase ${
                          failed ? "text-alarm" : active ? "text-steel-500" : "text-ink/40"
                        }`}
                      >
                        {!failed ? (
                          <span
                            aria-hidden
                            className="bg-steel-400 inline-block size-1.5 shrink-0 animate-pulse rounded-full"
                          />
                        ) : null}
                        {runLabel(job)}
                      </span>
                    </button>
                  </li>
                );
              }

              const { kit } = entry;
              const active = kit.id === activeKitId;
              return (
                <li key={kit.id}>
                  <button
                    type="button"
                    onClick={() => onSelect(kit.id)}
                    aria-current={active ? "true" : undefined}
                    className={`flex w-full flex-col rounded-xl px-3 py-2.5 text-left transition-colors ${
                      active ? "bg-steel-100" : "hover:bg-tint"
                    }`}
                  >
                    <span className="flex items-center gap-2">
                      {active ? <OpenDot /> : null}
                      <span
                        className={`font-head min-w-0 flex-1 truncate text-[15px] font-semibold ${active ? "text-steel-800" : ""}`}
                      >
                        {kit.company}
                      </span>
                      {/* A rewrite forks, so one company can hold several rows that are alike in
                          every field this row shows. The number is what tells them apart at a
                          glance; the line under it says what the rewrite actually did. */}
                      {kit.revision > 1 ? (
                        <span
                          className={`font-head rounded-pill shrink-0 px-1.5 py-0.5 text-[10.5px] tracking-wider tabular-nums ${
                            active ? "bg-steel-200 text-steel-700" : "bg-tint text-ink/45"
                          }`}
                        >
                          v{kit.revision}
                        </span>
                      ) : null}
                    </span>
                    <span className="text-ink/55 truncate text-xs">
                      {kit.forkedFrom ? lineageLabel(kit.forkedFrom) : kit.title}
                    </span>
                    <span
                      className={`font-head mt-0.5 text-xs tracking-wider uppercase tabular-nums ${
                        active ? "text-steel-500" : "text-ink/40"
                      }`}
                    >
                      {kit.days === 1 ? "1 day" : `${kit.days} days`} · {KIT_OUTPUTS.length} outputs
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <div className="bg-tint hover:bg-tint-strong flex shrink-0 items-center gap-2.5 rounded-xl p-2.5 transition-colors">
        {/* Clerk sizes its own avatar, and its default is taller than this row. Pinned to the
            rail's scale here rather than left to whatever the vendor ships. */}
        <UserButton
          appearance={{
            elements: {
              userButtonAvatarBox: "size-7",
              userButtonTrigger: "rounded-lg focus:shadow-none",
            },
          }}
        />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-[13px] leading-tight font-semibold">
            {user?.fullName ?? user?.primaryEmailAddress?.emailAddress ?? "Signed in"}
          </span>
          <span className="text-ink/55 truncate text-[11.5px] leading-tight">
            {kits === 0 ? "No kits yet" : `${kits} ${kits === 1 ? "kit" : "kits"}`}
          </span>
        </span>

        {/* Signing out lived only inside Clerk's own avatar menu, which is a portal the rail
            gives no hint of — so from the interface there was no way out. It is a control of its
            own now: the avatar still opens the profile, and this ends the session. */}
        <button
          type="button"
          onClick={() => void signOut({ redirectUrl: "/sign-in" })}
          aria-label="Sign out"
          title="Sign out"
          className="text-ink/40 hover:bg-surface hover:text-ink grid size-7 shrink-0 place-items-center rounded-lg transition-colors"
        >
          <svg
            aria-hidden
            width="15"
            height="15"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.9"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
            <polyline points="16 17 21 12 16 7" />
            <line x1="21" y1="12" x2="9" y2="12" />
          </svg>
        </button>
      </div>
    </div>
  );
}
