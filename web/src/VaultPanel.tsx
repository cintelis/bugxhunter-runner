/**
 * The key vault in the sidebar: a one-line state (none / locked / open with
 * the auto-lock countdown) and the dialogs behind it — the setup wizard
 * (passphrase → passkey → key → recovery code), unlock (passkey + passphrase,
 * or recovery code) and item management. All key derivation happens here in
 * the browser (vault/crypto.ts, vault/prf.ts); the server stores ciphertext.
 */
import { useCallback, useEffect, useState, type ReactNode } from "react";
import type { PasskeyMethod, RecoveryMethod, VaultStatus } from "../../shared/vault";
import { vaultDeleteItem, vaultInit, vaultSeal, vaultSetItem, vaultStatus, vaultUnseal } from "./vault/api";
import { buildVault, looksLikeRecoveryCode, PRF_SALT, unwrapWithPasskey, unwrapWithRecovery } from "./vault/crypto";
import { createPasskeyWithPrf, evaluatePrf, passkeysAvailable, type EnrolledPasskey } from "./vault/prf";

const MIN_PASSPHRASE = 10;

export function VaultPanel() {
  const [status, setStatus] = useState<VaultStatus | null>(null);
  const [dialog, setDialog] = useState<"setup" | "unlock" | "manage" | null>(null);
  const [now, setNow] = useState(Date.now());

  const refresh = useCallback(() => vaultStatus().then(setStatus).catch(() => {}), []);
  useEffect(() => {
    refresh();
    const t = setInterval(() => { refresh(); setNow(Date.now()); }, 30_000);
    return () => clearInterval(t);
  }, [refresh]);

  const close = () => { setDialog(null); refresh(); };
  if (!status) return null;

  const row = !status.initialised ? (
    <>
      <span className="vault-state none" title={status.keySource === "none" ? "No model key yet" : `Model key comes from ${status.keySource === "env" ? ".env" : "OpenCode's auth.json"}, in the clear`}>
        {status.keySource === "none" ? "no vault, no model key" : "vault not set up"}
      </span>
      <button className="btn primary sm" onClick={() => setDialog("setup")}>set_up</button>
    </>
  ) : !status.unsealed ? (
    <>
      <span className="vault-state sealed">vault locked</span>
      <button className="btn primary sm" onClick={() => setDialog("unlock")}>unlock</button>
    </>
  ) : (
    <>
      <span className="vault-state open" title={status.idleMinutes ? `Auto-locks after ${status.idleMinutes} min without activity` : "Auto-lock off"}>
        vault open{status.sealsAt ? ` · locks in ${remaining(status.sealsAt - now)}` : ""}
      </span>
      <button className="btn ghost sm" onClick={() => setDialog("manage")} title="Keys in the vault">keys</button>
      <button className="btn ghost sm" onClick={() => vaultSeal().then(setStatus).catch(() => {})} title="Lock now">lock</button>
    </>
  );

  return (
    <>
      <div className="vault-row">{row}</div>
      {dialog === "setup" && <SetupDialog onClose={close} />}
      {dialog === "unlock" && <UnlockDialog status={status} onClose={close} />}
      {dialog === "manage" && <ManageDialog status={status} onChange={setStatus} onClose={close} />}
    </>
  );
}

function remaining(ms: number) {
  const m = Math.max(0, Math.round(ms / 60_000));
  return m >= 60 ? `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m` : `${m}m`;
}

