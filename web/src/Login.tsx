/**
 * Sign-in with the vault's passkey (no passwords). One touch signs the
 * server's challenge and, via the same assertion's PRF output, unlocks the
 * vault. Backups: the backup passphrase or the recovery code, each of which
 * proves possession of the vault key. Lost all three: reset the vault on the
 * server (instructions shown).
 */
import { useEffect, useState, type ReactNode } from "react";
import type { PasskeyMethod, PasswordMethod, RecoveryMethod } from "../../shared/vault";
import { TerminalBar } from "./Terminal";
import { Wordmark } from "./brand";
import { authChallenge, authLogout, authMe, authMethods, authPasskey, authRecover, vaultUnseal } from "./vault/api";
import { looksLikeRecoveryCode, unwrapWithPasskey, unwrapWithPassword, unwrapWithRecovery } from "./vault/crypto";
import { assertPasskey, passkeysAvailable } from "./vault/prf";
import { forgetDek, rememberDek } from "./vault/session";

type AuthState = "checking" | "open" | "signed-in" | "signed-out";

/** Fired by any /api call that comes back 401 from our own gate (see main.tsx). */
export const UNAUTHORIZED_EVENT = "or:unauthorized";

export async function logout() {
  forgetDek();
  await authLogout().catch(() => {});
  window.location.reload();
}

