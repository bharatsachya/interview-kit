/**
 * What a person actually sent to start a run.
 *
 * Held as its parts rather than as a pre-rendered sentence. The conversation used to store one
 * string — the posting's first two hundred characters, a newline, then the URL and the days —
 * which meant the posting existed nowhere in full and the bubble could only ever show a stump
 * of it. Keeping the parts lets the turn render a document you can open and read, and costs
 * nothing: the composer had all three in its hands at submit.
 */
export type AskParts =
  /** One posting, with the two settings that went with it. Rendered as a document you can open. */
  | { kind: "posting"; jd: string; url: string; days: number }
  /**
   * A batch, which is several postings and no single document to show.
   *
   * Kept as the sentence the composer already wrote. Turning six roles into six cards would put
   * the run itself off the screen, which is the problem the document card exists to solve.
   */
  | { kind: "summary"; text: string }
  /**
   * A change asked of a kit that already exists — a rewrite of one section.
   *
   * Its own kind rather than a `summary`, because the turn that follows it says something
   * different: a first run reports a kit built, a rewrite reports one section rewritten into a
   * new kit, and the conversation should not claim to have built a kit from a posting when it
   * forked one from another kit.
   *
   * `text` is what the person actually sent — the prompt as it stood in the composer when they
   * pressed Send, edits and all — rather than a label derived from `section`. The point of
   * putting the rewrite in the composer was that the words could be theirs; showing a canned
   * sentence back would take that away again at the only moment it is visible.
   */
  | { kind: "change"; text: string; section: string };

/** An ask, plus when *you* sent it — captured at submit, not when the server got round to it. */
export type Ask = AskParts & { at: number };

/** Narrowing helper, so callers read as prose rather than as a discriminant check. */
export function isPosting(ask: Ask): ask is Extract<Ask, { kind: "posting" }> & { at: number } {
  return ask.kind === "posting";
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
