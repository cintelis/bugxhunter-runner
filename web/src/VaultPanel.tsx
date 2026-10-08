/**
 * The key vault in the sidebar: a one-line state (none / locked / open with
 * the auto-lock countdown) and the dialogs behind it — the setup wizard
 * (passkey → key → backups), one-touch unlock (passkey; backup passphrase or
 * recovery code as fallbacks) and the keys dialog (items, passkeys, backup
 * passphrase, delete). All key derivation happens here in the browser
 * (vault/crypto.ts, vault/prf.ts); the server stores ciphertext.
 */
import { useCallback, useEffect, useState } from "react";
import { Dialog } from "./Dialog";
import type { PasskeyMethod, PasswordMethod, RecoveryMethod, VaultStatus } from "../../shared/vault";
import { vaultAddMethod, vaultDeleteItem, vaultDestroy, vaultInit, vaultRemoveMethod, vaultSeal, vaultSetItem, vaultStatus, vaultUnseal } from "./vault/api";
import { b64, buildVault, looksLikeRecoveryCode, PRF_SALT, unwrapWithPasskey, unwrapWithPassword, unwrapWithRecovery, wrapForPasskey, wrapForPassword } from "./vault/crypto";
import { createPasskeyWithPrf, evaluatePrf, passkeysAvailable, type EnrolledPasskey } from "./vault/prf";
import { forgetDek, heldDek, rememberDek } from "./vault/session";

export const MIN_PASSPHRASE = 10;
const vaultLabel = () => `BugXHunter vault (${location.hostname})`;

/** Secrets the app itself looks for; anything else is a custom item (e.g. a target's token). */
const CUSTOM = "__custom__";
const KNOWN_ITEMS = [
  { name: "SCX_API", short: "SCX.ai — the default provider", label: "SCX.ai model key — the default provider" },
  { name: "OPENROUTER_API_KEY", short: "OpenRouter — one key, its whole catalogue", label: "OpenRouter key — unlocks its model catalogue (optional)" },
];
const KEY_PLACEHOLDER: Record<string, string> = { SCX_API: "sk-scx-…", OPENROUTER_API_KEY: "sk-or-…" };

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
  const lock = useCallback(() => { forgetDek(); vaultSeal().then(setStatus).catch(() => {}); }, []);

  // Ctrl+Shift+L (Cmd+Shift+L on a Mac): lock the vault from anywhere.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === "l") { e.preventDefault(); lock(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [lock]);

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
      <button className="icon-btn vault-btn primary" onClick={() => setDialog("unlock")} title="Unlock the vault" aria-label="Unlock the vault">
        <LockOpenIcon />
      </button>
    </>
  ) : (
    <>
      <span className="vault-state open" title={status.idleMinutes ? `Auto-locks after ${status.idleMinutes} min without activity` : "Auto-lock off"}>
        vault open{status.sealsAt ? ` · locks in ${remaining(status.sealsAt - now)}` : ""}
      </span>
      <button className="icon-btn vault-btn" onClick={() => setDialog("manage")} title="Keys in the vault" aria-label="Keys in the vault">
        <KeySquareIcon />
      </button>
      <button className="icon-btn vault-btn" onClick={lock} title="Lock the vault (Ctrl+Shift+L)" aria-label="Lock the vault (Ctrl+Shift+L)">
        <ShieldKeyholeIcon />
      </button>
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

// Lucide icons (ISC): lock-keyhole-open, key-square and shield-keyhole, inlined so they take the theme colour.
const LockOpenIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <circle cx="12" cy="16" r="1" />
    <rect width="18" height="12" x="3" y="10" rx="2" />
    <path d="M7 10V7a5 5 0 0 1 9.33-2.5" />
  </svg>
);
const KeySquareIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M12.4 2.7a2.5 2.5 0 0 1 3.4 0l5.5 5.5a2.5 2.5 0 0 1 0 3.4l-3.7 3.7a2.5 2.5 0 0 1-3.4 0L8.7 9.8a2.5 2.5 0 0 1 0-3.4z" />
    <path d="m14 7 3 3" />
    <path d="m9.4 10.6-6.814 6.814A2 2 0 0 0 2 18.828V21a1 1 0 0 0 1 1h3a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h1a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h.172a2 2 0 0 0 1.414-.586l.814-.814" />
  </svg>
);
const ShieldKeyholeIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M12 13v3" />
    <path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 01-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 011-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 011.52 0C14.51 3.81 17 5 19 5a1 1 0 011 1z" />
    <circle cx="12" cy="11" r="2" />
  </svg>
);

