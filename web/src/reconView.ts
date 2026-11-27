// What the recon panel says about a run's attack paths, kept apart from the markup so it can be tested.
import type { ReconChain, ReconState } from "../../shared/agent";

/** Attack paths that held, and the ones that stopped: leads, shown apart and never counted as findings. */
export function splitPaths(chains: readonly ReconChain[] | undefined): { demonstrated: ReconChain[]; partial: ReconChain[] } {
  const all = chains ?? [];
  return { demonstrated: all.filter((c) => c.status === "demonstrated"), partial: all.filter((c) => c.status === "partial") };
}

/** Ids of the attack paths that build on a finding, demonstrated ones first. */
export function pathsUsing(findingId: string | undefined, chains: readonly ReconChain[] | undefined): string[] {
  if (!findingId) return [];
  const { demonstrated, partial } = splitPaths(chains);
  return [...demonstrated, ...partial].filter((c) => c.links.includes(findingId)).map((c) => c.id).filter((id): id is string => Boolean(id));
}

/** Where a partial path stopped, in words. */
export function stoppedAt(c: ReconChain): string {
  const why = c.blockedWhy?.trim() || "not shown";
  return c.blockedAt ? `Stopped at step ${c.blockedAt}: ${why}` : `Not shown: ${why}`;
}

/** The round counter: the main loop's rounds, or the chain pass's turns once that has started. */
export function progressLabel(r: Pick<ReconState, "status" | "phase" | "rounds" | "maxRounds" | "chainRounds">): string {
  const running = r.status === "running";
  if (running && r.phase === "chains") return `chaining findings · turn ${(r.chainRounds ?? 0) + 1}`;
  const main = `round ${running ? r.rounds + 1 : r.rounds}/${r.maxRounds}`;
  return !running && r.chainRounds ? `${main} · ${r.chainRounds} chaining` : main;
}

/**
 * One line on why a finished run shows no attack paths, or that the pass was cut short.
 * Null when there is nothing to explain: the pass ran, or the run is still going.
 */
export function chainPassNote(r: Pick<ReconState, "status" | "chainPass" | "chains">): string | null {
  if (r.status !== "finished") return null;
  switch (r.chainPass) {
    case "ran": return r.chains?.length ? null : "No attack path was recorded.";
    case "off": return "Attack paths were not looked for: the chain pass was turned off for this run.";
    case "skipped": return "Attack paths were not looked for: the run ended before the chain pass.";
    case "few-findings": return "Attack paths were not looked for: it takes at least two findings to combine.";
    case "budget": return "Attack paths were not looked for: the token budget was spent.";
    case "no-paths": return "The findings were reviewed for attack paths and no combination was proposed.";
    case "rate-limited": return "The chain pass stopped: every model was rate-limited.";
    case "error": return "The chain pass stopped early. What it had recorded is shown.";
    default: return null; // a run from before the chain pass existed
  }
}
