"use client";

import { useId, useState } from "react";
import { minutesForDifficulty, type InternalQuestion } from "@trao/kit";
import { Frame } from "@/components/industry/frame";
import { CategoryMark, DifficultyTicks } from "@/components/industry/marks";
import { CATEGORY_META } from "@/lib/categories";

/** Outlines are stored as one string; the bullets are the lines. Never prose blocks. */
export function outlineBullets(answerOutline: string): string[] {
  return answerOutline
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/**
 * The question is the object: its text is the largest body type in the product, and category,
 * difficulty and minutes are chrome that stays small.
 *
 * The outline is collapsed by default so a category reads as a list of questions rather than a
 * wall — the point of the kit view is to see what you have, and the point of practice is to
 * work through it.
 */
export function QuestionCard({ question }: { question: InternalQuestion }) {
  const [open, setOpen] = useState(false);
  const outlineId = useId();
  const meta = CATEGORY_META[question.category];
  const bullets = outlineBullets(question.answerOutline);

  return (
    <Frame as="article" className="flex flex-col gap-3 p-4">
      <div className="flex flex-wrap items-center gap-3">
        <CategoryMark category={question.category} />
        <span className="font-head text-xs tracking-widest uppercase">{meta.label}</span>
        <span className="text-xs font-medium tabular-nums opacity-55">
          {minutesForDifficulty(question.difficulty)} MIN
        </span>

        {/* Provenance is stated, not colour-coded: the user needs to know a rewrite will spare
            this card, and "pinned" is the word that says so. */}
        {question.pinned ? (
          <span className="border-ink ml-auto border px-2 py-px text-xs font-medium">Pinned</span>
        ) : null}
        {question.origin === "edited" ? (
          <span className={`text-xs font-medium opacity-55 ${question.pinned ? "" : "ml-auto"}`}>
            Edited
          </span>
        ) : null}
        {question.origin === "manual" ? (
          <span className="ml-auto text-xs font-medium opacity-55">Yours</span>
        ) : null}
      </div>

      <p className="max-w-read text-lg leading-snug">{question.prompt}</p>

      {bullets.length > 0 ? (
        <>
          <button
            type="button"
            className="text-steel-700 self-start text-sm font-medium underline underline-offset-4"
            aria-expanded={open}
            aria-controls={outlineId}
            onClick={() => setOpen((wasOpen) => !wasOpen)}
          >
            {open ? "Hide outline" : "Show outline"}
          </button>
          {open ? (
            <ul id={outlineId} className="max-w-outline flex list-none flex-col gap-2">
              {bullets.map((bullet) => (
                <li key={bullet} className="flex gap-3 text-base leading-relaxed">
                  <span aria-hidden className="bg-ink mt-2.5 h-px w-3 shrink-0" />
                  {bullet}
                </li>
              ))}
            </ul>
          ) : null}
        </>
      ) : (
        <p className="text-sm opacity-55">
          No answer outline yet — three bullets is plenty.
        </p>
      )}

      <div className="text-ink/50 flex flex-wrap items-center gap-3 text-xs">
        <DifficultyTicks difficulty={question.difficulty} />
        {question.requirementIds.length > 0 ? (
          <span className="tabular-nums">{question.requirementIds.join(" · ")}</span>
        ) : (
          <span>Covers no requirement</span>
        )}
      </div>
    </Frame>
  );
}