/** Shows the sign-in screen until the server accepts the session (or needs none). */
export function AuthGate({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>("checking");

  useEffect(() => {
    authMe()
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
  const [mode, setMode] = useState<"passkey" | "password" | "recovery" | "lost">("passkey");
  const [legacyPass, setLegacyPass] = useState("");
  const [pass, setPass] = useState("");
  const [code, setCode] = useState("");
  const [legacy, setLegacy] = useState(false);
  const [hasPassword, setHasPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    authMethods().then(({ methods }) => {
      setLegacy(methods.some((m) => m.type === "passkey" && !!m.passphrase));
      setHasPassword(methods.some((m) => m.type === "password"));
    }).catch(() => {});
  }, []);

  async function withPasskey() {
    setBusy(true); setError(null); setNote(null);
    try {
      const c = await authChallenge();
      if ("open" in c) return onSuccess(); // sign-in was switched off meanwhile
      const { methods } = await authMethods();
      const passkeys = methods.filter((m): m is PasskeyMethod & { canLogin: boolean } => m.type === "passkey");
      const salt = passkeys[0]?.prfSalt ?? "bugxhunter-vault-prf-v1";
      const { assertion, prf } = await assertPasskey(c, salt);
      await authPasskey(assertion);
      // Same touch: unlock the vault with this assertion's PRF output.
      const m = passkeys.find((p) => p.credentialId === assertion.credentialId);
      if (m && prf) {
        try {
          const dek = await unwrapWithPasskey(m, prf, m.passphrase ? legacyPass : undefined);
          await vaultUnseal(dek);
          rememberDek(dek);
        } catch {
          setNote(m.passphrase ? "Signed in; the vault stays locked (passphrase?) — unlock it from the sidebar." : "Signed in, but the vault didn't unlock — unlock it from the sidebar.");
        }
      }
      onSuccess();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  /** The backups prove possession of the vault key, which signs in and unlocks. */
  async function withSecret(kind: "password" | "recovery") {
    setBusy(true); setError(null);
    try {
      const { methods } = await authMethods();
      let dek: string;
      try {
        if (kind === "password") {
          const pw = methods.find((m): m is PasswordMethod => m.type === "password");
          if (!pw) throw new Error("no method");
          dek = await unwrapWithPassword(pw, pass);
        } else {
          const rc = methods.find((m): m is RecoveryMethod => m.type === "recovery");
          if (!rc) throw new Error("no method");
          dek = await unwrapWithRecovery(rc, code);
        }
      } catch {
        throw new Error(kind === "password" ? "Wrong backup passphrase." : "That recovery code doesn't open the vault.");
      }
      await authRecover(dek);
      rememberDek(dek);
      onSuccess();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  const submit = () => { if (mode === "passkey") withPasskey(); else if (mode === "password") withSecret("password"); else if (mode === "recovery") withSecret("recovery"); };

  return (
    <div className="login-page grid-bg">
      <form className="login-card" onSubmit={(e) => { e.preventDefault(); submit(); }}>
        <TerminalBar title="bugxhunter@redteam: ~/login" />
        <div className="login-body">
          <span className="logo login-mark" style={{ fontSize: 34 }} aria-label="BugXHunter"><Wordmark cursor /></span>
          <div className="login-tag">Your Security Testing Partner</div>

          {mode === "passkey" && (
            <>
              {legacy && (
                <>
                  <label htmlFor="pp">vault passphrase <span className="muted">(this passkey was enrolled with one)</span></label>
                  <input id="pp" type="password" autoFocus autoComplete="current-password" value={legacyPass} onChange={(e) => setLegacyPass(e.target.value)} />
                </>
              )}
              {!passkeysAvailable() && <div className="form-status error">This browser has no passkey support. Use Chrome, Edge or Safari, or a backup.</div>}
              <button className="btn primary block" type="submit" autoFocus={!legacy} disabled={busy || !passkeysAvailable()}>
                {busy ? "waiting for the passkey…" : "./sign_in --passkey →"}
              </button>
              <div className="login-links">
                {hasPassword && <button type="button" className="link-btn" disabled={busy} onClick={() => { setMode("password"); setError(null); }}>use the backup passphrase</button>}
                <button type="button" className="link-btn" disabled={busy} onClick={() => { setMode("recovery"); setError(null); }}>use the recovery code</button>
              </div>
            </>
          )}

          {mode === "password" && (
            <>
              <label htmlFor="bp">backup passphrase</label>
              <input id="bp" type="password" autoFocus autoComplete="current-password" value={pass} onChange={(e) => setPass(e.target.value)} />
              <button className="btn primary block" type="submit" disabled={busy || !pass}>{busy ? "checking…" : "./sign_in --passphrase →"}</button>
              <div className="login-links">
                <button type="button" className="link-btn" disabled={busy} onClick={() => { setMode("passkey"); setError(null); }}>back to the passkey</button>
                <button type="button" className="link-btn" disabled={busy} onClick={() => { setMode("recovery"); setError(null); }}>use the recovery code</button>
              </div>
            </>
          )}

          {mode === "recovery" && (
            <>
              <label htmlFor="rc">recovery code</label>
              <input id="rc" type="text" className="mono" autoFocus autoComplete="off" spellCheck={false} placeholder="XXXXX-XXXXX-XXXXX-XXXXX-XXXXX-X"
                value={code} onChange={(e) => setCode(e.target.value)} />
              <button className="btn primary block" type="submit" disabled={busy || !looksLikeRecoveryCode(code)}>{busy ? "checking…" : "./sign_in --recovery →"}</button>
              <p className="hint" style={{ margin: 0 }}>This signs you in and unlocks the vault. Enrol a new passkey right after, from the keys dialog.</p>
              <div className="login-links">
                <button type="button" className="link-btn" disabled={busy} onClick={() => { setMode("passkey"); setError(null); }}>back to the passkey</button>
                <button type="button" className="link-btn" disabled={busy} onClick={() => { setMode("lost"); setError(null); }}>lost that too?</button>
              </div>
            </>
          )}

          {mode === "lost" && (
            <>
              <p className="hint" style={{ margin: 0 }}>
                Without the passkey, the backup passphrase or the recovery code the vault's secrets can't be recovered — by design, and by anyone.
                Someone with access to the server's files can reset it, which deletes the vault and reopens the app for a fresh setup:
              </p>
              <pre className="tool-output" style={{ borderTop: "1px solid var(--border)" }}>{"npm run vault:reset\n# Docker:\ndocker compose exec runner rm /data/vault.json"}</pre>
              <p className="hint" style={{ margin: 0 }}>Nothing on the network can do this, which is what keeps the lock meaningful.</p>
              <button type="button" className="link-btn" onClick={() => { setMode("passkey"); setError(null); }}>back</button>
            </>
          )}

          {note && <div className="form-status success">{note}</div>}
          {error && <div className="form-status error">{error}</div>}
        </div>
      </form>
    </div>
  );
}
