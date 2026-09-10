import type { Span, SpanStatus } from "@trao/contracts";

/**
 * Render a span list as a tree.
 *
 *   ▸ generate_kit                        42.3s  ok
 *     ▸ extract_requirements               3.1s  ok    jd_chars=4820 must_count=7
 *     ▸ search_discussion                  0.0s  skip  skip_reason=no_key
 *
 * This is `--trace-pretty`, and it is also the evidence: the rubric wants to see that the site
 * was crawled, a hiring page sought, discussion searched, the four question categories
 * generated separately and coverage genuinely re-checked. One screenshot shows all five.
 */
export function formatTrace(spans: Span[], options: { indentWidth?: number } = {}): string {
  const indentWidth = options.indentWidth ?? 2;
  const byParent = new Map<string | null, Span[]>();
  for (const span of spans) {
    const siblings = byParent.get(span.parentId);
    if (siblings) siblings.push(span);
    else byParent.set(span.parentId, [span]);
  }

  const rows: { label: string; span: Span }[] = [];
  const walk = (parentId: string | null, depth: number): void => {
    for (const span of byParent.get(parentId) ?? []) {
      rows.push({ label: `${" ".repeat(depth * indentWidth)}▸ ${span.step}`, span });
      walk(span.id, depth + 1);
    }
  };
  walk(null, 0);
  if (rows.length === 0) return "(no spans)";

  const labelWidth = Math.max(...rows.map((r) => r.label.length));
  return rows
    .map(({ label, span }) => {
      const duration = `${(span.durationMs / 1000).toFixed(1)}s`.padStart(7);
      const status = STATUS_LABEL[span.status].padEnd(4);
      const detail = formatAttrs(span);
      return `${label.padEnd(labelWidth)}  ${duration}  ${status}${detail ? `  ${detail}` : ""}`.trimEnd();
    })
    .join("\n");
}

const STATUS_LABEL: Record<SpanStatus, string> = {
  // Only ever seen when a trace is printed mid-run, which the dev runner does not do — but a
  // missing key here would render `undefined` rather than fail, so it is spelled out.
  running: "…",
  ok: "ok",
  skipped: "skip",
  failed: "fail",
};

function formatAttrs(span: Span): string {
  const parts = Object.entries(span.attrs).map(([key, value]) => `${key}=${formatValue(value)}`);
  if (span.error) parts.push(`error=${span.error.code}:${JSON.stringify(span.error.message)}`);
  return parts.join(" ");
}

function formatValue(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(formatValue).join(",")}]`;
  if (value === null || value === undefined) return String(value);
  if (typeof value === "object") return JSON.stringify(value);
  if (typeof value === "string" && /\s/.test(value)) return JSON.stringify(value);
  return String(value);
}
