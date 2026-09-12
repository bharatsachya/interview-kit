/**
 * Wire-level helpers shared by the OpenAI-shaped transports.
 *
 * Three providers now sit behind `ModelTransport`, and two of them — OpenRouter and Z.AI —
 * speak the same `/chat/completions` dialect. What they genuinely share is small and boring:
 * how to read a `Retry-After`, how to read a body without letting a second failure mask the
 * first, and how to name an error. Everything that actually differs between them — which codes
 * mean "try the next model", which body fields carry the answer, what each one does with a
 * reasoning budget — stays in its own file, where it can be read next to the measurement that
 * justifies it.
 *
 * This is deliberately not a base class. A shared parent for two providers whose every
 * interesting branch differs would move the differences out of sight without removing any of
 * them, and the error classification is the part most worth reading.
 */

/** `Retry-After` in seconds or as a date. Honoured over the backoff schedule when present. */
export function retryAfterMs(response: Response): number | undefined {
  const header = response.headers.get("retry-after");
  if (header === null) return undefined;

  const seconds = Number.parseFloat(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);

  const asDate = Date.parse(header);
  return Number.isFinite(asDate) ? Math.max(0, asDate - Date.now()) : undefined;
}

/**
 * The body of a failed response, truncated, and never throwing.
 *
 * A provider that has just returned 502 is entitled to return an unreadable body with it. If
 * reading it threw, the error the caller saw would be about the body rather than about the 502.
 */
export async function safeText(response: Response): Promise<string> {
  try {
    return (await response.text()).slice(0, 300);
  } catch {
    return "(no body)";
  }
}

export function describe(error: unknown): string {
  if (error instanceof Error) return error.name === "TimeoutError" ? "timed out" : error.message;
  return String(error);
}
