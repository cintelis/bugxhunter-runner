/**
 * GitHub integration: read-only, scoped by the user.
 *
 * The runner signs in to the public BugXHunter GitHub App (device flow; the
 * app can only read Contents and reaches only the repositories it is
 * installed on) and uses the token for exactly two things: listing the
 * repositories it reaches, and cloning or fast-forwarding them into the
 * workspace. The agent never sees the token (clones carry no credentials), so
 * nothing in the sandbox can push, open issues or read anything else.
 */

export interface GitHubStatus {
  /** Signed in to the GitHub App. */
  connected: boolean;
  /** The sign-in is in the vault, which is locked, so it cannot be used right now. */
  sealed: boolean;
  /** Where the person picks which repositories the app may read (GitHub's install screen). */
  installUrl: string;
  /** Where a sign-in would be kept: sealed in the vault, or in memory until the runner restarts (no vault yet). */
  storage: "vault" | "memory" | null;
  /** The token's account, once it has been looked up; null while unknown. */
  login: string | null;
  /** Why the token could not be checked (network, or GitHub rejected it); null when fine. */
  error: string | null;
  /** Where clones land: `<cloneRoot>/<owner>/<repo>`. */
  cloneRoot: string;
  /** Repositories already in the workspace. */
  clones: GitHubClone[];
}

/** Step 1 of signing in: the code to type at github.com/login/device. */
export interface DeviceStart {
  id: string;
  userCode: string;
  verificationUri: string;
  expiresIn: number;
  /** Seconds between polls, GitHub's rule. */
  interval: number;
}

export type DevicePoll =
  | { status: "pending" }
  | { status: "expired" }
  | { status: "denied" }
  | { status: "connected"; login: string; storage: "vault" | "memory" };

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
