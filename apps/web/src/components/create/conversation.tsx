"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { parseCasesJSON, type EvaluationCase } from "@trao/kit";
import { api } from "@/lib/api/client";
import { ApiError } from "@/lib/api/types";
import { guessCompany, guessTitle, normaliseCompanyUrl } from "@/lib/role-guess";
import { Button } from "@/components/industry/button";
import { TextArea, TextInput } from "@/components/industry/field";
import { Frame } from "@/components/industry/frame";
import { ErrorNotice } from "@/components/industry/states";
import { Eyebrow } from "@/components/industry/text";

/**
 * Intake as a conversation.
 *
 * The turns are scripted, not generated. The three things the kit needs — the description, the
 * company site, the days left — are fixed and knowable, and spending a model call and two
 * seconds of latency on "what is the URL?" would buy nothing a person could not read faster.
 * The model's job starts once this has what it needs. That also means intake never fails, never
 * rate-limits, and works with no API key.
 *
 * Each turn's composer is the typed control for the field being asked about: a textarea for the
 * description, a URL input for the site, a number input for the days. The conversation is the
 * arrangement; it does not cost the fields their types, their labels or their validation.
 */

type Stage = "jd" | "company" | "days" | "confirm" | "submitting";

interface Message {
  id: number;
  from: "assistant" | "user";
  text: string;
  /** Long pastes are echoed as a summary; the full text is already in `draft`. */
  detail?: string;
}

interface Draft {
  jd: string;
  companyUrl: string;
  days: number | null;
}

const GREETING =
  "What are you preparing for? Paste the job description — the whole posting works better than a summary, and nothing gets invented from what isn't there.";

