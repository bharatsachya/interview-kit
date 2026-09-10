"use client";

import { useMemo, useState } from "react";
import { QUESTION_CATEGORIES, minutesForQuestions, type InternalKit, type QuestionCategory } from "@trao/kit";
import { CATEGORY_META } from "@/lib/categories";
import type { KitOutputId } from "@/lib/kit-outputs";
import { Button } from "@/components/industry/button";
import { Frame } from "@/components/industry/frame";
import { EmptyState } from "@/components/industry/states";
import { Kicker } from "@/components/industry/text";
import { CoverageBar } from "@/components/kit/coverage-bar";
import { QuestionCard } from "@/components/kit/question-card";
import { ScheduleList } from "@/components/kit/schedule-list";

/**
 * How sure you were about a card, the last time you drew it.
 *
 * Three states rather than a score, because a self-rating is not precise enough to deserve a
 * number, and "unseen" has to be distinguishable from "wrong" — a track you have not opened is
 * not a weak track, and averaging the two together is how a report starts lying.
 */
export type Confidence = "known" | "shaky" | "unseen";
export type ConfidenceMap = Readonly<Record<string, Confidence>>;

export function KitOutputBody({
  output,
  kit,
  confidence,
  onRate,
  track,
  onTrack,
  onOpenOutput,
}: {
  output: KitOutputId;
  kit: InternalKit;
  confidence: ConfidenceMap;
  onRate: (flashcardId: string, value: Confidence) => void;
  track: QuestionCategory | null;
  onTrack: (track: QuestionCategory | null) => void;
  onOpenOutput: (id: KitOutputId) => void;
}) {
  return (
    <div
      role="tabpanel"
      id={`kit-panel-${output}`}
      aria-labelledby={`kit-tab-${output}`}
      tabIndex={0}
      className="flex flex-col gap-4 px-4 pt-1 pb-6 md:px-5"
    >
      {output === "brief" ? <BriefBody kit={kit} /> : null}
      {output === "role" ? <RoleBody kit={kit} /> : null}
      {output === "questions" ? <QuestionsBody kit={kit} track={track} onTrack={onTrack} /> : null}
      {output === "flashcards" ? (
        <FlashcardsBody kit={kit} confidence={confidence} onRate={onRate} />
      ) : null}
      {output === "schedule" ? <ScheduleList schedule={kit.schedule} questions={kit.questions} /> : null}
      {output === "practice" ? (
        <PracticeBody
          kit={kit}
          confidence={confidence}
          onStartSet={(category) => {
            onTrack(category);
            onOpenOutput("questions");
          }}
        />
      ) : null}
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════ brief ══ */

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-1.5">
      <Kicker>{label}</Kicker>
      {children}
    </section>
  );
}

