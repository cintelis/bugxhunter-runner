import type { VaultDoc, VaultStatus } from "../../../shared/vault";

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

export const vaultStatus = () => call<VaultStatus>("/api/vault");
export const vaultInit = (doc: VaultDoc, dek: string) => call<VaultStatus>("/api/vault/init", { method: "POST", body: JSON.stringify({ doc, dek }) });
export const vaultUnseal = (dek: string) => call<VaultStatus>("/api/vault/unseal", { method: "POST", body: JSON.stringify({ dek }) });
export const vaultSeal = () => call<VaultStatus>("/api/vault/seal", { method: "POST" });
export const vaultSetItem = (name: string, value: string) =>
  call<VaultStatus>(`/api/vault/items/${encodeURIComponent(name)}`, { method: "PUT", body: JSON.stringify({ value }) });
export const vaultDeleteItem = (name: string) => call<VaultStatus>(`/api/vault/items/${encodeURIComponent(name)}`, { method: "DELETE" });
