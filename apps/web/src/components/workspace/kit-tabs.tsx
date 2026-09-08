"use client";

import { useRef } from "react";
import { QUESTION_CATEGORIES, type InternalKit } from "@trao/kit";
import { Frame } from "@/components/industry/frame";
import { RequirementChip } from "@/components/industry/requirement-chip";
import { EmptyState } from "@/components/industry/states";
import { Eyebrow } from "@/components/industry/text";
import { CategorySection } from "@/components/kit/category-section";
import { CoverageBar } from "@/components/kit/coverage-bar";
import { ScheduleList } from "@/components/kit/schedule-list";

export const KIT_TABS = [
  { id: "brief", label: "Brief" },
  { id: "role", label: "Role" },
  { id: "questions", label: "Questions" },
  { id: "flashcards", label: "Flashcards" },
  { id: "schedule", label: "Schedule" },
  { id: "practice", label: "Practice" },
] as const;

export type KitTabId = (typeof KIT_TABS)[number]["id"];

/**
 * The tab strip.
 *
 * A real tablist: one tab stop for the whole strip, arrows to move between tabs, Home and End
 * to jump. People who reach for arrow keys in a tab strip are the same people the interaction
 * score is about, and the browser gives none of this for free.
 */
export function KitTabStrip({
  active,
  onSelect,
}: {
  active: KitTabId;
  onSelect: (tab: KitTabId) => void;
}) {
  const strip = useRef<HTMLDivElement>(null);

  function onKeyDown(event: React.KeyboardEvent) {
    const index = KIT_TABS.findIndex((tab) => tab.id === active);
    let next = index;
    if (event.key === "ArrowRight") next = (index + 1) % KIT_TABS.length;
    else if (event.key === "ArrowLeft") next = (index - 1 + KIT_TABS.length) % KIT_TABS.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = KIT_TABS.length - 1;
    else return;

    event.preventDefault();
    const target = KIT_TABS[next];
    if (!target) return;
    onSelect(target.id);
    strip.current?.querySelector<HTMLButtonElement>(`[data-tab="${target.id}"]`)?.focus();
  }

  return (
    <div
      ref={strip}
      role="tablist"
      aria-label="Kit sections"
      onKeyDown={onKeyDown}
      className="border-divider flex shrink-0 gap-1 overflow-x-auto border-b px-2"
    >
      {KIT_TABS.map((tab) => {
        const selected = tab.id === active;
        return (
          <button
            key={tab.id}
            role="tab"
            data-tab={tab.id}
            aria-selected={selected}
            aria-controls={`kit-panel-${tab.id}`}
            id={`kit-tab-${tab.id}`}
            tabIndex={selected ? 0 : -1}
            onClick={() => onSelect(tab.id)}
            className={`font-head min-h-11 shrink-0 border-b-2 px-3 text-xs tracking-widest uppercase ${
              selected ? "border-teal-700 text-teal-800" : "border-transparent opacity-55 hover:opacity-100"
            }`}
          >
            {tab.label}
          </button>
        );
      })}
    </div>
  );
}

/** Read-only tab bodies. The builder's controls arrive in step 4, on top of these. */
export function KitTabPanel({ tab, kit }: { tab: KitTabId; kit: InternalKit }) {
  return (
    <div
      role="tabpanel"
      id={`kit-panel-${tab}`}
      aria-labelledby={`kit-tab-${tab}`}
      tabIndex={0}
      className="flex flex-col gap-6 p-4"
    >
      {tab === "brief" ? <BriefTab kit={kit} /> : null}
      {tab === "role" ? <RoleTab kit={kit} /> : null}
      {tab === "questions" ? <QuestionsTab kit={kit} /> : null}
      {tab === "flashcards" ? <FlashcardsTab kit={kit} /> : null}
      {tab === "schedule" ? <ScheduleTab kit={kit} /> : null}
      {tab === "practice" ? (
        <EmptyState title="Practice">Practice mode arrives in step 5.</EmptyState>
      ) : null}
    </div>
  );
}

