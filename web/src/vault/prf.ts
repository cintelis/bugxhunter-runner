/**
 * Passkeys, for two jobs:
 *
 *  1. Key derivation, via the WebAuthn PRF extension (CTAP2 hmac-secret): a
 *     stable 32 bytes for (credential, salt), computed inside the authenticator.
 *     That is the vault's first factor; the passphrase is the second. WebAuthn
 *     signatures alone can't do this — they are non-deterministic.
 *  2. Sign-in: an ordinary WebAuthn assertion, which the server verifies against
 *     the public key captured at enrolment (response.getPublicKey()).
 *
 * One `navigator.credentials.get()` does both: the assertion signs in and its
 * PRF output unlocks. Support: Chromium, Android, Safari 18+, Windows Hello
 * (recent). Firefox lacks PRF, which is why enrolment probes and recovery
 * codes exist.
 */
import type { AuthChallenge, PasskeyAssertion } from "../../../shared/vault";
import { b64, b64url, randomBytes } from "./crypto";

export class PrfUnsupportedError extends Error {
  constructor(message: string) { super(message); this.name = "PrfUnsupportedError"; }
}
export class PasskeyCancelledError extends Error {
  constructor() { super("Passkey prompt cancelled or timed out."); this.name = "PasskeyCancelledError"; }
}

export const passkeysAvailable = () => typeof window !== "undefined" && !!window.PublicKeyCredential && !!navigator.credentials;

const enc = new TextEncoder();

/**
 * The relying-party id scopes the passkey. WebAuthn requires a domain name
 * here: an IP address is rejected with a SecurityError, so an app opened as
 * http://127.0.0.1:8790 can't enrol — open it as http://localhost:8790 (or a
 * hostname) instead. The passkey stays bound to whichever name was used.
 */
function rpId(): string {
  const h = location.hostname;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h) || h.startsWith("[")) {
    throw new PrfUnsupportedError(`Passkeys can't be bound to an IP address (${h}). Open the app via http://localhost:${location.port || 80} or a hostname.`);
  }
  return h;
}

function translate(e: unknown): Error {
  const err = e as DOMException;
  if (err?.name === "NotAllowedError") return new PasskeyCancelledError();
  if (err?.name === "OperationError") {
    return new PrfUnsupportedError("Another passkey request is pending in this tab. Close any stray OS dialog or reload, then try again.");
  }
  if (err?.name === "SecurityError") {
    return new PrfUnsupportedError(`The browser refused the passkey request (SecurityError: ${err.message}). Passkeys need https or localhost, and a relying-party name equal to the page's host (${location.hostname}).`);
  }
  if (err?.name === "NotSupportedError" || err?.name === "ConstraintError") {
    return new PrfUnsupportedError(`The authenticator can't do this (${err.name}: ${err.message}).`);
  }
  return err instanceof Error ? new Error(`${err.name ?? "Error"}: ${err.message}`) : new Error(String(e));
}

const prfExtension = (prfSalt: string) => ({ prf: { eval: { first: enc.encode(prfSalt) } } }) as AuthenticationExtensionsClientInputs;

export interface EnrolledPasskey {
  credentialId: string;
  transports?: string[];
  /** 32-byte PRF output for PRF_SALT. */
  prf: Uint8Array;
  /** SPKI DER, base64, and the COSE algorithm: what the server verifies sign-ins with. */
  publicKey: string;
  alg: number;
}

