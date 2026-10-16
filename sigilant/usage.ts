// What a run cost, reported as it goes: the runner's own process follows the
// session on the runner and, after each step — each turn of the model — calls
// `run.usage` through the gateway with what OpenCode counted for it: tokens,
// cost, when it began and ended, how many tools it called. The gateway's
// record of the call is the usage; the sync service folds the steps into runs
// and the console shows each run as a tree. It is the runner's word on
// itself, in a signed record — not the provider's.

/** What the runner's API says of a message, as much of it as is read here. */
export interface Message {
  id: string;
  role: string;
  parts?: { type: string; status?: string }[];
  tokens?: { input?: number; output?: number; reasoning?: number; cache?: { read?: number; write?: number } };
  cost?: number;
  model?: string;
  time?: { created?: number; completed?: number };
}

/** One step's usage, as `run.usage` takes it. */
export interface StepUsage {
  run: string;
  step: string;
  model?: string;
  input: number;
  output: number;
  reasoning: number;
  cache_read: number;
  cache_write: number;
  /** Millionths of a dollar. */
  cost_micros: number;
  started_ms: number;
  completed_ms: number;
  tool_calls: number;
}

const whole = (n: unknown) => (typeof n === "number" && Number.isFinite(n) && n > 0 ? Math.round(n) : 0);

/**
 * The steps of `run` among its messages: each assistant message that has
 * finished — OpenCode sets `time.completed` then, with the counts final —
 * in the order they began. One still going is not a step yet.
 */
export function stepsOf(run: string, messages: Message[]): StepUsage[] {
  return messages
    .filter((m) => m.role === "assistant" && m.time?.completed)
    .map((m) => ({
      run,
      step: m.id,
      ...(m.model ? { model: m.model } : {}),
      input: whole(m.tokens?.input),
      output: whole(m.tokens?.output),
      reasoning: whole(m.tokens?.reasoning),
      cache_read: whole(m.tokens?.cache?.read),
      cache_write: whole(m.tokens?.cache?.write),
      cost_micros: whole((m.cost ?? 0) * 1_000_000),
      started_ms: whole(m.time?.created) || whole(m.time?.completed),
      completed_ms: whole(m.time?.completed),
      tool_calls: (m.parts ?? []).filter((p) => p.type === "tool").length,
    }))
    .sort((a, b) => a.started_ms - b.started_ms);
}

export interface FollowOptions {
  fetchImpl?: typeof fetch;
  log?: (line: string) => void;
  /** How often, at most, the messages are read while the run goes on: 30 s unless set. */
  everyMs?: number;
  /** How long a run is followed for before it is given up on: 2 h unless set. */
  forMs?: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Follows `run` on the runner until it is idle, reporting each step once, as
 * it completes, through `report`; what was reported, in order. The runner's
 * event stream says when the session goes idle; while it goes on, the
 * messages are read every `everyMs` so that a long run is reported as it
 * runs. A stream that drops is opened again until `forMs` is up, and what
 * is there by then is reported.
 */
export async function followRun(
  runner: string,
  run: string,
  directory: string,
  report: (step: StepUsage) => Promise<void>,
  options: FollowOptions = {},
): Promise<StepUsage[]> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const log = options.log ?? (() => {});
  const everyMs = options.everyMs ?? 30_000;
  const deadline = Date.now() + (options.forMs ?? 2 * 60 * 60 * 1000);
  const reported: StepUsage[] = [];
  const seen = new Set<string>();
  let lastSweep = 0;

  const sweep = async () => {
    lastSweep = Date.now();
    const response = await fetchImpl(`${runner}/api/agent/session/${encodeURIComponent(run)}/messages?directory=${encodeURIComponent(directory)}`);
    if (!response.ok) throw new Error(`messages: HTTP ${response.status}`);
    const { messages } = (await response.json()) as { messages: Message[] };
    for (const step of stepsOf(run, messages)) {
      if (seen.has(step.step)) continue;
      seen.add(step.step);
      await report(step);
      reported.push(step);
    }
  };

  let idle = false;
  while (!idle && Date.now() < deadline) {
    try {
      const response = await fetchImpl(`${runner}/api/agent/events?sessionID=${encodeURIComponent(run)}&directory=${encodeURIComponent(directory)}`, {
        signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())),
      });
      if (!response.ok || !response.body) throw new Error(`events: HTTP ${response.status}`);
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let at: number;
        while ((at = buffer.indexOf("\n\n")) >= 0) {
          const frame = buffer.slice(0, at);
          buffer = buffer.slice(at + 2);
          for (const line of frame.split("\n")) {
            if (!line.startsWith("data: ")) continue;
            const event = JSON.parse(line.slice(6)) as { kind: string; sessionID?: string; subagent?: string; message?: string };
            if (event.kind === "idle" && !event.subagent && (!event.sessionID || event.sessionID === run)) idle = true;
            else if (event.kind === "error") log(`the runner reported an error: ${event.message}`);
          }
        }
        if (idle) {
          await reader.cancel().catch(() => {});
          break;
        }
        if (Date.now() - lastSweep >= everyMs) await sweep().catch((why: Error) => log(`reading the run's messages failed (${why.message}); again later`));
      }
      if (!idle) log("the runner's event stream ended before the run was idle; listening again");
    } catch (why) {
      if (Date.now() >= deadline) break;
      log(`following the run failed (${(why as Error).message}); again in a moment`);
      await sleep(2_000);
    }
  }
  if (!idle) log(`gave up following ${run} after ${Math.round((options.forMs ?? 2 * 60 * 60 * 1000) / 60_000)} minutes; reporting what is there`);
  await sweep();
  return reported;
}

/** One line on a step, for the log. */
export function describeStep(step: StepUsage): string {
  const dollars = (step.cost_micros / 1_000_000).toFixed(4);
  return `${step.step}: ${step.model ?? "model unsaid"}, ${step.input} in, ${step.output} out, $${dollars}, ${((step.completed_ms - step.started_ms) / 1000).toFixed(1)} s, ${step.tool_calls} tool call${step.tool_calls === 1 ? "" : "s"}`;
}