export function CreateConversation() {
  const router = useRouter();
  const [stage, setStage] = useState<Stage>("jd");
  const [messages, setMessages] = useState<Message[]>([{ id: 0, from: "assistant", text: GREETING }]);
  const [draft, setDraft] = useState<Draft>({ jd: "", companyUrl: "", days: null });
  const [input, setInput] = useState("");
  const [fieldError, setFieldError] = useState<string | undefined>();
  const [submitError, setSubmitError] = useState<{ message: string; attempts: number } | null>(null);
  const [batch, setBatch] = useState<{ cases: EvaluationCase[]; fileName: string } | null>(null);
  const [caseErrors, setCaseErrors] = useState<string[]>([]);

  const nextId = useRef(1);
  const composerRef = useRef<HTMLTextAreaElement | HTMLInputElement>(null);
  const endRef = useRef<HTMLLIElement>(null);

  const say = useCallback((from: Message["from"], text: string, detail?: string) => {
    setMessages((previous) => [...previous, { id: nextId.current++, from, text, detail }]);
  }, []);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages, stage]);

  useEffect(() => {
    composerRef.current?.focus();
  }, [stage]);

  function advance(value: string) {
    setFieldError(undefined);

    if (stage === "jd") {
      const jd = value.trim();
      if (jd.length < 40) {
        setFieldError("That is very short for a posting. Paste a little more — a thin description makes a thin kit.");
        return;
      }
      const words = jd.split(/\s+/).length;
      const title = guessTitle(jd);
      setDraft((previous) => ({ ...previous, jd }));
      say("user", title || "Job description", `${words.toLocaleString()} words pasted`);
      say(
        "assistant",
        title
          ? `Got it — ${title}. What's the company's website?`
          : "Got it. What's the company's website?",
      );
      setInput("");
      setStage("company");
      return;
    }

    if (stage === "company") {
      const url = normaliseCompanyUrl(value);
      if (url === null) {
        setFieldError("That doesn't look like a web address. Something like vaultline.com is enough.");
        return;
      }
      setDraft((previous) => ({ ...previous, companyUrl: url }));
      say("user", url);
      say("assistant", "And how many days until the interview?");
      setInput("");
      setStage("days");
      return;
    }

    if (stage === "days") {
      const days = Number(value.trim());
      if (!Number.isInteger(days) || days < 1 || days > 365) {
        setFieldError("A whole number of days, from 1 to 365.");
        return;
      }
      setDraft((previous) => ({ ...previous, days }));
      say("user", days === 1 ? "1 day" : `${days} days`);
      say(
        "assistant",
        days === 1
          ? "One day is tight, so there'll be no schedule to spread — just the questions worth your evening, hardest first."
          : `${days} days. I'll front-load the hard material, so a day lost at the end costs less than a day lost at the start.`,
      );
      setInput("");
      setStage("confirm");
      return;
    }
  }

  async function onFile(file: File) {
    setCaseErrors([]);
    const text = await file.text();
    const parsed = parseCasesJSON(text);
    if (!parsed.ok) {
      setCaseErrors(parsed.errors);
      setBatch(null);
      return;
    }
    setBatch({ cases: parsed.cases, fileName: file.name });
    say("user", file.name, `${parsed.cases.length} ${parsed.cases.length === 1 ? "role" : "roles"}`);
    say(
      "assistant",
      `${parsed.cases.length} roles, each with its own day count. I'll build them all — you can watch them together on the next screen.`,
    );
    setStage("confirm");
  }

  async function submit() {
    setSubmitError(null);
    setStage("submitting");
    try {
      const response = batch
        ? await api.createBatch({ cases: batch.cases })
        : await api.createKit({ jd: draft.jd, company_url: draft.companyUrl, days: draft.days ?? 1 });
      router.push(`/generating?jobs=${response.job_ids.join(",")}`);
    } catch (error) {
      const message =
        error instanceof ApiError && error.code === "NETWORK_UNREACHABLE"
          ? "You appear to be offline. Nothing was sent, and nothing was lost."
          : error instanceof Error
            ? error.message
            : "Could not start the run.";
      setSubmitError((previous) => ({ message, attempts: (previous?.attempts ?? 0) + 1 }));
      setStage("confirm");
    }
  }

  function restart() {
    setStage("jd");
    setMessages([{ id: nextId.current++, from: "assistant", text: GREETING }]);
    setDraft({ jd: "", companyUrl: "", days: null });
    setBatch(null);
    setCaseErrors([]);
    setSubmitError(null);
    setInput("");
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-6">
      <ol className="flex list-none flex-col gap-6" aria-live="polite" aria-relevant="additions">
        {messages.map((message) => (
          <li key={message.id} className={message.from === "user" ? "flex justify-end" : ""}>
            {message.from === "assistant" ? (
              <div className="flex max-w-read flex-col gap-1">
                <Eyebrow className="text-teal-700">Prep kit</Eyebrow>
                <p className="text-lg leading-snug">{message.text}</p>
              </div>
            ) : (
              <Frame className="flex max-w-read flex-col gap-1 px-4 py-3" marks={false}>
                <p className="text-base leading-relaxed">{message.text}</p>
                {message.detail ? (
                  <p className="text-xs tabular-nums opacity-55">{message.detail}</p>
                ) : null}
              </Frame>
            )}
          </li>
        ))}
        <li ref={endRef} aria-hidden />
      </ol>

      {caseErrors.length > 0 ? (
        <ErrorNotice title="That file could not be read" actions={null}>
          <ul className="flex list-none flex-col gap-1">
            {caseErrors.slice(0, 6).map((error) => (
              <li key={error} className="font-medium">
                {error}
              </li>
            ))}
          </ul>
          <p className="mt-2 opacity-70">
            It should be the same shape as the batch input: a list of{" "}
            <code className="text-xs">{`{ id, jd, company_url, days }`}</code>.
          </p>
        </ErrorNotice>
      ) : null}

      {submitError ? (
        <ErrorNotice
          title="Could not start the run"
          attempts={submitError.attempts}
          actions={
            <Button variant="primary" onClick={submit}>
              Try again
            </Button>
          }
        >
          {submitError.message}
        </ErrorNotice>
      ) : null}

      <Composer
        stage={stage}
        input={input}
        error={fieldError}
        batch={batch}
        draft={draft}
        composerRef={composerRef}
        onInput={setInput}
        onSend={advance}
        onFile={onFile}
        onSubmit={submit}
        onRestart={restart}
      />
    </div>
  );
}

