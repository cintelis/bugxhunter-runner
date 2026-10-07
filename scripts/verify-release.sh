#!/bin/sh
# Verify a BugXHunter release before using it:
#
#   scripts/verify-release.sh v1.2.3            # in a folder holding any downloaded archives
#
# 1. checksums.txt is signed with the Cintelis release key (ssh-keygen -Y verify)
# 2. every archive in the current folder matches the signed checksums
# 3. prints the signed image digests, so you can pull the images by digest
# 4. if gh is installed: the archives and images were built by this repo's
#    release workflow (build provenance attestation)
# Needs: curl, ssh-keygen (OpenSSH 8.1+), sha256sum or shasum.
set -eu

REPO="cintelis/bugxhunter-runner"
NS="bugxhunter-release"
# the release signing key; also in scripts/release_key.pub and SECURITY.md
RELEASE_KEY="ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOCB3IaMc3Lc4JvPv6rWCVLpTjmvvPrhFFPST0NSsypP"
tag="${1:?usage: scripts/verify-release.sh vX.Y.Z}"
base="https://github.com/$REPO/releases/download/$tag"

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
for f in checksums.txt checksums.txt.sig images.txt; do
  curl -fsSL "$base/$f" -o "$tmp/$f"
done

command -v ssh-keygen >/dev/null 2>&1 || { echo "ssh-keygen (OpenSSH 8.1+) is needed to check the signature" >&2; exit 1; }
printf '%s namespaces="%s" %s\n' "$NS" "$NS" "$RELEASE_KEY" > "$tmp/allowed_signers"
if ! ssh-keygen -Y verify -f "$tmp/allowed_signers" -I "$NS" -n "$NS" \
  -s "$tmp/checksums.txt.sig" < "$tmp/checksums.txt" >/dev/null 2>&1; then
  echo "$tag: checksums.txt is NOT signed with the Cintelis release key — do not use it" >&2
  exit 1
fi
echo "signature: OK (checksums.txt signed with the Cintelis release key)"

cp "$tmp/checksums.txt" "$tmp/images.txt" .
if command -v sha256sum >/dev/null 2>&1; then
  sha256sum --ignore-missing -c checksums.txt
else
  shasum -a 256 --ignore-missing -c checksums.txt
fi

echo
echo "signed image digests (pull these, not a mutable tag):"
sed 's/^/  docker pull /' images.txt

if command -v gh >/dev/null 2>&1; then
  echo
  echo "build provenance:"
  for f in ./*.tar.gz; do
    [ -f "$f" ] && gh attestation verify "$f" -R "$REPO" >/dev/null && echo "  $f: built by the release workflow"
  done
  while IFS= read -r image; do
    [ -n "$image" ] && gh attestation verify "oci://$image" -R "$REPO" >/dev/null && echo "  ${image%%@*}: built by the release workflow"
  done < images.txt
fi
