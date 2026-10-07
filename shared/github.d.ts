/**
 * GitHub integration: read-only, scoped by the user.
 *
 * The runner holds one fine-grained personal access token (vault item
 * GITHUB_TOKEN) and uses it for exactly two things: listing the repositories
 * the token was granted, and cloning or fast-forwarding them into the
 * workspace. The agent never sees the token (clones carry no credentials), so
 * nothing in the sandbox can push, open issues or read anything else.
 */

export interface GitHubStatus {
  /** A token is available (vault item or GITHUB_TOKEN in the environment). */
  configured: boolean;
  source: "vault" | "env" | "none";
  /** The vault holds the token but is locked, so it cannot be used right now. */
  sealed: boolean;
  /** The token's account, once it has been looked up; null while unknown. */
  login: string | null;
  /** Why the token could not be checked (network, or GitHub rejected it); null when fine. */
  error: string | null;
  /** Where clones land: `<cloneRoot>/<owner>/<repo>`. */
  cloneRoot: string;
  /** Repositories already in the workspace. */
  clones: GitHubClone[];
}

export interface GitHubRepo {
  /** `owner/name` */
  fullName: string;
  description: string | null;
  defaultBranch: string;
  private: boolean;
  archived: boolean;
  /** ISO timestamp of the last push, for ordering. */
  pushedAt: string | null;
  /** Set when the repository is already in the workspace. */
  directory?: string;
}

export interface GitHubClone {
  /** `owner/name`, from the clone's origin URL. */
  fullName: string;
  directory: string;
  /** The checked-out branch, or null for a detached head. */
  branch: string | null;
}

export interface GitHubBranch {
  name: string;
  /** This is the repository's default branch. */
  isDefault: boolean;
}

export interface CloneRequest {
  /** `owner/name` */
  repo: string;
  /** Defaults to the repository's default branch. */
  branch?: string;
}

export interface CloneResult {
  directory: string;
  branch: string;
  /** `cloned` on a fresh clone, `updated` when the existing clone was fast-forwarded. */
  action: "cloned" | "updated";
}
