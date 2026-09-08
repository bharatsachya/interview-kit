import { notFound } from "next/navigation";
import { QUESTION_CATEGORIES } from "@trao/kit";
import { Frame } from "@/components/industry/frame";
import { RequirementChip } from "@/components/industry/requirement-chip";
import { Eyebrow } from "@/components/industry/text";
import { CategorySection } from "@/components/kit/category-section";
import { CoverageBar } from "@/components/kit/coverage-bar";
import { ScheduleList } from "@/components/kit/schedule-list";
import { SectionSwitcher } from "@/components/kit/section-switcher";
import { loadKit } from "@/lib/kits";

const SECTIONS = [
  { id: "brief", label: "Brief" },
  { id: "role", label: "Role" },
  { id: "questions", label: "Questions" },
  { id: "cards", label: "Cards" },
  { id: "plan", label: "Plan" },
] as const;

export default async function KitPage({ params }: PageProps<"/kit/[kitId]">) {
  const { kitId } = await params;
  const kit = await loadKit(kitId);
  if (!kit) notFound();

  const byCategory = new Map(
    QUESTION_CATEGORIES.map((category) => [
      category,
      kit.questions.filter((question) => question.category === category),
    ]),
  );

  return (
      <div className="flex flex-col gap-6 pt-6 pb-24 md:flex-row md:gap-10 md:pb-16">
        {/* Laptop adds a sticky rail; the phone gets the same list pinned to the bottom, where
            the thumb is. Same links, same order — one switcher, two placements. */}
        <SectionSwitcher sections={SECTIONS} />

        <main className="flex min-w-0 flex-1 flex-col gap-16">
          <header className="flex flex-col gap-3">
            <Eyebrow className="text-teal-700">{kit.role.company}</Eyebrow>
            <h1 className="max-w-read text-4xl tracking-tight md:text-5xl">{kit.role.title}</h1>
            <p className="flex flex-wrap gap-3 text-xs font-medium tracking-widest uppercase opacity-55">
              <span>{kit.role.location || "Location not stated"}</span>
              <span aria-hidden>·</span>
              <span className="tabular-nums">{kit.schedule.daysAvailable} days to prepare</span>
              <span aria-hidden>·</span>
              <span className="tabular-nums">{kit.questions.length} questions</span>
              <span aria-hidden>·</span>
              <span className="tabular-nums">{kit.flashcards.length} cards</span>
            </p>
          </header>

          <section id="brief" className="flex scroll-mt-6 flex-col gap-6">
            <Eyebrow className="text-teal-700">
              <h2 className="inline">Company brief</h2>
            </Eyebrow>
            <p className="max-w-read text-lg leading-snug">{kit.companyBrief.summary}</p>

            <div className="max-w-read flex flex-col gap-3">
              <h3 className="text-xl">What they do</h3>
              <p className="text-base leading-relaxed">{kit.companyBrief.whatTheyDo}</p>
            </div>

            <div className="max-w-read flex flex-col gap-3">
              <h3 className="text-xl">How they interview</h3>
              {kit.companyBrief.hiringProcess ? (
                <p className="text-base leading-relaxed">{kit.companyBrief.hiringProcess}</p>
              ) : (
                <p className="text-base leading-relaxed opacity-55">
                  Nothing found. No hiring page turned up on their site, so this is blank rather
                  than guessed.
                </p>
              )}
            </div>

            {/* A brief that silently omits a section is indistinguishable from one that had
                nothing to say. What could not be found is printed, not dropped. */}
            {kit.companyBrief.gaps.length > 0 ? (
              <Frame empty marks={false} className="max-w-read flex flex-col gap-3 p-4">
                <Eyebrow>What we could not find</Eyebrow>
                <ul className="flex list-none flex-col gap-2">
                  {kit.companyBrief.gaps.map((gap) => (
                    <li key={gap} className="flex gap-3 text-sm leading-relaxed">
                      <span aria-hidden className="bg-ink mt-2.5 h-px w-3 shrink-0 opacity-55" />
                      {gap}
                    </li>
                  ))}
                </ul>
              </Frame>
            ) : null}

            <div className="max-w-read flex flex-col gap-3">
              <Eyebrow className="opacity-55">
                <h3 className="inline">Sources</h3>
              </Eyebrow>
              <ul className="flex list-none flex-col gap-2">
                {kit.companyBrief.sources.map((source) => {
                  const used = kit.companyBrief.pagesUsed.includes(source);
                  return (
                    <li key={source} className="flex flex-wrap items-baseline gap-3 text-sm">
                      <a href={source} className="text-teal-700 underline underline-offset-4">
                        {source}
                      </a>
                      {used ? (
                        <span className="text-xs font-medium opacity-55">read in full</span>
                      ) : (
                        <span className="text-xs font-medium opacity-40">found, not used</span>
                      )}
                    </li>
                  );
                })}
              </ul>
            </div>
          </section>

          <section id="role" className="flex scroll-mt-6 flex-col gap-6">
            <Eyebrow className="text-teal-700">
              <h2 className="inline">Role breakdown</h2>
            </Eyebrow>
            <p className="max-w-read text-base leading-relaxed">{kit.role.summary}</p>

            <CoverageBar
              requirements={kit.requirements}
              uncoveredRequirementIds={kit.coverage.uncoveredRequirementIds}
              passes={kit.coverage.passes}
            />

            <ul className="flex list-none flex-wrap gap-3">
              {kit.requirements.map((requirement) => (
                <li key={requirement.id} id={`requirement-${requirement.id}`} className="scroll-mt-6">
                  <RequirementChip requirement={requirement} />
                </li>
              ))}
            </ul>
          </section>

          <section id="questions" className="flex scroll-mt-6 flex-col gap-10">
            <Eyebrow className="text-teal-700">
              <h2 className="inline">Questions</h2>
            </Eyebrow>
            {QUESTION_CATEGORIES.map((category) => (
              <CategorySection
                key={category}
                category={category}
                questions={byCategory.get(category) ?? []}
              />
            ))}
          </section>

          <section id="cards" className="flex scroll-mt-6 flex-col gap-6">
            <Eyebrow className="text-teal-700">
              <h2 className="inline">Flashcards</h2>
            </Eyebrow>
            {kit.flashcards.length === 0 ? (
              <Frame empty marks={false} className="p-4">
                <p className="max-w-read text-sm">
                  No cards yet — flashcards are made from requirements.
                </p>
              </Frame>
            ) : (
              <ul className="flex list-none flex-col gap-4">
                {kit.flashcards.map((flashcard) => (
                  <li key={flashcard.id}>
                    <Frame className="flex flex-col gap-3 p-4">
                      <p className="max-w-read text-lg leading-snug">{flashcard.front}</p>
                      <p className="max-w-outline text-base leading-relaxed opacity-80">
                        {flashcard.back}
                      </p>
                      <p className="text-xs tabular-nums opacity-50">
                        {flashcard.requirementIds.join(" · ")}
                      </p>
                    </Frame>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section id="plan" className="flex scroll-mt-6 flex-col gap-6">
            <Eyebrow className="text-teal-700">
              <h2 className="inline">Study plan</h2>
            </Eyebrow>
            <ScheduleList schedule={kit.schedule} questions={kit.questions} />
          </section>
        </main>
      </div>
  );
}
