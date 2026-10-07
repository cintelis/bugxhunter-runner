# Security

## Reporting a vulnerability

Please report privately through GitHub:
**[Report a vulnerability](https://github.com/cintelis/bugxhunter-runner/security/advisories/new)**.
Don't open a public issue for security problems.

## How releases are protected

- **Signed.** Every release's `checksums.txt` is signed with the Cintelis
  release key, an Ed25519 key kept offline by the maintainer and never
  stored on GitHub. It covers the release archives and `images.txt`, which
  pins both container images by digest. `scripts/verify-release.sh` refuses
  any release whose signature doesn't verify.
- **Built by CI, with provenance.** Release archives and images are built by
  this repository's release workflow and carry a signed build-provenance
  attestation. The workflow produces a *draft*; the maintainer checks the
  attestations and checksums before signing and publishing it
  (`scripts/sign-release.sh`).
- **Protected tags.** Only repository admins can create, move or delete
  `v*` tags.
- **Pinned dependencies.** npm packages are pinned by hash in the lockfile;
  the release workflow's GitHub Actions are pinned to commits; the agent
  image's security tools are pinned to specific versions. CodeQL scans every
  change and weekly, and Dependabot tracks updates.

## The key vault

API keys and other secrets the app holds are sealed at rest in `vault.json`
(`shared/vault.d.ts` is the format). What an attacker who copies the file, the
`runner-data` volume or the whole container gets is ciphertext and wrapped keys.

- **Two factors to unlock.** The key-encryption key is HKDF-SHA-256 over the
  concatenation of the passkey's WebAuthn PRF output (an HMAC computed inside
  the authenticator; the seed never leaves it) and PBKDF2-SHA-256 of the
  passphrase. Neither factor alone unwraps anything. A recovery code (128 random
  bits, shown once) is the alternative, for a lost passkey.
- **Symmetric only.** AES-256-GCM, HKDF-SHA-256, PBKDF2-SHA-256 (600k iterations)
  and the PRF. No RSA or elliptic-curve step protects the data, so the design does
  not depend on anything a quantum computer is expected to break; 256-bit
  symmetric keys keep their margin against Grover's algorithm.
- **The server never sees a factor.** The browser derives the key-encryption key,
  unwraps the data key and hands only that to the backend, which keeps it in memory
  until the vault is locked, the process exits, or `OPEN_RUNNER_VAULT_IDLE_MINUTES`
  (default 120) pass without a model call or an API write. Items are bound to their
  names (AES-GCM additional data), so a ciphertext can't be moved between names.
- **The agent never sees the key.** In Docker it talks to a key-injecting proxy.
  In local mode the backend removes every secret from its environment before
  OpenCode is spawned, since the agent's shell inherits that environment.
- **Sign-in is the passkey.** No passwords exist. With a vault present, every API
  call needs a session issued for a WebAuthn assertion the server verified:
  single-use challenge, allowed origin, relying-party hash, user-presence and
  user-verification flags, signature against the public key captured at
  enrolment, and a monotonic counter where the authenticator keeps one. The
  recovery code signs in by proving possession of the vault key. Without a
  vault the app is open, on localhost only, behind the Host-header guard.
- **Break-glass is on the server only.** Losing the passkey and the recovery
  code means the secrets are gone; `npm run vault:reset` deletes the vault from
  the server's files and reopens the app for a new setup. No network request
  can do that.
- **Not covered.** A compromise of the running backend while unlocked exposes
  what it holds in memory; that is inherent to a server that uses the key. Model
  inputs and tool output go to the model provider in plaintext; the vault seals
  secrets, not engagements.

## Verifying a release yourself

The release public key:

```
ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOCB3IaMc3Lc4JvPv6rWCVLpTjmvvPrhFFPST0NSsypP cintelis-release
```

Fingerprint: `SHA256:RY9yd61LBZCa5WrzSkEet+1Dnt2zVu9zpMRbZMWIV+I`

It is also published on our domain, so you can cross-check it through a
second channel: <https://cintelis.ai/.well-known/cintelis-release.pub>

The quick way, from a folder holding whatever you downloaded:

```sh
scripts/verify-release.sh v1.2.3
```

By hand:

```sh
# 1. the checksums are signed by the release key
echo 'bugxhunter-release namespaces="bugxhunter-release" ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOCB3IaMc3Lc4JvPv6rWCVLpTjmvvPrhFFPST0NSsypP' > allowed_signers
ssh-keygen -Y verify -f allowed_signers -I bugxhunter-release -n bugxhunter-release \
  -s checksums.txt.sig < checksums.txt

# 2. your archives (and images.txt) match the signed checksums
sha256sum --ignore-missing -c checksums.txt

# 3. pull the images by the digests in the signed images.txt, not by tag
docker pull "$(sed -n 1p images.txt)"
docker pull "$(sed -n 2p images.txt)"

# 4. optionally, they were built by this repository's release workflow
gh attestation verify bugxhunter-runner_<version>_app.tar.gz --repo cintelis/bugxhunter-runner
gh attestation verify oci://ghcr.io/cintelis/bugxhunter-runner:v<version> --repo cintelis/bugxhunter-runner
```
