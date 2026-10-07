/** Client for the read-only GitHub integration (server routes under /api/github). */
import type { CloneRequest, CloneResult, GitHubBranch, GitHubRepo, GitHubStatus } from "../../shared/github";

export type { CloneResult, GitHubBranch, GitHubRepo, GitHubStatus };

async function call<T>(url: string, init?: RequestInit): Promise<T> {
  const r = await fetch(url, { headers: { "Content-Type": "application/json" }, ...init });
  if (!r.ok) {
    let msg = `${r.status}`;
    try { msg = (await r.json())?.error?.message ?? msg; } catch { /* keep status */ }
    throw new Error(msg);
  }
  return r.json();
}

export const githubStatus = () => call<GitHubStatus>("/api/github");
export const githubRepos = () => call<{ repos: GitHubRepo[] }>("/api/github/repos").then((r) => r.repos);
export const githubBranches = (repo: string) => call<{ branches: GitHubBranch[] }>(`/api/github/branches?repo=${encodeURIComponent(repo)}`).then((r) => r.branches);
export const githubClone = (req: CloneRequest) => call<CloneResult>("/api/github/clone", { method: "POST", body: JSON.stringify(req) });

/** Where to mint a token that reaches only the repositories you pick. */
export const NEW_TOKEN_URL = "https://github.com/settings/personal-access-tokens/new";
/** Where an existing token's repository list is changed. */
export const TOKENS_URL = "https://github.com/settings/personal-access-tokens";

/** "3 days ago" for a list; coarse on purpose. */
export function ago(iso: string | null): string {
  if (!iso) return "";
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  if (s < 86400 * 30) return `${Math.round(s / 86400)} d ago`;
  if (s < 86400 * 365) return `${Math.round(s / (86400 * 30))} mo ago`;
  return `${Math.round(s / (86400 * 365))} y ago`;
}
