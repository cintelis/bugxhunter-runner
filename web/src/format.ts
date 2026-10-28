/** Human-readable sizes and token counts for pills and chips. */

export function formatBytes(n: number) {
  if (n >= 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + " MB";
  if (n >= 1024) return Math.round(n / 1024) + " KB";
  return n + " B";
}

export function formatTokens(n: number) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(n % 1_000_000 ? 1 : 0) + "M";
  if (n >= 1000) return Math.round(n / 1000) + "k";
  return String(n);
}

const secs = (ms: number) => (ms < 10_000 ? (ms / 1000).toFixed(1) : Math.round(ms / 1000)) + "s";

/**
 * "1.2s to first token · 48 tok/s · 3.4s total" for an assistant turn. Throughput is the
 * completion tokens over the generation window (first token to end), so a slow cold start
 * shows up in the first-token time rather than dragging the rate down. Reasoning models are
 * the exception: their hidden reasoning tokens count as completion tokens but are produced
 * before the first visible one, so for them the rate is taken over the whole turn.
 */
export function formatTiming(t: { ttft?: number; total: number }, completionTokens?: number, reasoningTokens?: number) {
  const parts: string[] = [];
  if (t.ttft !== undefined) parts.push(`${secs(t.ttft)} to first token`);
  const window = reasoningTokens ? t.total : t.total - (t.ttft ?? 0);
  if (completionTokens && window > 50) parts.push(`${Math.round(completionTokens / (window / 1000))} tok/s`);
  parts.push(`${secs(t.total)} total`);
  return parts.join(" · ");
}
