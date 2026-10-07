/**
 * Passkeys as a key source, via the WebAuthn PRF extension.
 *
 * WebAuthn is an authentication protocol: it signs challenges, and the
 * signatures are non-deterministic, so nothing stable can be derived from one.
 * The PRF extension (CTAP2 hmac-secret) returns a stable 32 bytes for a given
 * (credential, salt), computed inside the authenticator — the seed never
 * leaves the device. That is the vault's first factor; the passphrase is the
 * second. Support: Chromium, Android, Safari 18+, Windows Hello (recent);
 * Firefox lacks it, which is why enrolment probes and recovery codes exist.
 *
 * The server does not verify these credentials: the passkey's job here is key
 * derivation, and the proof that it is the right one is that the derived KEK
 * opens the wrapped DEK (an AES-GCM tag check).
 */
import { b64url, randomBytes } from "./crypto";

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
  if (err?.name === "SecurityError") return new PrfUnsupportedError(`Passkeys need a secure origin (https, or localhost). This page is ${location.origin}.`);
  return err instanceof Error ? err : new Error(String(e));
}

export interface EnrolledPasskey {
  credentialId: string;
  transports?: string[];
  /** 32-byte PRF output for PRF_SALT. */
  prf: Uint8Array;
}

/** Create a passkey and evaluate its PRF. Fails cleanly if the authenticator lacks PRF. */
export async function createPasskeyWithPrf(label: string, prfSalt: string): Promise<EnrolledPasskey> {
  if (!passkeysAvailable()) throw new PrfUnsupportedError("This browser has no passkey support.");
  let cred: PublicKeyCredential | null;
  try {
    cred = (await navigator.credentials.create({
      publicKey: {
        rp: { id: rpId(), name: "BugXHunter" },
        user: { id: randomBytes(16), name: label, displayName: "BugXHunter vault" },
        challenge: randomBytes(32),
        pubKeyCredParams: [{ type: "public-key", alg: -8 }, { type: "public-key", alg: -7 }, { type: "public-key", alg: -257 }],
        authenticatorSelection: { residentKey: "preferred", userVerification: "required" },
        timeout: 120_000,
        extensions: { prf: { eval: { first: enc.encode(prfSalt) } } } as AuthenticationExtensionsClientInputs,
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
  const transports = (cred.response as AuthenticatorAttestationResponse).getTransports?.() ?? undefined;
  const credentialId = b64url.enc(new Uint8Array(cred.rawId));
  // Some authenticators evaluate PRF at creation; others only on assertion.
  const prf = ext.prf.results?.first ? new Uint8Array(ext.prf.results.first) : await evaluatePrf(credentialId, transports, prfSalt);
  return { credentialId, transports, prf };
}

/** Ask the authenticator for this credential's PRF output (one touch). */
export async function evaluatePrf(credentialId: string, transports: string[] | undefined, prfSalt: string): Promise<Uint8Array> {
  if (!passkeysAvailable()) throw new PrfUnsupportedError("This browser has no passkey support.");
  let cred: PublicKeyCredential | null;
  try {
    cred = (await navigator.credentials.get({
      publicKey: {
        rpId: rpId(),
        challenge: randomBytes(32),
        allowCredentials: [{ type: "public-key", id: b64url.dec(credentialId), transports: transports as AuthenticatorTransport[] | undefined }],
        userVerification: "required",
        timeout: 120_000,
        extensions: { prf: { eval: { first: enc.encode(prfSalt) } } } as AuthenticationExtensionsClientInputs,
      },
    })) as PublicKeyCredential | null;
  } catch (e) {
    throw translate(e);
  }
  if (!cred) throw new PasskeyCancelledError();
  const ext = cred.getClientExtensionResults() as { prf?: { results?: { first?: ArrayBuffer } } };
  const first = ext.prf?.results?.first;
  if (!first) throw new PrfUnsupportedError("The authenticator returned no PRF output. Use a passkey that supports PRF, or your recovery code.");
  return new Uint8Array(first);
}
