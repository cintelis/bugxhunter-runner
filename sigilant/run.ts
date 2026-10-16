// Starts a governed run on the runner, with nobody at the keyboard: a session
// in the engagement's folder, and the prompt. What a webhook will do when a
// pull request opens; for now, a command.
//
//   node sigilant/run.ts --pr cintelis/sigilant#42
//   node sigilant/run.ts --prompt "Test what the last deploy changed on erp:9443."
//
// | Variable | |
// |---|---|
// | `BXH_RUNNER` | the runner's API: `http://bxh-runner:8790` unless set |
// | `BXH_DIRECTORY` | the engagement's folder in the workspace: `/workspace/engagement` unless set |
// | `BXH_MODEL` | the model, as OpenCode names it; the runner's default unless set |

export interface Run {
  directory: string;
  text: string;
  agent?: string;
  model?: string;
}

/** The prompt a pull request opening starts. */
export function reviewPrompt(repo: string, pr: number): string {
  return [
    `Review pull request #${pr} of ${repo} for security issues, as a governed run.`,
    `Read its diff with repo.read (repo "${repo}", pr ${pr}), and the files it touches where you need the context.`,
    "Record each finding with finding.record at a severity, then comment on the pull request with repo.comment: one summary, findings first, each with the file and what to change.",
    "If a finding is critical, block the merge with repo.block and say that a tester confirms it.",
    "Do nothing outside this pull request.",
  ].join(" ");
}

/** Starts the run: the session, then the prompt. Returns the session's id. */
export async function startRun(runner: string, run: Run, fetchImpl: typeof fetch = fetch): Promise<string> {
  const post = async (path: string, body: unknown) => {
    const response = await fetchImpl(`${runner}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const text = await response.text();
    if (!response.ok) throw new Error(`${path}: HTTP ${response.status}: ${text.slice(0, 200)}`);
    return JSON.parse(text) as Record<string, unknown>;
  };
  const session = await post("/api/agent/session", { directory: run.directory });
  const sessionID = String(session.id);
  await post("/api/agent/prompt", {
    sessionID,
    directory: run.directory,
    text: run.text,
    agent: run.agent ?? "build",
    ...(run.model ? { model: run.model } : {}),
  });
  return sessionID;
}

/** `owner/name#number`, or nothing. */
export function parsePr(s: string): { repo: string; pr: number } | undefined {
  const m = /^([A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9_.-]+)#(\d{1,9})$/.exec(s.trim());
  return m ? { repo: m[1]!, pr: Number(m[2]) } : undefined;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const at = (flag: string) => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const pr = at("--pr");
  const prompt = at("--prompt");
  const parsed = pr ? parsePr(pr) : undefined;
  if ((pr && !parsed) || (!parsed && !prompt)) {
    console.error("usage: node sigilant/run.ts --pr owner/name#number | --prompt <text>");
    process.exit(2);
  }
  const text = parsed ? reviewPrompt(parsed.repo, parsed.pr) : prompt!;
  const runner = process.env.BXH_RUNNER?.trim() || "http://bxh-runner:8790";
  const directory = process.env.BXH_DIRECTORY?.trim() || "/workspace/engagement";
  const id = await startRun(runner, { directory, text, model: process.env.BXH_MODEL?.trim() || undefined });
  console.log(`started session ${id} in ${directory} on ${runner}`);
}
