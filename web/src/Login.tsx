import { useEffect, useState, type ReactNode } from "react";
import { Logo } from "./brand";

type AuthState = "checking" | "open" | "signed-in" | "signed-out";

/** Fired by any /api call that comes back 401 (see main.tsx). */
export const UNAUTHORIZED_EVENT = "or:unauthorized";

export async function logout() {
  await fetch("/api/auth/logout", { method: "POST" }).catch(() => {});
  window.location.reload();
}

/** Shows the login screen until the server accepts the session (or needs none). */
export function AuthGate({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>("checking");

  useEffect(() => {
    fetch("/api/auth/me")
      .then((r) => r.json())
      .then((me) => setState(!me.required ? "open" : me.authenticated ? "signed-in" : "signed-out"))
      .catch(() => setState("open")); // backend down: let the app show its own errors
    const onUnauthorized = () => setState("signed-out");
    window.addEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
    return () => window.removeEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
  }, []);

  if (state === "checking") return null;
  if (state === "signed-out") return <Login onSuccess={() => setState("signed-in")} />;
  return <>{children}</>;
}

function Login({ onSuccess }: { onSuccess: () => void }) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      if (r.ok) return onSuccess();
      setError((await r.json().catch(() => null))?.error?.message ?? `Sign-in failed (${r.status})`);
    } catch (err) {
      setError(String((err as Error).message ?? err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login-page">
      <form className="login-card" onSubmit={submit}>
        <Logo size={34} />
        <label htmlFor="pw">Password</label>
        <input id="pw" type="password" autoFocus autoComplete="current-password"
          value={password} onChange={(e) => setPassword(e.target.value)} />
        {error && <div className="hint danger">{error}</div>}
        <button className="btn primary block" type="submit" disabled={busy || !password}>
          {busy ? "Signing in…" : "Sign in"}
        </button>
      </form>
    </div>
  );
}
