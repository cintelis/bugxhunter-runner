/**
 * What the commands of a recon run really returned, kept so a verdict can be held to it.
 *
 * The verifier is a model: it is shown the executor's account of a response, and could be
 * shown a paraphrase or an invention. So it is asked to quote the response, and the quotes
 * are looked up here, in the output the run's own shell commands produced (which the runner
 * reads from the agent's event stream, not from anything a model wrote). A quote that is
 * found proves the text was really returned to this run; it does not prove the finding.
 *
 * Pure and in memory: the log lives as long as the run.
 */

/** A quote shorter than this (after whitespace is collapsed) proves nothing: "200", "true", "admin". */
export const MIN_QUOTE = 12;
const MAX_OUTPUT = 400_000;
const MAX_TOTAL = 8_000_000;
const MAX_QUOTES = 5;

/**
 * How a verdict's quotes fared: `quoted` (every usable quote was found in this run's
 * output), `unmatched` (at least one was not: paraphrased, or made up), `unquoted` (none
 * was given, or none long enough to mean anything).
 */
export type Proof = "quoted" | "unmatched" | "unquoted";

/** Whitespace collapsed, so a wrapped or re-indented copy of a response still matches. Case is kept. */
export const normalise = (text: string): string => text.replace(/\s+/g, " ").trim();

export class EvidenceLog {
  private readonly outputs: string[] = [];
  private total = 0;
  /** How many command outputs are held. */
  get size(): number { return this.outputs.length; }

  /** Record one command's output. The oldest are dropped once the log is full. */
  add(output: string): void {
    const text = normalise(String(output ?? "").slice(0, MAX_OUTPUT));
    if (!text) return;
    this.outputs.push(text);
    this.total += text.length;
    while (this.total > MAX_TOTAL && this.outputs.length > 1) this.total -= this.outputs.shift()!.length;
  }

  /** Was this text really returned by a command of this run? */
  has(quote: string): boolean {
    const q = normalise(quote);
    return q.length >= MIN_QUOTE && this.outputs.some((o) => o.includes(q));
  }

  /** Hold a verdict's quotes to the log. */
  check(quotes: readonly string[] | undefined): Proof {
    const usable = (quotes ?? []).filter((q) => normalise(q).length >= MIN_QUOTE);
    if (!usable.length) return "unquoted";
    return usable.every((q) => this.has(q)) ? "quoted" : "unmatched";
  }
}

/** The quotes of a verdict as the verifier wrote them: strings only, a handful, each of bounded length. */
export function readQuotes(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((q): q is string => typeof q === "string" && Boolean(q.trim())).slice(0, MAX_QUOTES).map((q) => q.slice(0, 600));
}