function Composer({
  stage,
  input,
  error,
  batch,
  draft,
  composerRef,
  onInput,
  onSend,
  onFile,
  onSubmit,
  onRestart,
}: {
  stage: Stage;
  input: string;
  error?: string;
  batch: { cases: EvaluationCase[]; fileName: string } | null;
  draft: Draft;
  composerRef: React.RefObject<HTMLTextAreaElement | HTMLInputElement | null>;
  onInput: (value: string) => void;
  onSend: (value: string) => void;
  onFile: (file: File) => void;
  onSubmit: () => void;
  onRestart: () => void;
}) {
  const fileRef = useRef<HTMLInputElement>(null);

  if (stage === "confirm" || stage === "submitting") {
    return (
      <Frame className="flex flex-col gap-4 p-4">
        <Eyebrow className="text-teal-700">Ready</Eyebrow>
        {batch ? (
          <p className="max-w-read text-base leading-relaxed">
            <strong className="font-medium">{batch.cases.length} roles</strong> from {batch.fileName}.
          </p>
        ) : (
          <dl className="flex max-w-read flex-col gap-2 text-sm">
            <Summary label="Role" value={guessTitle(draft.jd) || "Untitled role"} />
            <Summary label="Company" value={guessCompany(draft.companyUrl) || draft.companyUrl} />
            <Summary label="Days" value={draft.days === 1 ? "1 day" : `${draft.days} days`} />
          </dl>
        )}
        <div className="flex flex-wrap gap-3">
          <Button variant="primary" onClick={onSubmit} busy={stage === "submitting"} busyLabel="Starting">
            {batch ? `Build ${batch.cases.length} kits` : "Build the kit"}
          </Button>
          <Button variant="ghost" onClick={onRestart} disabled={stage === "submitting"}>
            Start over
          </Button>
        </div>
      </Frame>
    );
  }

  const send = () => onSend(input);

  /** Enter sends, Shift+Enter is a newline — the convention every chat composer already uses. */
  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      send();
    }
  };

  return (
    <div className="bg-paper border-divider sticky bottom-0 flex flex-col gap-3 border-t pt-4 pb-4">
      {stage === "jd" ? (
        <TextArea
          ref={composerRef as React.RefObject<HTMLTextAreaElement>}
          label="Job description"
          hint="Enter to send · Shift+Enter for a new line"
          error={error}
          rows={6}
          value={input}
          placeholder="Paste the posting…"
          onChange={(event) => onInput(event.target.value)}
          onKeyDown={onKeyDown}
        />
      ) : stage === "company" ? (
        <TextInput
          ref={composerRef as React.RefObject<HTMLInputElement>}
          label="Company website"
          type="url"
          inputMode="url"
          autoComplete="url"
          error={error}
          value={input}
          placeholder="vaultline.com"
          onChange={(event) => onInput(event.target.value)}
          onKeyDown={onKeyDown}
        />
      ) : (
        <TextInput
          ref={composerRef as React.RefObject<HTMLInputElement>}
          label="Days until the interview"
          type="number"
          inputMode="numeric"
          min={1}
          max={365}
          error={error}
          value={input}
          placeholder="4"
          onChange={(event) => onInput(event.target.value)}
          onKeyDown={onKeyDown}
        />
      )}

      <div className="flex flex-wrap items-center gap-3">
        <Button variant="primary" onClick={send} disabled={input.trim() === ""}>
          Send
        </Button>

        {stage === "jd" ? (
          <>
            <Button variant="ghost" onClick={() => fileRef.current?.click()}>
              Several roles at once
            </Button>
            <input
              ref={fileRef}
              type="file"
              accept="application/json,.json"
              className="sr-only"
              aria-label="Upload a roles file"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) void onFile(file);
                event.target.value = "";
              }}
            />
          </>
        ) : null}
      </div>
    </div>
  );
}

function Summary({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-3">
      <dt className="w-20 shrink-0 text-xs tracking-widest uppercase opacity-55">{label}</dt>
      <dd className="font-medium">{value}</dd>
    </div>
  );
}