function BriefTab({ kit }: { kit: InternalKit }) {
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
          <p className="max-w-read text-lg leading-snug">{brief.summary}</p>

          <section className="flex flex-col gap-2">
            <h3 className="text-lg">What they do</h3>
            <p className="max-w-read text-base leading-relaxed">{brief.whatTheyDo}</p>
          </section>

          <section className="flex flex-col gap-2">
            <h3 className="text-lg">How they interview</h3>
            {brief.hiringProcess ? (
              <p className="max-w-read text-base leading-relaxed">{brief.hiringProcess}</p>
            ) : (
              <p className="max-w-read text-base leading-relaxed opacity-55">
                No hiring page turned up on their site, so this is blank rather than guessed.
              </p>
            )}
          </section>
        </>
      )}

      {/* What could not be found is printed, not dropped: a brief that silently omits a section
          is indistinguishable from one that had nothing to say. */}
      {brief.gaps.length > 0 ? (
        <Frame empty marks={false} className="flex flex-col gap-2 p-4">
          <Eyebrow className="opacity-70">What we could not find</Eyebrow>
          <ul className="flex list-none flex-col gap-2">
            {brief.gaps.map((gap) => (
              <li key={gap} className="text-sm leading-relaxed">
                {gap}
              </li>
            ))}
          </ul>
        </Frame>
      ) : null}

      {brief.sources.length > 0 ? (
        <section className="flex flex-col gap-2">
          <Eyebrow className="opacity-55">
            <h3 className="inline">Sources</h3>
          </Eyebrow>
          <ul className="flex list-none flex-col gap-2">
            {brief.sources.map((source) => (
              <li key={source} className="flex flex-wrap items-baseline gap-2 text-sm">
                <a href={source} className="text-teal-700 break-all underline underline-offset-4">
                  {source}
                </a>
                <span className="text-xs opacity-45">
                  {brief.pagesUsed.includes(source) ? "read in full" : "found, not used"}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </>
  );
}

function RoleTab({ kit }: { kit: InternalKit }) {
  const musts = kit.requirements.filter((requirement) => requirement.priority === "must");
  // A two-line description yields a handful of requirements. That is thin, not broken, and the
  // difference has to be said out loud or the kit reads as a failure.
  const thin = kit.requirements.length <= 4;

  return (
    <>
      <section className="flex flex-col gap-2">
        <h3 className="text-lg">{kit.role.title}</h3>
        <p className="text-xs tracking-widest uppercase opacity-55">
          {kit.role.location || "Location not stated"}
        </p>
        <p className="max-w-read text-base leading-relaxed">{kit.role.summary}</p>
      </section>

      {thin ? (
        <EmptyState title="A thin description">
          {kit.requirements.length} {kit.requirements.length === 1 ? "requirement" : "requirements"}, and{" "}
          {musts.length} of them must-have. That is all the posting gave us. The kit below is built
          on exactly that and nothing invented — add requirements by hand if you know more than the
          advert says.
        </EmptyState>
      ) : null}

      <CoverageBar
        requirements={kit.requirements}
        uncoveredRequirementIds={kit.coverage.uncoveredRequirementIds}
        passes={kit.coverage.passes}
      />

      <ul className="flex list-none flex-wrap gap-2">
        {kit.requirements.map((requirement) => (
          <li key={requirement.id} id={`requirement-${requirement.id}`} className="scroll-mt-4">
            <RequirementChip requirement={requirement} />
          </li>
        ))}
      </ul>
    </>
  );
}

function QuestionsTab({ kit }: { kit: InternalKit }) {
  return (
    <>
      {QUESTION_CATEGORIES.map((category) => (
        <CategorySection
          key={category}
          category={category}
          questions={kit.questions.filter((question) => question.category === category)}
        />
      ))}
    </>
  );
}

function FlashcardsTab({ kit }: { kit: InternalKit }) {
  if (kit.flashcards.length === 0) {
    return (
      <EmptyState title="No cards yet">
        Flashcards are derived from the questions, so there will be cards once there are questions.
      </EmptyState>
    );
  }

  return (
    <ul className="flex list-none flex-col gap-4">
      {kit.flashcards.map((flashcard) => (
        <li key={flashcard.id}>
          <Frame className="flex flex-col gap-2 p-4">
            <p className="text-base leading-snug">{flashcard.front}</p>
            <p className="max-w-outline text-sm leading-relaxed opacity-75">{flashcard.back}</p>
            <p className="text-xs tabular-nums opacity-45">{flashcard.requirementIds.join(" · ")}</p>
          </Frame>
        </li>
      ))}
    </ul>
  );
}

function ScheduleTab({ kit }: { kit: InternalKit }) {
  return <ScheduleList schedule={kit.schedule} questions={kit.questions} />;
}
