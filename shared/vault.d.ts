/**
 * The key vault: secrets sealed at rest with keys only the user holds.
 *
 * On disk (vault.json) there is only ciphertext and wrapped keys. The browser
 * derives a key-encryption key (KEK) from the user's unlock method, unwraps the
 * data-encryption key (DEK) and hands the DEK to the backend, which keeps it in
 * memory only and uses it to decrypt the items. A copy of the file, the volume
 * or the container is useless without an unlock.
 *
 * Primitives are symmetric only — AES-256-GCM, HKDF-SHA-256, PBKDF2-SHA-256,
 * and the WebAuthn PRF extension (an HMAC inside the authenticator) — so the
 * design does not depend on any public-key scheme a quantum computer breaks.
 *
 * Unlock methods:
 *  - passkey: KEK = HKDF(PRF(credential, prfSalt) || PBKDF2(passphrase)).
 *    Two factors, both required: the authenticator and the passphrase.
 *  - recovery: KEK = PBKDF2(recovery code). A 128-bit random code shown once
 *    at setup, for when the passkey is lost.
 */

/** AES-256-GCM output: 12-byte IV and ciphertext with the 16-byte tag appended, both base64. */
export interface Sealed {
  iv: string;
  ct: string;
}

export interface Pbkdf2Params {
  name: "PBKDF2";
  hash: "SHA-256";
  iterations: number;
  /** base64 */
  salt: string;
}

export interface PasskeyMethod {
  type: "passkey";
  /** Stable id; also the AAD of `wrapped`. */
  id: string;
  label: string;
  /** base64url credential id, passed back as allowCredentials. */
  credentialId: string;
  transports?: string[];
  /**
   * The credential's public key (SPKI DER, base64) and COSE algorithm, so the
   * same passkey also signs people in: the server verifies WebAuthn assertions
   * against it. Absent on vaults created before sign-in existed.
   */
  publicKey?: string;
  alg?: number;
  /** Last authenticator signature counter seen (0 when the authenticator doesn't count). */
  signCount?: number;
  /** The PRF salt is fixed per method; changing it changes the derived secret. */
  prfSalt: string;
  passphrase: Pbkdf2Params;
  /** base64 HKDF salt. */
  hkdfSalt: string;
  /** The DEK, wrapped with the KEK. */
  wrapped: Sealed;
  createdAt: string;
}

export interface RecoveryMethod {
  type: "recovery";
  id: string;
  label: string;
  kdf: Pbkdf2Params;
  wrapped: Sealed;
  createdAt: string;
}

export type VaultMethod = PasskeyMethod | RecoveryMethod;

export interface VaultDoc {
  version: 1;
  createdAt: string;
  methods: VaultMethod[];
  /** AES-256-GCM(DEK, "bugxhunter-vault-ok", aad "verifier"): proves an unseal key is right. */
  verifier: Sealed;
  /** Secret name -> sealed value. AAD is the name, so values can't be swapped between names. */
  items: Record<string, Sealed>;
}

/**
 * The public half of an unlock method: everything the browser needs to derive
 * a KEK and unwrap, nothing that helps without the factors. Served to the
 * sign-in screen too (GET /api/auth/methods), since sign-in uses the same
 * passkeys.
 */
export type PublicMethod =
  | (Omit<PasskeyMethod, "publicKey" | "signCount"> & { canLogin: boolean })
  | RecoveryMethod;

/** GET /api/vault */
export interface VaultStatus {
  /** No vault.json yet: setup wizard. */
  initialised: boolean;
  /** DEK in memory. */
  unsealed: boolean;
  methods: PublicMethod[];
  /** Names of the sealed items (never values). */
  items: string[];
  /** Where the model key comes from right now. */
  keySource: "vault" | "env" | "opencode-auth" | "none";
  /** Auto-lock after this long idle; 0 = never. */
  idleMinutes: number;
  /** When the auto-lock fires (ms since epoch), while unsealed. */
  sealsAt: number | null;
}

/** The item names the app understands. Others are allowed (custom secrets). */
export type KnownItem = "SCX_API";

// --- sign-in -------------------------------------------------------------------

/** GET /api/auth/me */
export interface AuthMe {
  /** A passkey that can sign in exists, so the API is gated. */
  required: boolean;
  authenticated: boolean;
}

/** POST /api/auth/challenge */
export interface AuthChallenge {
  /** base64url, single use, short-lived. */
  challenge: string;
  rpId: string;
  allowCredentials: { id: string; transports?: string[] }[];
}

/** POST /api/auth/passkey: the assertion, fields base64url as the browser gives them. */
export interface PasskeyAssertion {
  credentialId: string;
  clientDataJSON: string;
  authenticatorData: string;
  signature: string;
}
