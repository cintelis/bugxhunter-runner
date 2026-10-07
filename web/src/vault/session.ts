/**
 * The data key, held in this tab's memory after an unlock so the owner can add
 * a passkey or delete the vault without unlocking again. Never persisted;
 * forgotten on lock, sign-out and page unload.
 */
let dek: string | null = null;

export const rememberDek = (d: string) => { dek = d; };
export const forgetDek = () => { dek = null; };
export const heldDek = () => dek;
