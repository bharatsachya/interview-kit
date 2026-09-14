"use client";

import { useEffect, useRef, useState } from "react";
import { parseCasesJSON, type EvaluationCase } from "@trao/kit";
import { api } from "@/lib/api/client";
import type { SessionTurnView } from "@/lib/api/types";
import { ApiError } from "@/lib/api/types";
import { normaliseCompanyUrl } from "@/lib/role-guess";
import { Badge, CalendarIcon, GlobeIcon } from "@/components/industry/badge";
import { glimpseUrl } from "@/lib/url-glimpse";
import { rewriteKeeps, type Rewrite } from "@/lib/rewrite";
import { Button } from "@/components/industry/button";
import { ErrorNotice } from "@/components/industry/states";
import { Eyebrow } from "@/components/industry/text";

/** The six the popover offers. Anything else goes in the field underneath it. */
const DAY_PRESETS = [3, 5, 8, 14, 21, 30] as const;

/** A role added but not yet built. Held as typed, so editing it puts back exactly what you had. */
interface QueuedRole {
  key: string;
  jd: string;
  companyUrl: string;
  days: string;
  note: string;
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

/**
 * The `id` Appendix B requires, made from the company rather than asked for.
 *
 * It is a key for the batch output, not something a candidate has or should have to invent. The
 * index keeps it unique when two roles are at the same company, which is the one case a hostname
 * alone would collide on — and `parseCases` rejects duplicate ids outright.
 */
function caseId(url: string, index: number): string {
  const slug = hostOf(url).replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").toLowerCase();
  return `${slug || "role"}-${String(index + 1).padStart(2, "0")}`;
}

/** The candidate's own note, appended to the posting under a label so it is never mistaken for it. */
function withNote(jd: string, note: string): string {
  return note === "" ? jd : `${jd}\n\nAdded by the candidate:\n${note}`;
}

/**
 * The composer: a job description, a company site, the days left, and a file for several roles
 * at once.
 *
 * The three inputs are not three labelled fields any more. Two of them — the site and the days —
 * are settings with short, already-known values, and a labelled box with a hint under it is a
 * lot of furniture to spend on a URL. They are badges instead: the value is the control, and the
 * label is folded into the sentence the badge makes. The posting keeps the room, because the
 * posting is the input that actually needs it.
 *
 * Focus lives on the whole composer rather than the textarea. A square outline drawn tight
 * around a borderless input inside a 22px card is the one thing that makes the card look like a
 * mistake, so the ring goes around the card and the textarea never draws its own.
 *
 * The button is dimmed until it would do something, and says what is missing on hover rather
 * than waiting for a click to tell you. Errors that only a submit can find — a posting too thin
 * to work with, a URL that will not parse — still surface after one.
 */
/**
 * A word count, formatted the same on the server and in the browser.
 *
 * `toLocaleString()` with no locale uses the runtime's own — Node's on the server, the user's in
 * the browser — so "1,240" and "1.240" can render for the same number and hydration reports a
 * mismatch. Pinning the locale makes it one answer. The kit's own numbers are pinned the same
 * way for the same reason.
 */
function formatCount(value: number): string {
  return value.toLocaleString("en-US");
}

export function Composer({
  onStarted,
  rewrite,
  onCancelRewrite,
}: {
  /**
   * Something was sent: the conversation it belongs to, the turns it added, and whether it
   * opened that conversation or continued one.
   *
   * The turns are built in the same shape `GET /sessions/:id` returns, so what is on screen a
   * second after sending and what a reload reads back are the same thing rather than two
   * representations that drift.
   */
  onStarted: (sessionId: string, turns: SessionTurnView[], opensNew: boolean) => void;
  /**
   * A rewrite staged by the kit panel, waiting to be read, changed and sent.
   *
   * While this is set the composer is in rewrite mode: no posting, no site, no days — those
   * belong to the kit this is rewriting and asking for them again would be asking the user to
   * retype what the kit already knows. Null puts it back to building kits from postings.
   */
  rewrite: Rewrite | null;
  onCancelRewrite: () => void;
}) {
  const [jd, setJd] = useState("");
  const [companyUrl, setCompanyUrl] = useState("");
  const [days, setDays] = useState("");
  const [note, setNote] = useState("");
  const [noteOpen, setNoteOpen] = useState(false);
  const [batch, setBatch] = useState<{ cases: EvaluationCase[]; fileName: string } | null>(null);
  // Roles already added, waiting to be built alongside whatever is in the composer now.
  const [queue, setQueue] = useState<QueuedRole[]>([]);

  const [errors, setErrors] = useState<{ jd?: string; companyUrl?: string; days?: string }>({});
  const [fileErrors, setFileErrors] = useState<string[]>([]);
  const [submitError, setSubmitError] = useState<{ message: string; attempts: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [focused, setFocused] = useState(false);
  const [open, setOpen] = useState<"url" | "days" | null>(null);

  const fileRef = useRef<HTMLInputElement>(null);
  const promptRef = useRef<HTMLTextAreaElement>(null);

  // The prompt the panel staged, as editable text.
  //
  // Held here rather than in the workspace because it is a draft being typed, and a keystroke
  // that re-renders three panes is a keystroke you can feel. The workspace owns *which* rewrite
  // is staged; this owns what it currently says.
  const [prompt, setPrompt] = useState("");

  // A press of Regenerate arms the composer and puts the caret at the end of the sentence, so
  // the natural next action — typing what you actually wanted — needs no click. Keyed on
  // `rewrite.key` rather than on the object, so pressing the same button twice re-arms it
  // instead of silently doing nothing, and typing does not get reset on every render.
  const rewriteKey = rewrite?.key ?? null;
  useEffect(() => {
    if (rewrite === null) return;
    setPrompt(rewrite.prompt);
    setSubmitError(null);
    const field = promptRef.current;
    if (field === null) return;
    field.focus();
    field.setSelectionRange(rewrite.prompt.length, rewrite.prompt.length);
    // `rewrite` itself is deliberately not a dependency — see the note above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rewriteKey]);

  // What the composer is still missing before the draft in it counts as a role.
  const missing: string[] = [
    jd.trim() === "" ? "the job posting" : null,
    companyUrl.trim() === "" ? "the company website" : null,
    days.trim() === "" ? "how many days you have" : null,
  ].filter((item): item is string => item !== null);

  const draftFilled = missing.length === 0;
  // Something to build: an uploaded file, roles already queued, or a complete draft — or, in
  // rewrite mode, a prompt with something in it. Read in two places — the disabled state and the
  // tooltip — so the tooltip cannot claim something different from what the button is enforcing.
  const ready =
    rewrite !== null ? prompt.trim() !== "" : batch !== null || queue.length > 0 || draftFilled;
  const roleCount = batch ? batch.cases.length : queue.length + (draftFilled ? 1 : 0);

  function addRole() {
    if (!draftFilled) return;
    const url = normaliseCompanyUrl(companyUrl);
    if (url === null) {
      setErrors((previous) => ({ ...previous, companyUrl: "Something like vaultline.com is enough." }));
      return;
    }
    setQueue((previous) => [
      ...previous,
      { key: `${Date.now()}-${previous.length}`, jd: jd.trim(), companyUrl: url, days: days.trim(), note: note.trim() },
    ]);
    // The site and the days usually carry over to the next role only by accident, so they are
    // cleared with the posting. Guessing wrong here would silently build a kit for the wrong
    // company on the right posting, which is worse than retyping a domain.
    setJd("");
    setCompanyUrl("");
    setDays("");
    setNote("");
    setNoteOpen(false);
    setErrors({});
  }

  /** Pull a queued role back into the composer to change it. */
  function editRole(key: string) {
    const role = queue.find((entry) => entry.key === key);
    if (!role) return;
    setQueue((previous) => previous.filter((entry) => entry.key !== key));
    setJd(role.jd);
    setCompanyUrl(role.companyUrl);
    setDays(role.days);
    setNote(role.note);
    setNoteOpen(role.note !== "");
  }

  async function submit() {
    if (!ready || busy) return;
    setSubmitError(null);

    // A rewrite is its own path and it leaves the composer's own draft alone: whatever posting
    // you had half-typed is still there afterwards, because sending a rewrite is not finishing
    // the thing you were writing.
    if (rewrite !== null) {
      const text = prompt.trim();
      // The default sentence carries nothing the section does not already say, so it is not
      // forwarded as an instruction — a prompt reading "Rewrite the technical questions." would
      // otherwise reach the model as a steer telling it what it was already being asked to do.
      const instructions = text === rewrite.prompt.trim() ? undefined : text;

      setBusy(true);
      try {
        const response = await api.regenerate(rewrite.kitId, {
          section: rewrite.section,
          ...(rewrite.category !== undefined ? { category: rewrite.category } : {}),
          ...(instructions !== undefined ? { instructions } : {}),
        });
        onCancelRewrite();
        setPrompt("");
        onStarted(
          response.session_id,
          [
            turnFor(response.job_id, {
              kind: "rewrite",
              section: rewrite.section,
              ...(rewrite.category !== undefined ? { category: rewrite.category } : {}),
              // What was actually sent, not a label rebuilt from the section — the point of
              // putting the rewrite in the composer was that the words could be theirs.
              prompt: text,
            }),
          ],
          false,
        );
      } catch (error) {
        setSubmitError((previous) => ({ message: messageFor(error), attempts: (previous?.attempts ?? 0) + 1 }));
      } finally {
        setBusy(false);
      }
      return;
    }

    if (batch) {
      await start(() => api.createBatch({ cases: batch.cases }), batch.cases);
      return;
    }

    // More than one role goes down the same batch endpoint the JSON upload uses, and the same
    // one `npm run evaluate` feeds. One format, one parser, whether the cases were typed here or
    // written by hand.
    if (queue.length > 0) {
      const drafted = draftFilled ? [...queue, { key: "draft", jd: jd.trim(), companyUrl: normaliseCompanyUrl(companyUrl) ?? companyUrl, days: days.trim(), note: note.trim() }] : queue;
      const cases: EvaluationCase[] = drafted.map((role, index) => ({
        id: caseId(role.companyUrl, index),
        jd: withNote(role.jd, role.note),
        company_url: role.companyUrl,
        days: Number(role.days),
      }));
      await start(() => api.createBatch({ cases }), cases);
      return;
    }

    const next: typeof errors = {};
    const trimmedJd = jd.trim();
    if (trimmedJd.length < 40) {
      next.jd = "That is very short for a posting. A thin description makes a thin kit.";
    }
    const url = normaliseCompanyUrl(companyUrl);
    if (url === null) next.companyUrl = "Something like vaultline.com is enough.";
    const dayCount = Number(days.trim());
    if (!Number.isInteger(dayCount) || dayCount < 1 || dayCount > 365) {
      next.days = "A whole number, 1 to 365.";
    }

    setErrors(next);
    if (Object.keys(next).length > 0 || url === null) return;

    // The note is appended to the posting rather than sent as its own field: the pipeline reads
    // one job description, and what the candidate knows about the role is part of the posting as
    // far as extraction is concerned. Labelled, so it is never mistaken for the advert's words.
    const description = withNote(trimmedJd, note.trim());

    // The posting as written, not the one with the note appended: the card shows what the
    // person sent, and the note is already visible as its own control in the composer.
    // The posting as written, not the one with the note appended: the card shows what the person
    // sent, and the note is already visible as its own control in the composer.
    await start(() => api.createKit({ jd: description, company_url: url, days: dayCount }), [
      { id: "", jd: trimmedJd, company_url: url, days: dayCount },
    ]);
  }

  /**
   * Send, and put what was sent on screen.
   *
   * One turn per job, zipped against the cases in the order they were submitted — the API starts
   * them in input order for exactly this reason. A batch therefore reads as the six postings it
   * was rather than as one opaque "6 roles from cases.json", and it reads the same way after a
   * reload, because that is what the session holds.
   */
  async function start(
    request: () => Promise<{ job_ids: string[]; session_id: string }>,
    sent: readonly EvaluationCase[],
  ) {
    setBusy(true);
    try {
      const response = await request();
      onStarted(
        response.session_id,
        response.job_ids.map((jobId, index) => {
          const role = sent[index];
          return turnFor(
            jobId,
            role === undefined
              ? null
              : { kind: "posting", jd: role.jd, companyUrl: role.company_url, days: role.days },
          );
        }),
        true,
      );
      setJd("");
      setCompanyUrl("");
      setDays("");
      setNote("");
      setNoteOpen(false);
      setBatch(null);
      setQueue([]);
      setErrors({});
    } catch (error) {
      setSubmitError((previous) => ({ message: messageFor(error), attempts: (previous?.attempts ?? 0) + 1 }));
    } finally {
      setBusy(false);
    }
  }

  async function onFile(file: File) {
    setFileErrors([]);
    const parsed = parseCasesJSON(await file.text());
    if (!parsed.ok) {
      setFileErrors(parsed.errors);
      setBatch(null);
      return;
    }
    setBatch({ cases: parsed.cases, fileName: file.name });
  }

  /** Cmd/ctrl+Enter submits from any field — plain Enter belongs to the textarea. */
  function onKeyDown(event: React.KeyboardEvent) {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      void submit();
    }
  }

  // Two labels for one setting. "8 days until the interview" is the sentence the badge is meant
  // to make, and it is 250px wide — at 390px it forces every badge onto its own line and the
  // composer becomes a column of pills. The phone gets the number and the noun; the sentence
  // returns as soon as there is room for it.
  const dayShort = days.trim() === "" ? "Days" : `${days.trim()} ${days.trim() === "1" ? "day" : "days"}`;
  const dayLong =
    days.trim() === ""
      ? "Days until the interview"
      : `${days.trim()} ${days.trim() === "1" ? "day" : "days"} until the interview`;

  return (
    <div className="flex flex-col gap-4">
      {fileErrors.length > 0 ? (
        <ErrorNotice title="That file could not be read">
          <ul className="flex list-none flex-col gap-1">
            {fileErrors.slice(0, 6).map((error) => (
              <li key={error} className="font-medium">
                {error}
              </li>
            ))}
          </ul>
          <p className="mt-2 opacity-70">
            It should be a list of <code className="text-xs">{`{ id, jd, company_url, days }`}</code> —
            the same shape the batch runner takes.
          </p>
        </ErrorNotice>
      ) : null}

      {submitError ? (
        <ErrorNotice
          title="Could not start the run"
          attempts={submitError.attempts}
          actions={
            <Button variant="primary" onClick={() => void submit()}>
              Try again
            </Button>
          }
        >
          {submitError.message}
        </ErrorNotice>
      ) : null}

      {/* Roles already added. Each is independent — removing one leaves the rest, and a bad
          posting fails on its own rather than taking the batch with it. */}
      {queue.length > 0 ? (
        <ul className="flex list-none flex-col gap-1.5">
          {queue.map((role, index) => (
            <li
              key={role.key}
              className="bg-surface flex items-center gap-3 rounded-[14px] px-3 py-2.5"
            >
              <span className="font-head text-steel-400 w-4 shrink-0 text-xs tabular-nums">
                {String(index + 1).padStart(2, "0")}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13.5px] font-semibold">
                  {hostOf(role.companyUrl)}
                </span>
                <span className="text-ink/50 block truncate text-xs">
                  {role.days} {role.days === "1" ? "day" : "days"} ·{" "}
                  {formatCount(role.jd.split(/\s+/).length)} words
                </span>
              </span>
              <button
                type="button"
                onClick={() => editRole(role.key)}
                className="text-steel-600 hover:text-steel-800 shrink-0 text-xs font-medium underline-offset-4 hover:underline"
              >
                Edit
              </button>
              <button
                type="button"
                onClick={() => setQueue((previous) => previous.filter((entry) => entry.key !== role.key))}
                aria-label={`Remove ${hostOf(role.companyUrl)}`}
                className="text-ink/35 hover:bg-tint hover:text-ink grid size-6 shrink-0 place-items-center rounded-full transition-colors"
              >
                <svg aria-hidden width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
                  <path d="M18 6L6 18M6 6l12 12" />
                </svg>
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      <div
        className={`bg-surface rounded-composer px-3 pt-3 pb-2.5 transition-shadow sm:px-4 sm:pt-3.5 sm:pb-3 ${
          focused ? "ring-composer" : "shadow-[0_1px_2px_rgba(29,31,32,0.05)]"
        }`}
      >
        {rewrite ? (
          <>
            {/* What is being rewritten, and what it is being rewritten FROM. Without the kit's
                name this is a prompt with no object: the panel can be closed, and by the time
                you have typed two sentences "the technical questions" of which kit is a fair
                question. */}
            <div className="flex flex-wrap items-center gap-2 pb-2">
              <span className="bg-steel-100 text-steel-700 font-head rounded-pill inline-flex h-6 shrink-0 items-center px-3 text-xs tracking-widest uppercase">
                Rewrite
              </span>
              <span className="text-ink/60 min-w-0 flex-1 truncate text-[13px]">{rewrite.kitLabel}</span>
              <button
                type="button"
                onClick={onCancelRewrite}
                aria-label="Cancel this rewrite"
                className="text-ink/35 hover:bg-tint hover:text-ink grid size-6 shrink-0 place-items-center rounded-full transition-colors"
              >
                <svg aria-hidden width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
                  <path d="M18 6L6 18M6 6l12 12" />
                </svg>
              </button>
            </div>

            <label htmlFor="composer-rewrite" className="sr-only">
              What to change
            </label>
            <textarea
              id="composer-rewrite"
              ref={promptRef}
              value={prompt}
              rows={2}
              onChange={(event) => setPrompt(event.target.value)}
              onFocus={() => setFocused(true)}
              onBlur={() => setFocused(false)}
              onKeyDown={(event) => {
                // Stopped here, because the workspace listens for Escape on the document to
                // close the kit panel — and closing the panel is not what Escape means while
                // the caret is in a prompt you are about to send.
                if (event.key === "Escape") {
                  event.stopPropagation();
                  onCancelRewrite();
                  return;
                }
                onKeyDown(event);
              }}
              aria-describedby="composer-rewrite-hint"
              className="text-ink placeholder:text-ink/40 w-full resize-none bg-transparent px-0.5 pb-1.5 text-[14.5px] leading-relaxed outline-none"
            />
          </>
        ) : batch ? (
          <div className="flex flex-wrap items-center gap-3 py-2">
            <span className="text-sm">
              <strong className="font-semibold">{batch.cases.length} roles</strong> from{" "}
              {batch.fileName}
            </span>
            <Button variant="ghost" onClick={() => setBatch(null)}>
              Remove
            </Button>
          </div>
        ) : (
          <>
            <label htmlFor="composer-jd" className="sr-only">
              Job description
            </label>
            <textarea
              id="composer-jd"
              value={jd}
              rows={3}
              onChange={(event) => setJd(event.target.value)}
              onFocus={() => setFocused(true)}
              onBlur={() => setFocused(false)}
              onKeyDown={onKeyDown}
              aria-invalid={errors.jd ? true : undefined}
              aria-describedby={errors.jd ? "composer-jd-error" : "composer-hint"}
              placeholder="Paste the whole job posting here"
              className="text-ink placeholder:text-ink/40 w-full resize-none bg-transparent px-0.5 pb-1.5 text-[14.5px] leading-relaxed outline-none"
            />

            {noteOpen ? (
              <div className="pb-2">
                <label htmlFor="composer-note" className="sr-only">
                  Anything the posting does not say
                </label>
                <input
                  id="composer-note"
                  value={note}
                  onChange={(event) => setNote(event.target.value)}
                  onFocus={() => setFocused(true)}
                  onBlur={() => setFocused(false)}
                  onKeyDown={onKeyDown}
                  placeholder="Anything the posting does not say — who referred you, what the recruiter mentioned"
                  className="bg-tint-soft rounded-control placeholder:text-ink/40 w-full px-3 py-2 text-[13px] outline-none"
                />
              </div>
            ) : null}
          </>
        )}

        <div className="flex flex-wrap items-center gap-2">
          {!batch && !rewrite ? (
            <>
              <Popover
                open={open === "url"}
                onOpenChange={(next) => setOpen(next ? "url" : null)}
                label="Company website"
                trigger={
                  <Badge
                    icon={<GlobeIcon />}
                    tone={errors.companyUrl ? "trouble" : companyUrl.trim() === "" ? "faded" : "accent"}
                    aria-expanded={open === "url"}
                  >
                    {companyUrl.trim() === "" ? (
                      <>
                        <span className="sm:hidden">Website</span>
                        <span className="hidden sm:inline">Company website</span>
                      </>
                    ) : (
                      // The readable part, not the raw string: a badge sits in a row with two
                      // others and CSS truncation would spend its width on "https://www.".
                      glimpseUrl(companyUrl)
                    )}
                  </Badge>
                }
              >
                <input
                  autoFocus
                  value={companyUrl}
                  onChange={(event) => {
                    setCompanyUrl(event.target.value);
                    setErrors((previous) => ({ ...previous, companyUrl: undefined }));
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") setOpen(null);
                  }}
                  placeholder="vaultline.com"
                  className="bg-tint-soft rounded-control w-full px-3 py-2 text-sm outline-none"
                  aria-label="Company website"
                />
              </Popover>

              <Popover
                open={open === "days"}
                onOpenChange={(next) => setOpen(next ? "days" : null)}
                label="Days until the interview"
                trigger={
                  <Badge
                    icon={<CalendarIcon />}
                    tone={errors.days ? "trouble" : days.trim() === "" ? "faded" : "accent"}
                    aria-expanded={open === "days"}
                  >
                    <span className="sm:hidden">{dayShort}</span>
                    <span className="hidden sm:inline">{dayLong}</span>
                  </Badge>
                }
              >
                <div className="grid grid-cols-3 gap-1.5">
                  {DAY_PRESETS.map((preset) => {
                    const chosen = days.trim() === String(preset);
                    return (
                      <button
                        key={preset}
                        type="button"
                        aria-pressed={chosen}
                        onClick={() => {
                          setDays(String(preset));
                          setErrors((previous) => ({ ...previous, days: undefined }));
                          setOpen(null);
                        }}
                        className={`font-head h-9 rounded-[10px] text-sm font-semibold tabular-nums transition-colors ${
                          chosen
                            ? "bg-steel-500 text-white"
                            : "bg-tint text-ink/70 hover:bg-steel-100 hover:text-steel-700"
                        }`}
                      >
                        {preset}
                      </button>
                    );
                  })}
                </div>
                <input
                  type="number"
                  min={1}
                  max={365}
                  value={days}
                  onChange={(event) => {
                    setDays(event.target.value);
                    setErrors((previous) => ({ ...previous, days: undefined }));
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") setOpen(null);
                  }}
                  placeholder="Or any number, 1 to 365"
                  className="bg-tint-soft rounded-control mt-2 w-full px-3 py-2 text-sm outline-none"
                  aria-label="Days until the interview"
                />
              </Popover>

              {noteOpen ? null : (
                <Badge tone="faded" onClick={() => setNoteOpen(true)}>
                  + Add detail
                </Badge>
              )}
            </>
          ) : null}

          <div className="ml-auto flex shrink-0 items-center gap-2 sm:gap-3">
            {/* Only once the draft is a complete role. Offering it earlier would queue a blank. */}
            {!batch && !rewrite && draftFilled ? (
              <button
                type="button"
                onClick={addRole}
                className="bg-tint text-ink/70 hover:bg-steel-100 hover:text-steel-700 rounded-pill h-9 shrink-0 px-3.5 text-[13px] font-semibold transition-colors"
              >
                + Add another
              </button>
            ) : null}
            {/* Hidden on touch: there is no ⌘ to press, and a shortcut you cannot perform is
                furniture that costs width exactly where width is scarce. */}
            <span aria-hidden className="font-head text-ink/40 hidden text-[13px] tracking-wider md:inline">
              ⌘↵
            </span>
            <span className="group relative inline-flex">
              <Button
                variant="primary"
                onClick={() => void submit()}
                busy={busy}
                busyLabel={rewrite ? "Sending" : "Starting"}
                disabled={!ready}
                className={ready ? "" : "!bg-tint !text-ink/40"}
              >
                {rewrite ? "Send" : roleCount > 1 ? `Build ${roleCount} kits` : "Build the kit"}
              </Button>
              {rewrite || ready || queue.length > 0 ? null : (
                <span
                  role="tooltip"
                  className="bg-steel-900 pointer-events-none absolute right-0 bottom-full z-30 mb-2.5 w-56 rounded-[10px] px-3 py-2 text-xs leading-snug text-white opacity-0 transition-opacity group-hover:opacity-100"
                >
                  Still needs {listWords(missing)}.
                </span>
              )}
            </span>
          </div>
        </div>
      </div>

      <div className="flex flex-wrap items-baseline gap-3 px-1.5">
        {rewrite ? (
          // What survives, said where it can be read before the button is pressed rather than in
          // a tooltip. The second sentence is the one that makes this safe to press: the kit on
          // screen is not touched, so there is nothing to undo.
          <p id="composer-rewrite-hint" className="text-ink/55 min-w-0 flex-1 text-xs leading-relaxed">
            {rewriteKeeps(rewrite.section)} This produces a <strong className="font-semibold">new kit</strong>;
            the one you are looking at stays exactly as it is.
          </p>
        ) : errors.jd ? (
          <p id="composer-jd-error" role="alert" className="text-alarm text-xs font-medium">
            {errors.jd}
          </p>
        ) : errors.companyUrl ? (
          <p role="alert" className="text-alarm text-xs font-medium">
            {errors.companyUrl}
          </p>
        ) : errors.days ? (
          <p role="alert" className="text-alarm text-xs font-medium">
            {errors.days}
          </p>
        ) : (
          <p id="composer-hint" className="text-ink/55 text-xs">
            {queue.length > 0
              ? `${queue.length} ${queue.length === 1 ? "role" : "roles"} queued. Add another, or build them together.`
              : // What is still missing, in the open, rather than in a tooltip on the disabled
                // button. That tooltip needs a hover, and a phone has none — so the one place
                // that said which of the three inputs were outstanding was unreachable on the
                // device where the two badge-shaped ones are easiest to miss.
                missing.length > 0
                ? `Needs ${listWords(missing)}.`
                : "The whole posting works better than a summary."}
          </p>
        )}

        <span className={`ml-auto flex shrink-0 items-baseline gap-3 ${rewrite ? "hidden" : ""}`}>
          {/* "Several roles at once" used to open a file picker, which is the one thing a
              candidate with four tabs open does not want. It now adds a role to the queue, and
              the file upload is named for what it actually takes. */}
          {!batch ? (
            <button
              type="button"
              onClick={addRole}
              disabled={!draftFilled}
              title={
                draftFilled
                  ? "Queue this role and start another"
                  : "Fill in the posting, the site and the days first"
              }
              className="text-steel-600 hover:text-steel-800 text-xs font-medium underline-offset-4 hover:underline disabled:cursor-not-allowed disabled:text-ink/30 disabled:no-underline"
            >
              Several roles at once
            </button>
          ) : null}
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            className="text-ink/40 hover:text-ink/70 text-xs font-medium underline-offset-4 hover:underline"
          >
            Upload cases.json
          </button>
        </span>
        <input
          ref={fileRef}
          type="file"
          accept="application/json,.json"
          className="sr-only"
          aria-label="Upload a file of roles"
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) void onFile(file);
            event.target.value = "";
          }}
        />
      </div>
    </div>
  );
}


/**
 * A turn as the server will hand it back, built a moment before it does.
 *
 * `queued` rather than `running`: the API accepted it and has not necessarily started it, and
 * claiming otherwise would make the first tick of the progress line a correction.
 */
function turnFor(jobId: string, ask: SessionTurnView["ask"]): SessionTurnView {
  return {
    job_id: jobId,
    ask,
    // What the server will name this run. Only ever read when `ask` is null, which an optimistic
    // turn never is — set anyway, so the local shape matches the remote one field for field.
    label: ask === null ? "" : ask.kind === "posting" ? firstLine(ask.jd) : ask.prompt,
    status: "queued",
    kit_id: null,
    error: null,
    progress: null,
    created_at: Date.now(),
  };
}

/** A posting's first non-empty line, which is what the API labels the run with. */
function firstLine(jd: string): string {
  return (jd.split(/\r?\n/).find((line) => line.trim() !== "")?.trim() ?? "").slice(0, 80);
}

/** What went wrong, in words, with the offline case named rather than left as a fetch error. */
function messageFor(error: unknown): string {
  if (error instanceof ApiError && error.code === "NETWORK_UNREACHABLE") {
    return "You appear to be offline. Nothing was sent, and nothing was lost.";
  }
  return error instanceof Error ? error.message : "Could not start the run.";
}

/** "the job posting and how many days you have" — an Oxford-comma list, spoken. */
function listWords(items: string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")}, and ${items[items.length - 1]}`;
}

/**
 * A badge's popover.
 *
 * Closes on Escape and on a click outside, and the trigger keeps focus so tabbing out of the
 * popover lands where you were. Small enough to live here: it exists to serve two badges in one
 * component, and a shared popover primitive with no second caller is an abstraction pretending
 * to be reuse.
 */
function Popover({
  open,
  onOpenChange,
  label,
  trigger,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  label: string;
  trigger: React.ReactElement<{ onClick?: () => void }>;
  children: React.ReactNode;
}) {
  const wrap = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (!wrap.current?.contains(event.target as Node)) onOpenChange(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onOpenChange(false);
      }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, onOpenChange]);

  return (
    <span ref={wrap} className="relative inline-flex">
      <span onClick={() => onOpenChange(!open)}>{trigger}</span>
      {open ? (
        <div className="bg-surface rounded-card absolute bottom-full left-0 z-30 mb-2 w-56 p-2.5 shadow-[0_10px_30px_rgba(35,51,67,0.16),0_0_0_1px_rgba(35,51,67,0.06)]">
          <Eyebrow className="text-ink/40 block px-1 pb-2">{label}</Eyebrow>
          {children}
        </div>
      ) : null}
    </span>
  );
}
