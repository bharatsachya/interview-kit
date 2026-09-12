/**
 * The posting a turn was built from, as the conversation renders it.
 *
 * This was a discriminated union of every kind of ask, held in React state on the workspace. The
 * server owns that shape now — `JobAsk` in `@trao/contracts`, stored on the job record, which is
 * what lets a transcript survive a reload. What is left here is the one shape the document card
 * needs and the three string helpers that format it.
 */
export interface Posting {
  kind: "posting";
  jd: string;
  url: string;
  days: number;
  /** When it was sent. From the job record, so a reload shows the same time as the first render. */
  at: number;
}

/** A title for the posting, taken from its first non-empty line. */
export function askTitle(jd: string): string {
  const first = jd.split("\n").map((line) => line.trim()).find((line) => line !== "");
  if (first === undefined || first === "") return "Job description";
  return first.length <= 64 ? first : `${first.slice(0, 64).replace(/\s+\S*$/, "")}…`;
}

/** "1,482 words" — the size of the thing, so the card says what opening it costs. */
export function askSize(jd: string): string {
  const words = jd.trim().split(/\s+/).filter((w) => w !== "").length;
  return `${words.toLocaleString()} ${words === 1 ? "word" : "words"}`;
}

/** The whole posting as plain text, which is what Copy should put on the clipboard. */
export function askPlainText(ask: { jd: string; url: string; days: number }): string {
  const when = ask.days === 1 ? "1 day" : `${ask.days} days`;
  return `${ask.jd}\n\n${ask.url} · ${when} until the interview`;
}