function BriefBody({ kit }: { kit: InternalKit }) {
  const brief = kit.companyBrief;
  const nothingFound =
    brief.whatTheyDo === "" && brief.hiringProcess === "" && brief.sources.length === 0;

  return (
    <>
      {nothingFound ? (
        // The whole point of this state: say plainly that nothing was found, and that the kit
        // was built from the description alone. A blank section would read as a bug.
        <EmptyState title="Nothing could be retrieved">
          <p>{brief.summary}</p>
          <p className="mt-2">
            Everything else in this kit comes from the job description, which is enough for the
            questions but means there is nothing here about how they interview.
          </p>
        </EmptyState>
      ) : (
        <>
          <p className="text-[15px] leading-relaxed">{brief.summary}</p>

          <Section label="What they do">
            <p className="text-ink/70 text-[13.5px] leading-relaxed">{brief.whatTheyDo}</p>
          </Section>

          <Section label="How they interview">
            {brief.hiringProcess ? (
              <p className="text-ink/70 text-[13.5px] leading-relaxed">{brief.hiringProcess}</p>
            ) : (
              <p className="text-ink/45 text-[13.5px] leading-relaxed">
                No hiring page turned up on their site, so this is blank rather than guessed.
              </p>
            )}
          </Section>

          {/* What could not be found is printed, not dropped: a brief that silently omits a
              section is indistinguishable from one that had nothing to say. */}
          {brief.gaps.length > 0 ? (
            <Section label="What we could not find">
              <ul className="flex list-none flex-col gap-1.5">
                {brief.gaps.map((gap) => (
                  <li key={gap} className="text-ink/70 text-[13px] leading-relaxed">
                    {gap}
                  </li>
                ))}
              </ul>
            </Section>
          ) : null}

          <Section label="Signals">
            <div className="grid grid-cols-2 gap-2">
              <SignalTile
                label="Sources"
                value={String(brief.sources.length)}
                detail={brief.sources.length === 1 ? "consulted" : "consulted"}
              />
              <SignalTile
                label="Read in full"
                value={String(brief.pagesUsed.length)}
                detail="used in the prompt"
              />
              <SignalTile
                label="Hiring page"
                value={brief.hiringProcess ? "Found" : "None"}
                detail={brief.hiringProcess ? "on their site" : "nothing published"}
              />
              <SignalTile
                label="Gaps"
                value={String(brief.gaps.length)}
                detail={brief.gaps.length === 0 ? "nothing missing" : "recorded, not hidden"}
              />
            </div>
          </Section>
        </>
      )}

      {brief.sources.length > 0 ? (
        <Section label="Sources">
          <ul className="flex list-none flex-col gap-1.5">
            {brief.sources.map((source) => (
              <li key={source}>
                <a
                  href={source}
                  className="bg-tint-soft hover:bg-steel-100 text-steel-700 hover:text-steel-800 rounded-pill inline-flex h-7 max-w-full items-center gap-1.5 px-3 text-xs font-medium transition-colors"
                >
                  <LinkIcon />
                  <span className="truncate">{source.replace(/^https?:\/\//, "")}</span>
                </a>
                {!brief.pagesUsed.includes(source) ? (
                  <span className="text-ink/40 ml-2 text-[11px]">found, not used</span>
                ) : null}
              </li>
            ))}
          </ul>
        </Section>
      ) : null}
    </>
  );
}

function SignalTile({ label, value, detail }: { label: string; value: string; detail: string }) {
  return (
    <Frame tone="tile" className="px-3 py-2.5">
      <p className="font-head text-ink/40 text-[11.5px] tracking-wider uppercase">{label}</p>
      <p className="font-head mt-0.5 text-lg font-semibold tabular-nums">{value}</p>
      <p className="text-ink/55 text-xs">{detail}</p>
    </Frame>
  );
}

function LinkIcon() {
  return (
    <svg aria-hidden width="10" height="10" viewBox="0 0 12 12" fill="none" className="shrink-0 opacity-65">
      <path
        d="M4.6 7.4L7.4 4.6M5.2 2.6l.9-.9a2.4 2.4 0 013.4 3.4l-.9.9M6.8 9.4l-.9.9a2.4 2.4 0 01-3.4-3.4l.9-.9"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
      />
    </svg>
  );
}

/* ═══════════════════════════════════════════════════════════════ role ══ */

const KIND_LABEL: Readonly<Record<string, string>> = {
  technical: "Technical",
  behavioural: "Behavioural",
  domain: "Domain",
};

function RoleBody({ kit }: { kit: InternalKit }) {
  const uncovered = new Set(kit.coverage.uncoveredRequirementIds);
  const musts = kit.requirements.filter((requirement) => requirement.priority === "must");
  // A two-line description yields a handful of requirements. That is thin, not broken, and the
  // difference has to be said out loud or the kit reads as a failure.
  const thin = kit.requirements.length <= 4;

  return (
    <>
      <section className="flex flex-col gap-1.5">
        <h3 className="text-lg">{kit.role.title}</h3>
        <p className="font-head text-ink/40 text-[11.5px] tracking-wider uppercase">
          {kit.role.location || "Location not stated"}
        </p>
        <p className="text-ink/70 text-[13.5px] leading-relaxed">{kit.role.summary}</p>
      </section>

      {thin ? (
        <EmptyState title="A thin description">
          {kit.requirements.length}{" "}
          {kit.requirements.length === 1 ? "requirement" : "requirements"}, and {musts.length} of
          them must-have. That is all the posting gave us. The kit below is built on exactly that
          and nothing invented — add requirements by hand if you know more than the advert says.
        </EmptyState>
      ) : null}

      <CoverageBar
        requirements={kit.requirements}
        uncoveredRequirementIds={kit.coverage.uncoveredRequirementIds}
        passes={kit.coverage.passes}
      />

      {/* The scorecard. One row per requirement, and the third column is whether a question
          exists for it — the only per-requirement fact the pipeline actually records. There is
          no depth or seniority score in the data, so there is no column claiming one. */}
      <section className="flex flex-col gap-1">
        <div className="text-ink/40 font-head flex items-center gap-3 px-3 pb-1 text-[11px] tracking-widest uppercase">
          <span className="flex-1">Requirement</span>
          <span>Priority</span>
        </div>
        <ul className="flex list-none flex-col gap-1">
          {kit.requirements.map((requirement) => {
            const gap = uncovered.has(requirement.id);
            return (
              <li
                key={requirement.id}
                id={`requirement-${requirement.id}`}
                className="bg-tint-soft flex scroll-mt-4 items-center gap-3 rounded-[11px] px-3 py-2.5"
              >
                <span className="min-w-0 flex-1">
                  <span className="block text-[13.5px] font-semibold">{requirement.text}</span>
                  <span className="text-ink/55 block truncate text-xs">
                    {KIND_LABEL[requirement.kind] ?? requirement.kind}
                    {" · "}
                    {gap ? (
                      <span className="text-alarm font-medium">no question yet</span>
                    ) : (
                      "covered"
                    )}
                  </span>
                </span>
                {/* A label, not a control: it is not clickable, so it does not get a fill. */}
                <span
                  className={`font-head w-10 shrink-0 text-right text-[11.5px] font-semibold tracking-widest uppercase ${
                    requirement.priority === "must" ? "text-steel-600" : "text-ink/40"
                  }`}
                >
                  {requirement.priority === "must" ? "Must" : "Nice"}
                </span>
              </li>
            );
          })}
        </ul>
      </section>
    </>
  );
}

/* ══════════════════════════════════════════════════════════ questions ══ */

const FIRST_SHOWN = 5;

function QuestionsBody({
  kit,
  track,
  onTrack,
}: {
  kit: InternalKit;
  track: QuestionCategory | null;
  onTrack: (track: QuestionCategory | null) => void;
}) {
  const [showAll, setShowAll] = useState(false);

  const shown = track
    ? kit.questions.filter((question) => question.category === track)
    : kit.questions;
  const visible = showAll ? shown : shown.slice(0, FIRST_SHOWN);

  return (
    <>
      {/* The four categories are a checklist, so all four are drawn even at zero — a track that
          produced nothing is a fact about the posting, and hiding it hides the fact. */}
      <div className="flex flex-wrap gap-1.5">
        <TrackChip active={track === null} onClick={() => onTrack(null)} count={kit.questions.length}>
          All
        </TrackChip>
        {QUESTION_CATEGORIES.map((category) => {
          const count = kit.questions.filter((question) => question.category === category).length;
          return (
            <TrackChip
              key={category}
              active={track === category}
              onClick={() => onTrack(track === category ? null : category)}
              count={count}
            >
              {CATEGORY_META[category].label}
            </TrackChip>
          );
        })}
      </div>

      {shown.length === 0 ? (
        <EmptyState title="Nothing in this track">
          The description didn&rsquo;t give us anything to ask about here, so we didn&rsquo;t
          invent any.
        </EmptyState>
      ) : (
        <>
          <ol className="flex list-none flex-col gap-2">
            {visible.map((question, index) => (
              <li key={question.id} className="flex gap-2.5">
                <span className="font-head text-steel-400 w-4 shrink-0 pt-4 text-xs tabular-nums">
                  {String(index + 1).padStart(2, "0")}
                </span>
                <span className="min-w-0 flex-1">
                  <QuestionCard question={question} />
                </span>
              </li>
            ))}
          </ol>

          {shown.length > FIRST_SHOWN ? (
            <button
              type="button"
              onClick={() => setShowAll((value) => !value)}
              className="bg-tint text-ink/70 hover:bg-steel-100 hover:text-steel-700 rounded-pill h-8 self-start px-3.5 text-xs font-semibold transition-colors"
            >
              {showAll ? "Show fewer" : `Show all ${shown.length}`}
            </button>
          ) : null}
        </>
      )}
    </>
  );
}

function TrackChip({
  children,
  count,
  active,
  onClick,
}: {
  children: React.ReactNode;
  count: number;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`rounded-pill inline-flex h-7 items-center gap-1.5 px-3 text-xs transition-colors ${
        active ? "bg-steel-100 text-steel-700 font-semibold" : "bg-tint text-ink/70 hover:bg-steel-100"
      }`}
    >
      {children}
      <span className="font-head text-steel-500 tabular-nums">{count}</span>
    </button>
  );
}

/* ═════════════════════════════════════════════════════════ flashcards ══ */

function FlashcardsBody({
  kit,
  confidence,
  onRate,
}: {
  kit: InternalKit;
  confidence: ConfidenceMap;
  onRate: (flashcardId: string, value: Confidence) => void;
}) {
  const [position, setPosition] = useState(0);
  const [revealed, setRevealed] = useState(false);

  const cards = kit.flashcards;
  if (cards.length === 0) {
    return (
      <EmptyState title="No cards yet">
        Flashcards are derived from the questions, so there will be cards once there are
        questions.
      </EmptyState>
    );
  }

  const index = Math.min(position, cards.length - 1);
  const card = cards[index];
  if (!card) return null;

  const counts = {
    known: cards.filter((entry) => confidence[entry.id] === "known").length,
    shaky: cards.filter((entry) => confidence[entry.id] === "shaky").length,
    unseen: cards.filter((entry) => (confidence[entry.id] ?? "unseen") === "unseen").length,
  };

  function rate(value: Confidence) {
    onRate(card!.id, value);
    setRevealed(false);
    setPosition((current) => (current + 1) % cards.length);
  }

  return (
    <>
      <div className="flex items-baseline gap-3">
        <span className="font-head text-ink/40 text-xs tracking-wider uppercase">
          Card <b className="text-ink text-sm">{index + 1}</b> / {cards.length}
        </span>
        <span className="text-steel-600 ml-auto text-xs font-medium">
          {card.requirementIds.length > 0 ? card.requirementIds.join(" · ") : "No requirement tag"}
        </span>
      </div>

      {/* One segment per card, coloured by how sure you were. The deck's shape is the progress
          bar — a percentage would hide which four are the shaky ones. */}
      <div className="flex h-[5px] gap-0.5">
        {cards.map((entry, entryIndex) => {
          const state = confidence[entry.id] ?? "unseen";
          return (
            <span
              key={entry.id}
              className={`flex-1 rounded-sm transition-all ${
                entryIndex === index
                  ? "bg-steel-800 scale-y-[2]"
                  : state === "known"
                    ? "bg-steel-500"
                    : state === "shaky"
                      ? "bg-steel-300"
                      : "bg-tint-line"
              }`}
            />
          );
        })}
      </div>

      {/* The stacked edges are absolutely positioned but sized off the card in normal flow, so
          the stack follows the card as the answer expands it. The card itself is plain flow —
          it was a 3D flip, and two absolutely-positioned faces in a wrapper that was inline
          collapsed to nothing the first time it met real content. */}
      <div className="relative mt-4">
        <span aria-hidden className="bg-tint absolute inset-x-0 top-0 h-full rounded-card scale-x-[0.9] -translate-y-3.5 opacity-60" />
        <span aria-hidden className="bg-tint absolute inset-x-0 top-0 h-full rounded-card scale-x-[0.955] -translate-y-[7px]" />
        <button
          type="button"
          onClick={() => setRevealed((value) => !value)}
          aria-expanded={revealed}
          className={`rounded-card relative z-10 flex min-h-44 w-full flex-col gap-2.5 p-5 text-left transition-colors ${
            revealed ? "bg-steel-100" : "bg-tint-soft hover:bg-tint"
          }`}
        >
          <Kicker>Prompt</Kicker>
          <span className="font-head text-xl leading-snug font-semibold">{card.front}</span>

          {revealed ? (
            <span className="bg-surface motion-safe:animate-step-in mt-0.5 flex flex-col gap-1 rounded-[10px] px-3.5 py-3">
              <span className="font-head text-steel-600 text-[11px] tracking-widest uppercase">
                Answer
              </span>
              <span className="text-steel-900 text-[13.5px] leading-relaxed">{card.back}</span>
            </span>
          ) : null}

          <span
            className={`mt-auto pt-1 text-[11.5px] ${revealed ? "text-steel-600" : "text-ink/40"}`}
          >
            {revealed
              ? "Rate it below — your rating feeds the weak-spots report"
              : "Click the card to reveal the answer"}
          </span>
        </button>
      </div>

      <div className="grid grid-cols-3 gap-2">
        <RateButton className="bg-steel-500 hover:bg-steel-600 text-white" onClick={() => rate("known")}>
          Knew it
        </RateButton>
        <RateButton
          className="bg-steel-200 text-steel-800 hover:bg-steel-300"
          onClick={() => rate("shaky")}
        >
          Shaky
        </RateButton>
        <RateButton className="bg-tint text-ink/70 hover:bg-tint-strong" onClick={() => rate("unseen")}>
          Again
        </RateButton>
      </div>

      <div className="grid grid-cols-3 gap-2">
        <SignalTile label="Known" value={String(counts.known)} detail="Confident" />
        <SignalTile label="Shaky" value={String(counts.shaky)} detail="Repeat tomorrow" />
        <SignalTile label="Unseen" value={String(counts.unseen)} detail="Not drawn yet" />
      </div>
    </>
  );
}

function RateButton({
  children,
  className,
  onClick,
}: {
  children: React.ReactNode;
  className: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-pill h-9 text-[12.5px] font-semibold transition-colors ${className}`}
    >
      {children}
    </button>
  );
}

/* ═══════════════════════════════════════════════════════════ practice ══ */

function PracticeBody({
  kit,
  confidence,
  onStartSet,
}: {
  kit: InternalKit;
  confidence: ConfidenceMap;
  onStartSet: (category: QuestionCategory) => void;
}) {
  const sets = useMemo(
    () =>
      QUESTION_CATEGORIES.map((category) => ({
        category,
        questions: kit.questions.filter((question) => question.category === category),
      })).filter((set) => set.questions.length > 0),
    [kit.questions],
  );

  // Cards are tagged with the requirements they came from, and questions carry the same ids, so
  // a card's confidence can be attributed to the track its question belongs to. Nothing here is
  // averaged across tracks that were never opened.
  const byTrack = QUESTION_CATEGORIES.map((category) => {
    const requirementIds = new Set(
      kit.questions
        .filter((question) => question.category === category)
        .flatMap((question) => question.requirementIds),
    );
    const cards = kit.flashcards.filter((card) =>
      card.requirementIds.some((id) => requirementIds.has(id)),
    );
    const rated = cards.filter((card) => confidence[card.id] !== undefined);
    const known = rated.filter((card) => confidence[card.id] === "known").length;
    return { category, cards: cards.length, rated: rated.length, known };
  }).filter((row) => row.cards > 0);

  const weakest = byTrack
    .filter((row) => row.rated > 0)
    .sort((a, b) => a.known / a.rated - b.known / b.rated)[0];
  const unrated = byTrack.filter((row) => row.rated === 0);

  return (
    <>
      <Section label="What Start does">
        <p className="text-ink/70 text-[13.5px] leading-relaxed">
          No live interviewer and no model call. Start opens that track&rsquo;s questions with the
          answer outlines collapsed, so you answer first and check second. Your flashcard ratings
          are the only score, and they are what the report below reads.
        </p>
      </Section>

      {sets.length === 0 ? (
        <EmptyState title="Nothing to practise yet">
          Practice sets are the question bank, grouped. There are no questions in this kit.
        </EmptyState>
      ) : (
        <ul className="flex list-none flex-col gap-2">
          {sets.map((set) => (
            <li key={set.category}>
              <Frame tone="tile" className="flex items-center gap-3 px-3.5 py-3">
                <span className="min-w-0 flex-1">
                  <span className="font-head block text-[17px] font-semibold">
                    {CATEGORY_META[set.category].label}
                  </span>
                  <span className="text-ink/55 block text-xs tabular-nums">
                    {set.questions.length}{" "}
                    {set.questions.length === 1 ? "question" : "questions"} ·{" "}
                    {minutesForQuestions(set.questions)} min
                  </span>
                </span>
                <Button variant="primary" onClick={() => onStartSet(set.category)} className="shrink-0">
                  Start
                </Button>
              </Frame>
            </li>
          ))}
        </ul>
      )}

      <Section label="Weak spots">
        {byTrack.every((row) => row.rated === 0) ? (
          <p className="text-ink/55 text-[13.5px] leading-relaxed">
            Nothing rated yet. Work through the flashcards and this fills in — it is built from
            your own ratings, so there is nothing honest to show before there are any.
          </p>
        ) : (
          <>
            <div className="flex flex-col gap-2.5">
              {byTrack.map((row) => {
                const share = row.rated === 0 ? 0 : row.known / row.rated;
                return (
                  <div key={row.category} className="flex items-center gap-2.5">
                    <span className="w-24 shrink-0 truncate text-xs">
                      {CATEGORY_META[row.category].label}
                    </span>
                    <span className="bg-tint h-1.5 min-w-0 flex-1 overflow-hidden rounded-full">
                      <span
                        className={`block h-full rounded-full ${share < 0.6 ? "bg-steel-300" : "bg-steel-500"}`}
                        style={{ width: `${Math.round(share * 100)}%` }}
                      />
                    </span>
                    <span className="font-head text-ink/40 w-14 shrink-0 text-right text-xs tabular-nums">
                      {row.rated === 0 ? "Not run" : `${row.known}/${row.rated}`}
                    </span>
                  </div>
                );
              })}
            </div>

            {weakest ? (
              <div className="bg-steel-100 text-steel-900 mt-3 rounded-xl px-3.5 py-3 text-[13px] leading-relaxed">
                <span className="font-head text-steel-600 mb-1 block text-[11px] tracking-widest uppercase">
                  Weakest
                </span>
                <b className="font-semibold">{CATEGORY_META[weakest.category].label}.</b>{" "}
                {weakest.known} of {weakest.rated} cards in this track came back confident. The
                schedule already front-loads the hardest material — this is the track to spend the
                second pass on.
              </div>
            ) : null}

            {unrated.length > 0 ? (
              <p className="text-ink/55 mt-2.5 text-xs leading-relaxed">
                {unrated.map((row) => CATEGORY_META[row.category].label).join(", ")}{" "}
                {unrated.length === 1 ? "has" : "have"} no ratings yet, so{" "}
                {unrated.length === 1 ? "it is" : "they are"} excluded rather than scored zero —
                an unrun track is not a weak one.
              </p>
            ) : null}
          </>
        )}
      </Section>
    </>
  );
}
