"use client";

import { UserButton, useClerk, useUser } from "@clerk/nextjs";
import type { KitSummary } from "@/lib/api/types";
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
  kits,
  loading,
  error,
  activeKitId,
  onSelect,
  onNew,
  onRetry,
}: {
  comparing: boolean;
  onCompare: () => void;
  kits: KitSummary[];
  loading: boolean;
  error: string | null;
  activeKitId: string | null;
  onSelect: (kitId: string) => void;
  onNew: () => void;
  onRetry: () => void;
}) {
  const { user } = useUser();
  const { signOut } = useClerk();

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
        {kits.length > 1 ? (
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
            Compare {kits.length} kits
          </button>
        ) : null}

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
                    className={`flex w-full flex-col rounded-xl px-3 py-2.5 text-left transition-colors ${
                      active ? "bg-steel-100" : "hover:bg-tint"
                    }`}
                  >
                    <span className="flex items-center gap-2">
                      {active ? <OpenDot /> : null}
                      <span
                        className={`font-head truncate text-[15px] font-semibold ${active ? "text-steel-800" : ""}`}
                      >
                        {kit.company}
                      </span>
                    </span>
                    <span className="text-ink/55 truncate text-xs">{kit.title}</span>
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
            {kits.length === 0
              ? "No kits yet"
              : `${kits.length} ${kits.length === 1 ? "kit" : "kits"}`}
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