function Dialog({ title, onClose, children }: { title: string; onClose?: () => void; children: ReactNode }) {
  useEffect(() => {
    if (!onClose) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="overlay vault-dialog" onClick={onClose}>
      <div className="modal" role="dialog" aria-label={title} onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <span className="modal-title"><span className="dot y" aria-hidden />{title}</span>
          {onClose && <button className="btn ghost sm" onClick={onClose}>close</button>}
        </div>
        <div className="modal-body">{children}</div>
      </div>
    </div>
  );
}

// --- setup wizard ------------------------------------------------------------

type Step = "passphrase" | "passkey" | "key" | "recovery";
const STEPS: Step[] = ["passphrase", "passkey", "key", "recovery"];

function SetupDialog({ onClose }: { onClose: () => void }) {
  const [step, setStep] = useState<Step>("passphrase");
  const [pass, setPass] = useState("");
  const [pass2, setPass2] = useState("");
  const [enrolled, setEnrolled] = useState<EnrolledPasskey | null>(null);
  const [scxKey, setScxKey] = useState("");
  const [built, setBuilt] = useState<Awaited<ReturnType<typeof buildVault>> | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const label = `BugXHunter vault (${location.hostname})`;

  async function enrol() {
    setBusy(true); setError(null);
    try {
      setEnrolled(await createPasskeyWithPrf(label, PRF_SALT));
      setStep("key");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function build() {
    if (!enrolled) return;
    setBusy(true); setError(null);
    try {
      setBuilt(await buildVault({
        passphrase: pass, prf: enrolled.prf, credentialId: enrolled.credentialId, transports: enrolled.transports, label,
        items: scxKey.trim() ? { SCX_API: scxKey.trim() } : {},
      }));
      setStep("recovery");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function create() {
    if (!built) return;
    setBusy(true); setError(null);
    try {
      await vaultInit(built.doc, built.dek);
      onClose();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  const passOk = pass.length >= MIN_PASSPHRASE && pass === pass2;
  return (
    <Dialog title="vault --init" onClose={step === "recovery" ? undefined : onClose}>
      <div className="steps">
        {STEPS.map((s) => <span key={s} className={s === step ? "on" : STEPS.indexOf(s) < STEPS.indexOf(step) ? "done" : ""}>{s}</span>)}
      </div>

      {step === "passphrase" && (
        <>
          <p>Your model keys will be sealed at rest. Unlocking needs <b>both</b> a passphrase and a passkey, so neither a copied disk nor a stolen device alone opens them.</p>
          <label htmlFor="v-pass">Passphrase (at least {MIN_PASSPHRASE} characters)</label>
          <input id="v-pass" type="password" autoFocus autoComplete="new-password" value={pass} onChange={(e) => setPass(e.target.value)} />
          <label htmlFor="v-pass2">Again</label>
          <input id="v-pass2" type="password" autoComplete="new-password" value={pass2} onChange={(e) => setPass2(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && passOk) setStep("passkey"); }} />
          {pass2 && pass !== pass2 && <div className="form-status error">The passphrases differ.</div>}
          <div className="perm-actions"><button className="btn primary sm" disabled={!passOk} onClick={() => setStep("passkey")}>next →</button></div>
        </>
      )}

      {step === "passkey" && (
        <>
          <p>Now the second factor: a passkey. The authenticator (Windows Hello, Touch ID, Android, or a security key) derives a secret that never leaves it. Works in Chrome, Edge and Safari 18+; Firefox can't do this yet.</p>
          {!passkeysAvailable() && <div className="form-status error">This browser has no passkey support.</div>}
          <div className="perm-actions">
            <button className="btn primary sm" disabled={busy || !passkeysAvailable()} onClick={enrol}>{busy ? "waiting for the authenticator…" : "create passkey"}</button>
            <button className="btn sm" disabled={busy} onClick={() => setStep("passphrase")}>← back</button>
          </div>
        </>
      )}

      {step === "key" && (
        <>
          <p>Passkey enrolled. Add the SCX API key now, or later from the keys dialog. It goes straight into the sealed vault; <code className="mono">.env</code> can then drop <code className="mono">SCX_API</code>.</p>
          <label htmlFor="v-scx">SCX API key (optional)</label>
          <input id="v-scx" type="password" autoFocus autoComplete="off" placeholder="sk-scx-…" value={scxKey} onChange={(e) => setScxKey(e.target.value)} />
          <div className="perm-actions"><button className="btn primary sm" disabled={busy} onClick={build}>{busy ? "sealing…" : "next →"}</button></div>
        </>
      )}

      {step === "recovery" && built && (
        <>
          <p>This recovery code opens the vault if the passkey is lost. It is shown <b>once</b> and stored nowhere. Keep it offline, like a password-manager note or paper.</p>
          <div className="recovery-code" aria-label="Recovery code">{built.recoveryCode}</div>
          <div className="perm-actions">
            <button className="btn sm" onClick={() => navigator.clipboard?.writeText(built.recoveryCode)}>copy</button>
          </div>
          <label className="check"><input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} /> I have stored this code somewhere safe.</label>
          <div className="perm-actions"><button className="btn primary sm" disabled={!saved || busy} onClick={create}>{busy ? "creating…" : "create vault"}</button></div>
        </>
      )}

      {error && <div className="form-status error">{error}</div>}
    </Dialog>
  );
}

// --- unlock --------------------------------------------------------------------

function UnlockDialog({ status, onClose }: { status: VaultStatus; onClose: () => void }) {
  const [mode, setMode] = useState<"passkey" | "recovery">("passkey");
  const [pass, setPass] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const passkey = status.methods.find((m) => m.type === "passkey") as PasskeyMethod | undefined;
  const recovery = status.methods.find((m) => m.type === "recovery") as RecoveryMethod | undefined;

  async function withPasskey() {
    if (!passkey) return;
    setBusy(true); setError(null);
    try {
      const prf = await evaluatePrf(passkey.credentialId, passkey.transports, passkey.prfSalt);
      let dek: string;
      try {
        dek = await unwrapWithPasskey(passkey, prf, pass);
      } catch {
        throw new Error("Wrong passphrase, or a different passkey than the one enrolled.");
      }
      await vaultUnseal(dek);
      onClose();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  async function withRecovery() {
    if (!recovery) return;
    setBusy(true); setError(null);
    try {
      let dek: string;
      try {
        dek = await unwrapWithRecovery(recovery, code);
      } catch {
        throw new Error("That recovery code doesn't open the vault.");
      }
      await vaultUnseal(dek);
      onClose();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  return (
    <Dialog title="vault --unlock" onClose={onClose}>
      {mode === "passkey" ? (
        <>
          <p>Enter the passphrase, then confirm with your passkey. Both are needed.</p>
          <label htmlFor="v-unlock-pass">Passphrase</label>
          <input id="v-unlock-pass" type="password" autoFocus autoComplete="current-password" value={pass}
            onChange={(e) => setPass(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && pass) withPasskey(); }} />
          <div className="perm-actions">
            <button className="btn primary sm" disabled={busy || !pass || !passkey} onClick={withPasskey}>{busy ? "waiting for the authenticator…" : "unlock with passkey"}</button>
            {recovery && <button className="link-btn" disabled={busy} onClick={() => { setMode("recovery"); setError(null); }}>use a recovery code</button>}
          </div>
        </>
      ) : (
        <>
          <p>Enter the recovery code shown when the vault was created.</p>
          <label htmlFor="v-code">Recovery code</label>
          <input id="v-code" type="text" className="mono" autoFocus autoComplete="off" spellCheck={false} placeholder="XXXXX-XXXXX-XXXXX-XXXXX-XXXXX-X"
            value={code} onChange={(e) => setCode(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && looksLikeRecoveryCode(code)) withRecovery(); }} />
          <div className="perm-actions">
            <button className="btn primary sm" disabled={busy || !looksLikeRecoveryCode(code)} onClick={withRecovery}>{busy ? "unlocking…" : "unlock"}</button>
            <button className="link-btn" disabled={busy} onClick={() => { setMode("passkey"); setError(null); }}>use the passkey instead</button>
          </div>
        </>
      )}
      {error && <div className="form-status error">{error}</div>}
    </Dialog>
  );
}

// --- items -----------------------------------------------------------------------

function ManageDialog({ status, onChange, onClose }: { status: VaultStatus; onChange: (s: VaultStatus) => void; onClose: () => void }) {
  const [name, setName] = useState("SCX_API");
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setBusy(true); setError(null);
    try {
      onChange(await vaultSetItem(name.trim().toUpperCase(), value));
      setValue("");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function remove(n: string) {
    setError(null);
    try { onChange(await vaultDeleteItem(n)); } catch (e) { setError((e as Error).message); }
  }

  return (
    <Dialog title="vault --keys" onClose={onClose}>
      <p>Secrets sealed in the vault. Values are never shown again; replace one by saving it under the same name. <code className="mono">SCX_API</code> is the model key the app uses.</p>
      {status.items.length ? (
        <div className="vault-items">
          {status.items.map((n) => (
            <div className="vault-item" key={n}>
              <span className="ok" aria-hidden>✓</span><span className="name">{n}</span>
              <button className="btn danger" onClick={() => remove(n)} title="Remove">✕</button>
            </div>
          ))}
        </div>
      ) : <div className="form-status error">No keys yet — add SCX_API so the app can call models.</div>}
      <label htmlFor="v-name">Name</label>
      <input id="v-name" type="text" className="mono" value={name} onChange={(e) => setName(e.target.value)} spellCheck={false} />
      <label htmlFor="v-value">Value</label>
      <input id="v-value" type="password" autoComplete="off" value={value} onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter" && value) save(); }} />
      <div className="perm-actions">
        <button className="btn primary sm" disabled={busy || !value || !name.trim()} onClick={save}>{busy ? "sealing…" : "save"}</button>
        <span className="hint" style={{ margin: 0 }}>{status.idleMinutes ? `Auto-locks after ${status.idleMinutes} min idle.` : "Auto-lock is off."}</span>
      </div>
      {error && <div className="form-status error">{error}</div>}
    </Dialog>
  );
}
