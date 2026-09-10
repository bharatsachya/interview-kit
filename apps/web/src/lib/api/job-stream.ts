"use client";

import { useEffect, useState } from "react";
import type { JobProgress, JobRecord, Span } from "@trao/contracts";
import { API_BASE_URL, api } from "./client";

/**
 * Watch one job: server-sent events, falling back to polling if the stream will not hold.
 *
 * The fallback is not defensive decoration. Free hosts buffer or kill long responses, and a
 * stalled stream and a finished job look identical from the client — so the stream is given two
 * chances and then abandoned in favour of the polling endpoint, which returns the same shapes.
 * Neither transport is the "real" one; the state they produce is identical either way.
 *
 * Spans are appended by id rather than by index, so a reconnect that replays from the start
 * cannot duplicate rows.
 *
 * This hook holds no reset logic on purpose. Mount it with `key={jobId}` and a new job is a new
 * component — which is both simpler than resetting five pieces of state and impossible to get
 * half-right.
 */

const POLL_MS = 2000;
const STREAM_ATTEMPTS = 2;

export type Transport = "stream" | "polling";

export interface JobStreamState {
  spans: Span[];
  job: JobRecord | null;
  /** The step currently in flight, announced before it runs. */
  progress: JobProgress | null;
  label: string;
  transport: Transport;
  /** Set only when neither transport can reach the job at all. */
  error: string | null;
}

export function useJobStream(jobId: string): JobStreamState {
  const [spans, setSpans] = useState<Span[]>([]);
  const [job, setJob] = useState<JobRecord | null>(null);
  const [progress, setProgress] = useState<JobProgress | null>(null);
  const [label, setLabel] = useState("");
  const [transport, setTransport] = useState<Transport>("stream");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let disposed = false;
    let source: EventSource | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let attempts = 0;

    /**
     * Upsert, not append.
     *
     * The same span arrives twice or more: once when it opens, with no duration and no
     * attributes, and again as it changes. Ignoring the repeat — which this did — left every
     * step stuck on "running" for the life of the run. Order is by first sight, so a step does
     * not jump position when it finishes.
     */
    const addSpan = (span: Span) => {
      setSpans((previous) => {
        const index = previous.findIndex((existing) => existing.id === span.id);
        if (index === -1) return [...previous, span];
        const next = [...previous];
        next[index] = span;
        return next;
      });
    };

    const settled = (record: JobRecord) => record.status === "done" || record.status === "failed";

    function startPolling() {
      if (disposed) return;
      setTransport("polling");

      const tick = async () => {
        if (disposed) return;
        try {
          const view = await api.getJob(jobId);
          if (disposed) return;
          setError(null);
          setLabel(view.label);
          for (const span of view.spans) addSpan(span);
          setJob(view.job);
          setProgress(view.job.progress);
          if (!settled(view.job)) timer = setTimeout(tick, POLL_MS);
        } catch (cause) {
          if (disposed) return;
          setError(cause instanceof Error ? cause.message : "Lost contact with the run.");
          timer = setTimeout(tick, POLL_MS);
        }
      };

      void tick();
    }

    function startStream() {
      if (disposed) return;
      attempts += 1;
      source = new EventSource(`${API_BASE_URL}/jobs/${encodeURIComponent(jobId)}/stream`);

      source.addEventListener("progress", (event) => {
        setProgress(JSON.parse((event as MessageEvent<string>).data) as JobProgress);
      });

      source.addEventListener("span", (event) => {
        addSpan(JSON.parse((event as MessageEvent<string>).data) as Span);
        setError(null);
      });

      source.addEventListener("done", (event) => {
        const payload = JSON.parse((event as MessageEvent<string>).data) as { job: JobRecord; label: string };
        setJob(payload.job);
        setLabel(payload.label);
        source?.close();
      });

      source.addEventListener("error", (event) => {
        // Two shapes arrive on this listener: the server's own `error` event, which carries a
        // payload, and the transport giving up, which does not.
        const data = (event as MessageEvent<string | undefined>).data;
        if (typeof data === "string") {
          const payload = JSON.parse(data) as { message?: string };
          setError(payload.message ?? "That run could not be found.");
          source?.close();
          return;
        }

        source?.close();
        if (disposed) return;
        if (attempts < STREAM_ATTEMPTS) startStream();
        else startPolling();
      });
    }

    startStream();

    return () => {
      disposed = true;
      source?.close();
      if (timer) clearTimeout(timer);
    };
  }, [jobId]);

  return { spans, job, progress, label, transport, error };
}
