"use client";

import { useRef, useState } from "react";
import { parseCasesJSON, type EvaluationCase } from "@trao/kit";
import { api } from "@/lib/api/client";
import { ApiError } from "@/lib/api/types";
import { normaliseCompanyUrl } from "@/lib/role-guess";
import { Button } from "@/components/industry/button";
import { TextArea, TextInput } from "@/components/industry/field";
import { Frame } from "@/components/industry/frame";
import { ErrorNotice } from "@/components/industry/states";

/**
 * The composer: a job description, a company site, the days left, and a file for several roles
 * at once.
 *
 * Centred on an empty workspace, the way a chat opens, then docked to the bottom once there is
 * a conversation above it. Same component either way — the fields are identical and only the
 * framing changes, so nothing about the form can drift between the two placements.
 *
 * The description is the primary input and gets the room to say so. The other two are single
 * lines because they are a URL and a number.
 */
export function Composer({
  variant,
  onStarted,
}: {
  variant: "centred" | "docked";
  onStarted: (jobIds: string[]) => void;
}) {
  const [jd, setJd] = useState("");
  const [companyUrl, setCompanyUrl] = useState("");
  const [days, setDays] = useState("");
  const [batch, setBatch] = useState<{ cases: EvaluationCase[]; fileName: string } | null>(null);

  const [errors, setErrors] = useState<{ jd?: string; companyUrl?: string; days?: string }>({});
  const [fileErrors, setFileErrors] = useState<string[]>([]);
  const [submitError, setSubmitError] = useState<{ message: string; attempts: number } | null>(null);
  const [busy, setBusy] = useState(false);

  const fileRef = useRef<HTMLInputElement>(null);
  const centred = variant === "centred";

  async function submit() {
    setSubmitError(null);

    if (batch) {
      await start(() => api.createBatch({ cases: batch.cases }));
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

    await start(() => api.createKit({ jd: trimmedJd, company_url: url, days: dayCount }));
  }

  async function start(request: () => Promise<{ job_ids: string[] }>) {
    setBusy(true);
    try {
      const response = await request();
      onStarted(response.job_ids);
      setJd("");
      setCompanyUrl("");
      setDays("");
      setBatch(null);
    } catch (error) {
      const message =
        error instanceof ApiError && error.code === "NETWORK_UNREACHABLE"
          ? "You appear to be offline. Nothing was sent, and nothing was lost."
          : error instanceof Error
            ? error.message
            : "Could not start the run.";
      setSubmitError((previous) => ({ message, attempts: (previous?.attempts ?? 0) + 1 }));
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

  return (
    <div className={centred ? "flex flex-col gap-6" : "flex flex-col gap-3"}>
      {centred ? (
        <div className="flex flex-col gap-3">
          <h1 className="text-4xl tracking-tight">What are you preparing for?</h1>
          <p className="max-w-read text-base opacity-70">
            Paste the posting, tell us where they live on the web, and how long you have.
          </p>
        </div>
      ) : null}

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
            It should be a list of <code className="text-xs">{`{ id, jd, company_url, days }`}</code> — the
            same shape the batch runner takes.
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

      <Frame className="flex flex-col gap-4 p-4" marks={centred}>
        {batch ? (
          <div className="flex flex-wrap items-center gap-3">
            <span className="text-sm">
              <strong className="font-medium">{batch.cases.length} roles</strong> from {batch.fileName}
            </span>
            <Button variant="ghost" onClick={() => setBatch(null)}>
              Remove
            </Button>
          </div>
        ) : (
          <>
            <TextArea
              label="Job description"
              hint={centred ? "The whole posting works better than a summary." : undefined}
              error={errors.jd}
              rows={centred ? 8 : 3}
              value={jd}
              placeholder="Paste the posting…"
              onChange={(event) => setJd(event.target.value)}
              onKeyDown={onKeyDown}
            />

            <div className="flex flex-col gap-4 md:flex-row">
              <div className="flex-1">
                <TextInput
                  label="Company website"
                  type="url"
                  inputMode="url"
                  autoComplete="url"
                  error={errors.companyUrl}
                  value={companyUrl}
                  placeholder="vaultline.com"
                  onChange={(event) => setCompanyUrl(event.target.value)}
                  onKeyDown={onKeyDown}
                />
              </div>
              <div className="md:w-40">
                <TextInput
                  label="Days until the interview"
                  type="number"
                  inputMode="numeric"
                  min={1}
                  max={365}
                  error={errors.days}
                  value={days}
                  placeholder="4"
                  onChange={(event) => setDays(event.target.value)}
                  onKeyDown={onKeyDown}
                />
              </div>
            </div>
          </>
        )}

        <div className="flex flex-wrap items-center gap-3">
          <Button variant="primary" onClick={() => void submit()} busy={busy} busyLabel="Starting">
            {batch ? `Build ${batch.cases.length} kits` : "Build the kit"}
          </Button>
          <span className="text-xs opacity-45">⌘↵</span>

          <Button variant="ghost" onClick={() => fileRef.current?.click()} className="ml-auto">
            Several roles at once
          </Button>
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
      </Frame>
    </div>
  );
}