/** Create a passkey, capture its public key, and evaluate its PRF. Fails cleanly if PRF is missing. */
export async function createPasskeyWithPrf(label: string, prfSalt: string): Promise<EnrolledPasskey> {
  if (!passkeysAvailable()) throw new PrfUnsupportedError("This browser has no passkey support.");
  let cred: PublicKeyCredential | null;
  try {
    cred = (await navigator.credentials.create({
      publicKey: {
        rp: { id: rpId(), name: "BugXHunter" },
        user: { id: randomBytes(16), name: label, displayName: "BugXHunter vault" },
        challenge: randomBytes(32),
        pubKeyCredParams: [{ type: "public-key", alg: -7 }, { type: "public-key", alg: -8 }, { type: "public-key", alg: -257 }],
        authenticatorSelection: { residentKey: "preferred", userVerification: "required" },
        timeout: 120_000,
        extensions: prfExtension(prfSalt),
      },
    })) as PublicKeyCredential | null;
  } catch (e) {
    throw translate(e);
  }
  if (!cred) throw new PasskeyCancelledError();
  const ext = cred.getClientExtensionResults() as { prf?: { enabled?: boolean; results?: { first?: ArrayBuffer } } };
  if (!ext.prf?.enabled) {
    throw new PrfUnsupportedError("This passkey can't derive keys (no PRF support). Use a platform passkey (Windows Hello, Touch ID, Android) or a recent security key, in Chrome, Edge or Safari 18+.");
  }
  const att = cred.response as AuthenticatorAttestationResponse;
  const spki = att.getPublicKey?.();
  if (!spki) throw new PrfUnsupportedError("This browser doesn't expose the passkey's public key (needed for sign-in). Use Chrome, Edge or Safari.");
  const transports = att.getTransports?.() ?? undefined;
  const credentialId = b64url.enc(new Uint8Array(cred.rawId));
  // Some authenticators evaluate PRF at creation; others only on assertion.
  const prf = ext.prf.results?.first ? new Uint8Array(ext.prf.results.first) : (await assertPasskey({ challenge: b64url.enc(randomBytes(32)), rpId: rpId(), allowCredentials: [{ id: credentialId, transports }] }, prfSalt)).prf!;
  return { credentialId, transports, prf, publicKey: b64.enc(spki), alg: att.getPublicKeyAlgorithm() };
}

/**
 * One touch: sign the server's challenge (for sign-in) and evaluate the PRF
 * (for unlocking). `prf` is undefined when the authenticator didn't return one.
 */
export async function assertPasskey(c: AuthChallenge, prfSalt: string): Promise<{ assertion: PasskeyAssertion; prf?: Uint8Array }> {
  if (!passkeysAvailable()) throw new PrfUnsupportedError("This browser has no passkey support.");
  // The relying-party id must equal this page's host; the server's value is
  // only a hint (behind a proxy it may see a different Host).
  const id = rpId();
  if (c.rpId && c.rpId !== id) console.warn(`[vault] server suggested rpId ${c.rpId}; using the page's host ${id}`);
  let cred: PublicKeyCredential | null;
  try {
    cred = (await navigator.credentials.get({
      publicKey: {
        rpId: id,
        challenge: b64url.dec(c.challenge),
        allowCredentials: c.allowCredentials.map((a) => ({ type: "public-key" as const, id: b64url.dec(a.id), transports: a.transports as AuthenticatorTransport[] | undefined })),
        userVerification: "required",
        timeout: 120_000,
        extensions: prfExtension(prfSalt),
      },
    })) as PublicKeyCredential | null;
  } catch (e) {
    throw translate(e);
  }
  if (!cred) throw new PasskeyCancelledError();
  const r = cred.response as AuthenticatorAssertionResponse;
  const ext = cred.getClientExtensionResults() as { prf?: { results?: { first?: ArrayBuffer } } };
  return {
    assertion: {
      credentialId: b64url.enc(new Uint8Array(cred.rawId)),
      clientDataJSON: b64url.enc(new Uint8Array(r.clientDataJSON)),
      authenticatorData: b64url.enc(new Uint8Array(r.authenticatorData)),
      signature: b64url.enc(new Uint8Array(r.signature)),
    },
    prf: ext.prf?.results?.first ? new Uint8Array(ext.prf.results.first) : undefined,
  };
}

/** Ask the authenticator for this credential's PRF output only (an unlock while already signed in). */
export async function evaluatePrf(credentialId: string, transports: string[] | undefined, prfSalt: string): Promise<Uint8Array> {
  const { prf } = await assertPasskey({ challenge: b64url.enc(randomBytes(32)), rpId: rpId(), allowCredentials: [{ id: credentialId, transports }] }, prfSalt);
  if (!prf) throw new PrfUnsupportedError("The authenticator returned no PRF output. Use a passkey that supports PRF, or your recovery code.");
  return prf;
}
