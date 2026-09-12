"use client";

import { UserButton, useClerk, useUser } from "@clerk/nextjs";
import { useState } from "react";
import { kitCount, kitRowLabel, sessionLabel } from "@/lib/history";
import type { SessionSummary } from "@/lib/api/types";
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
 *
 * **One row per conversation, not per kit.** A rewrite forks, so a single piece of work can hold
 * four kits that are identical in every field a row shows — "Vaultline — Senior Backend" four
 * times over is a list you cannot use. The revisions nest under the conversation instead, and
 * the one you have open expands on its own so you are never hunting for where you are.
 */
export function HistorySidebar({
  comparing,
  onCompare,
  sessions,
  loading,
  error,
  activeSessionId,
  activeKitId,
  onOpenSession,
  onOpenKit,
  onNew,
  onRetry,
}: {
  comparing: boolean;
  onCompare: () => void;
  sessions: SessionSummary[];
  loading: boolean;
  error: string | null;
  /** The conversation on screen. Its row is expanded whether or not the user expanded it. */
  activeSessionId: string | null;
  /** Which of that conversation's kits is in the panel, so the right nested row is marked. */
  activeKitId: string | null;
  onOpenSession: (sessionId: string) => void;
  onOpenKit: (sessionId: string, kitId: string) => void;
  onNew: () => void;
  onRetry: () => void;
}) {
  const { user } = useUser();
  const { signOut } = useClerk();
  // Only finished kits can be compared, and only they are counted below — a conversation whose
  // only run failed must not make "Compare 2 kits" appear when there is one kit to compare.
  const kits = kitCount(sessions);

  /**
   * Conversations the user has opened by hand.
   *
   * Only those. The one you are *in* is expanded at render by `active ||` below rather than by
   * being written here, which is both simpler and the behaviour that is wanted: a conversation
   * that gains a second kit while you are looking at it — which is what a rewrite landing does —
   * opens itself, and collapsing the row you are standing in is not an offer worth making.
   * Clicking the chevron on a row you are *not* in stays a way of looking without navigating.
   */
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());

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

        {loading && sessions.length === 0 ? (
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
        ) : sessions.length === 0 ? (
          <EmptyState>Nothing built yet. Paste a job description to start one.</EmptyState>
        ) : (
          <ul className="flex list-none flex-col gap-1">
            {sessions.map((session) => {
              const active = session.id === activeSessionId;
              const open = active || expanded.has(session.id);
              const failed = !session.running && session.kits.length === 0 && session.status === "failed";
              // Nesting is only worth its chevron once there is more than one thing under it. A
              // conversation with a single kit is a single row, which is what most of them are.
              const nests = session.kits.length > 1;

              return (
                <li key={session.id}>
                  <div
                    className={`flex items-center gap-1 rounded-xl transition-colors ${
                      active ? "bg-steel-100" : "hover:bg-tint"
                    }`}
                  >
                    <button
                      type="button"
                      onClick={() => onOpenSession(session.id)}
                      aria-current={active ? "true" : undefined}
                      className="flex min-w-0 flex-1 flex-col px-3 py-2.5 text-left"
                    >
                      <span className="flex items-center gap-2">
                        {active ? <OpenDot /> : null}
                        <span
                          className={`font-head min-w-0 flex-1 truncate text-[15px] font-semibold ${
                            active ? "text-steel-800" : ""
                          }`}
                        >
                          {session.title}
                        </span>
                      </span>
                      <span
                        className={`font-head mt-0.5 flex items-center gap-1.5 text-xs tracking-wider uppercase tabular-nums ${
                          failed ? "text-alarm" : active ? "text-steel-500" : "text-ink/40"
                        }`}
                      >
                        {session.running ? (
                          <span
                            aria-hidden
                            className="bg-steel-400 inline-block size-1.5 shrink-0 animate-pulse rounded-full"
                          />
                        ) : null}
                        {sessionLabel(session)}
                      </span>
                    </button>

                    {nests ? (
                      <button
                        type="button"
                        onClick={() =>
                          setExpanded((previous) => {
                            const next = new Set(previous);
                            if (next.has(session.id)) next.delete(session.id);
                            else next.add(session.id);
                            return next;
                          })
                        }
                        aria-expanded={open}
                        aria-label={`${open ? "Hide" : "Show"} the ${session.kits.length} kits in ${session.title}`}
                        className="text-ink/35 hover:text-ink mr-1.5 grid size-6 shrink-0 place-items-center rounded-lg transition-colors"
                      >
                        <svg
                          aria-hidden
                          width="11"
                          height="11"
                          viewBox="0 0 16 16"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          className={`transition-transform ${open ? "rotate-90" : ""}`}
                        >
                          <path d="M6 3l5 5-5 5" />
                        </svg>
                      </button>
                    ) : null}
                  </div>

                  {/* The revisions. Newest first, so the top one is what opening the
                      conversation shows — and each says what its rewrite did rather than
                      repeating the role title it shares with every other revision. */}
                  {nests && open ? (
                    <ul className="mt-0.5 ml-4 flex list-none flex-col gap-0.5 border-l border-[color:var(--color-tint-line)] pl-2">
                      {session.kits.map((kit) => {
                        const here = kit.id === activeKitId;
                        return (
                          <li key={kit.id}>
                            <button
                              type="button"
                              onClick={() => onOpenKit(session.id, kit.id)}
                              aria-current={here ? "true" : undefined}
                              className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left transition-colors ${
                                here ? "bg-steel-100" : "hover:bg-tint"
                              }`}
                            >
                              <span
                                className={`font-head shrink-0 text-[10.5px] tracking-wider tabular-nums ${
                                  here ? "text-steel-700" : "text-ink/40"
                                }`}
                              >
                                v{kit.revision}
                              </span>
                              <span
                                className={`min-w-0 flex-1 truncate text-xs ${here ? "text-steel-800" : "text-ink/60"}`}
                              >
                                {kitRowLabel(kit)}
                              </span>
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                  ) : null}
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
