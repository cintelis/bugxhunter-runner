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
