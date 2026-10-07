import type { AuthChallenge, AuthMe, PasskeyAssertion, PublicMethod, VaultDoc, VaultMethod, VaultStatus } from "../../../shared/vault";

export type { VaultStatus };

async function call<T>(url: string, init?: RequestInit): Promise<T> {
  const r = await fetch(url, { headers: { "Content-Type": "application/json" }, ...init });
  if (!r.ok) {
    let msg = `${r.status}`;
    try { msg = (await r.json())?.error?.message ?? msg; } catch { /* keep status */ }
    throw new Error(msg);
  }
  return r.json();
}
const post = (body?: unknown) => ({ method: "POST", body: body === undefined ? undefined : JSON.stringify(body) });

// --- vault ------------------------------------------------------------------------
export const vaultStatus = () => call<VaultStatus>("/api/vault");
export const vaultInit = (doc: VaultDoc, dek: string) => call<VaultStatus>("/api/vault/init", post({ doc, dek }));
export const vaultUnseal = (dek: string) => call<VaultStatus>("/api/vault/unseal", post({ dek }));
export const vaultSeal = () => call<VaultStatus>("/api/vault/seal", post());
export const vaultSetItem = (name: string, value: string) =>
  call<VaultStatus>(`/api/vault/items/${encodeURIComponent(name)}`, { method: "PUT", body: JSON.stringify({ value }) });
export const vaultDeleteItem = (name: string) => call<VaultStatus>(`/api/vault/items/${encodeURIComponent(name)}`, { method: "DELETE" });
export const vaultAddMethod = (method: VaultMethod, dek: string) => call<VaultStatus>("/api/vault/methods", post({ method, dek }));
export const vaultRemoveMethod = (id: string) => call<VaultStatus>(`/api/vault/methods/${encodeURIComponent(id)}`, { method: "DELETE" });
export const vaultDestroy = (dek: string) => call<VaultStatus>("/api/vault", { method: "DELETE", body: JSON.stringify({ dek }) });

// --- sign-in --------------------------------------------------------------------------
export const authMe = () => call<AuthMe>("/api/auth/me");
export const authMethods = () => call<{ methods: PublicMethod[] }>("/api/auth/methods");
export const authChallenge = () => call<AuthChallenge | { open: true }>("/api/auth/challenge", post());
export const authPasskey = (assertion: PasskeyAssertion) => call<{ ok: true }>("/api/auth/passkey", post(assertion));
export const authRecover = (dek: string) => call<{ ok: true }>("/api/auth/recover", post({ dek }));
export const authLogout = () => call<{ ok: true }>("/api/auth/logout", post());