function remaining(ms: number) {
  const m = Math.max(0, Math.round(ms / 60_000));
  return m >= 60 ? `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m` : `${m}m`;
}

// --- setup wizard ------------------------------------------------------------

type Step = "passkey" | "key" | "backups";
const STEPS: Step[] = ["passkey", "key", "backups"];

function SetupDialog({ onClose }: { onClose: () => void }) {
  const [step, setStep] = useState<Step>("passkey");
  const [enrolled, setEnrolled] = useState<EnrolledPasskey | null>(null);
  const [keyName, setKeyName] = useState("SCX_API");
  const [keyValue, setKeyValue] = useState("");
  const [pass, setPass] = useState("");
  const [pass2, setPass2] = useState("");
  const [built, setBuilt] = useState<Awaited<ReturnType<typeof buildVault>> | null>(null);
  const [saved, setSaved] = useState(false);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function enrol() {
    setBusy(true); setError(null);
    try {
      setEnrolled(await createPasskeyWithPrf(vaultLabel(), PRF_SALT));
      setStep("key");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  // The backups step shows the recovery code, so the vault is built when we get there.
  async function toBackups() {
    if (!enrolled) return;
    setBusy(true); setError(null);
    try {
      setBuilt(await buildVault({ ...enrolled, label: vaultLabel(), items: keyValue.trim() ? { [keyName]: keyValue.trim() } : {} }));
      setStep("backups");
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
      let doc = built.doc;
      // The optional backup passphrase is wrapped now, with the DEK still in hand.
      if (pass) doc = { ...doc, methods: [...doc.methods, await wrapForPassword(b64.dec(built.dek), pass)] };
      await vaultInit(doc, built.dek);
      rememberDek(built.dek);
      onClose();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  const passOk = !pass || (pass.length >= MIN_PASSPHRASE && pass === pass2);
  return (
    <Dialog title="vault --init" onClose={step === "backups" ? undefined : onClose}>
      <div className="steps">
        {STEPS.map((s) => <span key={s} className={s === step ? "on" : STEPS.indexOf(s) < STEPS.indexOf(step) ? "done" : ""}>{s}</span>)}
      </div>

      {step === "passkey" && (
        <>
          <p>Your model keys will be sealed at rest, and this passkey will unlock them and sign you in — one touch. The authenticator (Windows Hello, Touch ID, Android, or a security key) derives a secret that never leaves it. Works in Chrome, Edge and Safari 18+; Firefox can't do this yet.</p>
          {!passkeysAvailable() && <div className="form-status error">This browser has no passkey support.</div>}
          <div className="perm-actions center">
            <button className="btn primary wide" disabled={busy || !passkeysAvailable()} onClick={enrol}>{busy ? "waiting for the authenticator…" : "create passkey →"}</button>
          </div>
        </>
      )}

      {step === "key" && (
        <>
          <p>Passkey enrolled. Add a model key now, or later from the keys dialog (where you can add the other provider too). It goes straight into the sealed vault; <code className="mono">.env</code> can then drop the key.</p>
          <label htmlFor="v-provider">Provider</label>
          <select id="v-provider" className="mono" value={keyName} onChange={(e) => setKeyName(e.target.value)}>
            {KNOWN_ITEMS.map((k) => <option key={k.name} value={k.name}>{k.short}</option>)}
          </select>
          <label htmlFor="v-key">{keyName} (optional)</label>
          <input id="v-key" type="password" autoFocus autoComplete="off" placeholder={KEY_PLACEHOLDER[keyName] ?? ""} value={keyValue} onChange={(e) => setKeyValue(e.target.value)} />
          <div className="perm-actions center"><button className="btn primary wide" disabled={busy} onClick={toBackups}>{busy ? "sealing…" : "next →"}</button></div>
        </>
      )}

      {step === "backups" && built && (
        <>
          <p>Backups, for when the passkey isn't at hand. This recovery code is shown <b>once</b> and stored nowhere — keep it offline, like a password-manager note or paper.</p>
          <button
            type="button"
            className={"recovery-code" + (copied ? " copied" : "")}
            aria-label="Recovery code — click to copy"
            title="Click to copy"
            onClick={() => {
              navigator.clipboard?.writeText(built.recoveryCode).then(() => { setCopied(true); setTimeout(() => setCopied(false), 2000); }).catch(() => {});
            }}
          >
            <span className="code">{built.recoveryCode}</span>
            <span className="copy-hint">{copied ? "✓ copied" : "click to copy"}</span>
          </button>
          <label className="check"><input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} /> I have stored this code somewhere safe.</label>
          <label htmlFor="v-pass">Backup passphrase (optional, at least {MIN_PASSPHRASE} characters)</label>
          <input id="v-pass" type="password" autoComplete="new-password" value={pass} onChange={(e) => setPass(e.target.value)} />
          {pass && (
            <>
              <label htmlFor="v-pass2">Again</label>
              <input id="v-pass2" type="password" autoComplete="new-password" value={pass2} onChange={(e) => setPass2(e.target.value)} />
              {pass2 && pass !== pass2 && <div className="form-status error">The passphrases differ.</div>}
            </>
          )}
          <div className="perm-actions center"><button className="btn primary wide" disabled={!saved || !passOk || busy} onClick={create}>{busy ? "creating…" : "create vault →"}</button></div>
        </>
      )}

      {error && <div className="form-status error">{error}</div>}
    </Dialog>
  );
}

// --- unlock --------------------------------------------------------------------

function UnlockDialog({ status, onClose }: { status: VaultStatus; onClose: () => void }) {
  const [mode, setMode] = useState<"passkey" | "password" | "recovery">("passkey");
  const [pass, setPass] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const passkey = status.methods.find((m) => m.type === "passkey") as PasskeyMethod | undefined;
  const password = status.methods.find((m) => m.type === "password") as PasswordMethod | undefined;
  const recovery = status.methods.find((m) => m.type === "recovery") as RecoveryMethod | undefined;
  const legacy = Boolean(passkey?.passphrase); // enrolled when the passphrase was mixed in

  async function finish(unwrap: () => Promise<string>, wrongMsg: string) {
    setBusy(true); setError(null);
    try {
      let dek: string;
      try { dek = await unwrap(); } catch (e) { throw e instanceof Error && /Passkey|authenticator|pending|origin/i.test(e.message) ? e : new Error(wrongMsg); }
      await vaultUnseal(dek);
      rememberDek(dek);
      onClose();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  const withPasskey = () => passkey && finish(async () => {
    const prf = await evaluatePrf(passkey.credentialId, passkey.transports, passkey.prfSalt);
    return unwrapWithPasskey(passkey, prf, legacy ? pass : undefined);
  }, legacy ? "Wrong passphrase, or a different passkey than the one enrolled." : "A different passkey than the one enrolled.");
  const withPassword = () => password && finish(() => unwrapWithPassword(password, pass), "Wrong backup passphrase.");
  const withRecovery = () => recovery && finish(() => unwrapWithRecovery(recovery, code), "That recovery code doesn't open the vault.");

  return (
    <Dialog title="vault --unlock" onClose={onClose}>
      {mode === "passkey" && (
        <>
          <p>{legacy ? "This passkey was enrolled with a passphrase: enter it, then confirm with the passkey." : "One touch: confirm with your passkey."}</p>
          {legacy && (
            <>
              <label htmlFor="v-unlock-pass">Passphrase</label>
              <input id="v-unlock-pass" type="password" autoFocus autoComplete="current-password" value={pass} onChange={(e) => setPass(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && pass) withPasskey(); }} />
            </>
          )}
          <div className="perm-actions center">
            <button className="btn primary wide" autoFocus={!legacy} disabled={busy || !passkey || (legacy && !pass)} onClick={withPasskey}>{busy ? "waiting for the authenticator…" : "unlock with passkey →"}</button>
          </div>
          <div className="login-links">
            {password && <button className="link-btn" disabled={busy} onClick={() => { setMode("password"); setError(null); }}>use the backup passphrase</button>}
            {recovery && <button className="link-btn" disabled={busy} onClick={() => { setMode("recovery"); setError(null); }}>use the recovery code</button>}
          </div>
        </>
      )}
      {mode === "password" && (
        <>
          <label htmlFor="v-unlock-pw">Backup passphrase</label>
          <input id="v-unlock-pw" type="password" autoFocus autoComplete="current-password" value={pass} onChange={(e) => setPass(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && pass) withPassword(); }} />
          <div className="perm-actions center">
            <button className="btn primary wide" disabled={busy || !pass} onClick={withPassword}>{busy ? "unlocking…" : "unlock →"}</button>
          </div>
          <div className="login-links">
            <button className="link-btn" disabled={busy} onClick={() => { setMode("passkey"); setError(null); }}>use the passkey instead</button>
            {recovery && <button className="link-btn" disabled={busy} onClick={() => { setMode("recovery"); setError(null); }}>use the recovery code</button>}
          </div>
        </>
      )}
      {mode === "recovery" && (
        <>
          <p>Enter the recovery code shown when the vault was created.</p>
          <label htmlFor="v-code">Recovery code</label>
          <input id="v-code" type="text" className="mono" autoFocus autoComplete="off" spellCheck={false} placeholder="XXXXX-XXXXX-XXXXX-XXXXX-XXXXX-X"
            value={code} onChange={(e) => setCode(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && looksLikeRecoveryCode(code)) withRecovery(); }} />
          <div className="perm-actions center">
            <button className="btn primary wide" disabled={busy || !looksLikeRecoveryCode(code)} onClick={withRecovery}>{busy ? "unlocking…" : "unlock →"}</button>
          </div>
          <div className="login-links">
            <button className="link-btn" disabled={busy} onClick={() => { setMode("passkey"); setError(null); }}>use the passkey instead</button>
            {password && <button className="link-btn" disabled={busy} onClick={() => { setMode("password"); setError(null); }}>use the backup passphrase</button>}
          </div>
        </>
      )}
      {error && <div className="form-status error">{error}</div>}
    </Dialog>
  );
}

// --- keys: items, passkeys, backup passphrase, the vault itself ---------------------

function ManageDialog({ status, onChange, onClose }: { status: VaultStatus; onChange: (s: VaultStatus) => void; onClose: () => void }) {
  const [name, setName] = useState("SCX_API");
  const [value, setValue] = useState("");
  const [newPass, setNewPass] = useState("");
  const [settingPass, setSettingPass] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dek = heldDek();
  const passkeys = status.methods.filter((m): m is PasskeyMethod & { canLogin: boolean } => m.type === "passkey");
  const password = status.methods.find((m) => m.type === "password");

  async function run(action: () => Promise<VaultStatus | void>) {
    setBusy(true); setError(null);
    try {
      const next = await action();
      if (next) onChange(next);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const needDek = () => { if (!dek) throw new Error("Unlock the vault in this tab first (the change must wrap the current key)."); return b64.dec(dek); };

  const saveItem = () => run(async () => { const s = await vaultSetItem(name.trim().toUpperCase(), value); setValue(""); return s; });
  const removeItem = (n: string) => run(() => vaultDeleteItem(n));
  const removeMethod = (id: string) => run(() => vaultRemoveMethod(id));
  const addPasskey = () => run(async () => {
    const raw = needDek();
    const method = await wrapForPasskey(raw, await createPasskeyWithPrf(vaultLabel(), PRF_SALT), vaultLabel());
    return vaultAddMethod(method, dek!);
  });
  const setPassphrase = () => run(async () => {
    const raw = needDek();
    const s = await vaultAddMethod(await wrapForPassword(raw, newPass), dek!);
    setSettingPass(false); setNewPass("");
    return s;
  });
  const destroy = () => run(async () => {
    needDek();
    const s = await vaultDestroy(dek!);
    forgetDek();
    onClose();
    return s;
  });

  return (
    <Dialog title="vault --keys" onClose={onClose}>
      <p>Secrets sealed in the vault. Values are never shown again; replace one by saving it under the same name.</p>
      <div className="vault-items">
        {KNOWN_ITEMS.map((k) => {
          const present = status.items.includes(k.name);
          return (
            <div className="vault-item" key={k.name}>
              <span className={present ? "ok" : "missing"} aria-hidden>{present ? "✓" : "○"}</span>
              <span className="name">{k.name}<span className="desc"> — {k.label}</span></span>
              {present
                ? <button className="btn danger" disabled={busy} onClick={() => removeItem(k.name)} title="Remove">✕</button>
                : <button className="btn sm" disabled={busy} onClick={() => { setName(k.name); setTimeout(() => document.getElementById("v-value")?.focus(), 0); }}>add</button>}
            </div>
          );
        })}
        {status.items.filter((n) => !KNOWN_ITEMS.some((k) => k.name === n)).map((n) => (
          <div className="vault-item" key={n}>
            <span className="ok" aria-hidden>✓</span><span className="name">{n}</span>
            <button className="btn danger" disabled={busy} onClick={() => removeItem(n)} title="Remove">✕</button>
          </div>
        ))}
      </div>
      <label htmlFor="v-name">Key</label>
      <select id="v-name" className="mono" value={KNOWN_ITEMS.some((k) => k.name === name) ? name : CUSTOM} onChange={(e) => setName(e.target.value === CUSTOM ? "" : e.target.value)}>
        {KNOWN_ITEMS.map((k) => <option key={k.name} value={k.name}>{k.name}{status.items.includes(k.name) ? " (replace)" : ""}</option>)}
        <option value={CUSTOM}>custom…</option>
      </select>
      {!KNOWN_ITEMS.some((k) => k.name === name) && (
        <input type="text" className="mono" placeholder="NAME_IN_UPPER_SNAKE_CASE" aria-label="Custom key name" value={name} onChange={(e) => setName(e.target.value)} spellCheck={false} autoFocus />
      )}
      <label htmlFor="v-value">Value</label>
      <input id="v-value" type="password" autoComplete="off" value={value} onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter" && value) saveItem(); }} />
      <div className="perm-actions">
        <button className="btn primary sm" disabled={busy || !value || !name.trim()} onClick={saveItem}>{busy ? "sealing…" : "save"}</button>
        <span className="hint" style={{ margin: 0 }}>{status.idleMinutes ? `Auto-locks after ${status.idleMinutes} min idle.` : "Auto-lock is off."}</span>
      </div>

      <div className="section-title">passkeys</div>
      <p>Each passkey unlocks the vault and signs you in with one touch. Keep two, on different devices, so losing one is not an emergency.</p>
      <div className="vault-items">
        {passkeys.map((p) => (
          <div className="vault-item" key={p.id}>
            <span className={p.canLogin ? "ok" : "warn"} aria-hidden>{p.canLogin ? "✓" : "!"}</span>
            <span className="name">{p.label}{p.passphrase ? " — needs its passphrase (older enrolment)" : ""}{p.canLogin ? "" : " — unlock only, can't sign in; add a new passkey"}</span>
            <button className="btn danger" disabled={busy || passkeys.length <= 1} onClick={() => removeMethod(p.id)} title={passkeys.length <= 1 ? "Add another passkey first" : "Remove"}>✕</button>
          </div>
        ))}
      </div>
      <div className="perm-actions">
        <button className="btn sm" disabled={busy || !dek} onClick={addPasskey} title={dek ? "" : "Unlock the vault in this tab first"}>{busy ? "waiting for the authenticator…" : "+ add passkey"}</button>
      </div>

      <div className="section-title">backups</div>
      <p>The recovery code from setup always works. A backup passphrase is optional: a way in on a device without the passkey.</p>
      <div className="vault-items">
        <div className="vault-item"><span className="ok" aria-hidden>✓</span><span className="name">Recovery code</span></div>
        {password && (
          <div className="vault-item">
            <span className="ok" aria-hidden>✓</span><span className="name">Backup passphrase</span>
            <button className="btn danger" disabled={busy} onClick={() => removeMethod(password.id)} title="Remove">✕</button>
          </div>
        )}
      </div>
      {settingPass ? (
        <>
          <label htmlFor="v-newpass">{password ? "New backup passphrase" : "Backup passphrase"} (at least {MIN_PASSPHRASE} characters)</label>
          <input id="v-newpass" type="password" autoFocus autoComplete="new-password" value={newPass} onChange={(e) => setNewPass(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && newPass.length >= MIN_PASSPHRASE) setPassphrase(); }} />
          <div className="perm-actions">
            <button className="btn primary sm" disabled={busy || newPass.length < MIN_PASSPHRASE} onClick={setPassphrase}>{busy ? "sealing…" : "save"}</button>
            <button className="btn sm" disabled={busy} onClick={() => setSettingPass(false)}>cancel</button>
          </div>
        </>
      ) : (
        <div className="perm-actions">
          <button className="btn sm" disabled={busy || !dek} onClick={() => setSettingPass(true)} title={dek ? "" : "Unlock the vault in this tab first"}>{password ? "replace backup passphrase" : "+ set a backup passphrase"}</button>
        </div>
      )}

      <div className="section-title">danger zone</div>
      <p>Delete the vault to start over with new factors. Its secrets are gone; the app reopens without sign-in until a new vault exists. Lost every factor instead? Run <code className="mono">npm run vault:reset</code> on the server.</p>
      <div className="perm-actions">
        <input type="text" className="mono" placeholder="type DELETE" value={confirmDelete} onChange={(e) => setConfirmDelete(e.target.value)} style={{ width: 160 }} />
        <button className="btn danger-outline sm" disabled={busy || confirmDelete !== "DELETE" || !dek} onClick={destroy}>delete vault</button>
      </div>
      {error && <div className="form-status error">{error}</div>}
    </Dialog>
  );
}
