/**
 * Getting JSON out of what a model actually returns.
 *
 * Tried before spending a repair call, because it is free. Models wrap JSON in prose or in a
 * fenced block far more often than they produce genuinely malformed JSON, and paying a request
 * from a 250-a-day quota to fix a pair of backticks would be careless.
 */

export function extractJson(text: string): unknown {
  const trimmed = text.trim();

  const direct = tryParse(trimmed);
  if (direct.ok) return direct.value;

  // ```json … ``` or plain ``` … ```
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  if (fenced?.[1] !== undefined) {
    const parsed = tryParse(fenced[1].trim());
    if (parsed.ok) return parsed.value;
  }

  // Prose either side of a single object or array.
  const firstBrace = trimmed.search(/[[{]/);
  const lastBrace = Math.max(trimmed.lastIndexOf("}"), trimmed.lastIndexOf("]"));
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    const parsed = tryParse(trimmed.slice(firstBrace, lastBrace + 1));
    if (parsed.ok) return parsed.value;
  }

  throw new SyntaxError(`Model output was not JSON: ${preview(trimmed)}`);
}

function tryParse(text: string): { ok: true; value: unknown } | { ok: false } {
  if (text.length === 0) return { ok: false };
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false };
  }
}

function preview(text: string): string {
  return text.length <= 200 ? text : `${text.slice(0, 200)}…`;
}
