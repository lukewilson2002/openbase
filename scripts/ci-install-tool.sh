#!/usr/bin/env bash
# Installs one of the security scanners CI uses, from its official release, after checking the
# download against a SHA-256 pinned here: cargo-deny, gitleaks or trivy (Linux x86_64 only, which is
# what the CI runners are).
#
#   scripts/ci-install-tool.sh cargo-deny|gitleaks|trivy
#
# Why not a marketplace action: these run with read access to the whole repository, and the Trivy
# action's tags were once rewritten by an attacker. A pinned checksum of the binary itself needs no
# trust in anyone's tags. Dependabot cannot update these pins, so bump them by hand now and then: take
# the new version from the project's release page and the checksum from its checksums file (or, for
# cargo-deny, `gh api repos/EmbarkStudios/cargo-deny/releases/latest`), and change both lines below.
# The vulnerability databases the scanners use are fetched fresh on every run, so an old scanner
# version still sees new advisories.
#
# Local developers do not use this: install the tools with your package manager (see CONTRIBUTING.md).
set -euo pipefail

tool="${1:-}"
case "$tool" in
  cargo-deny)
    version=0.20.2
    sha256=9f12ed4c49936e09b48bf862b595cde2fe64fcbd9d74dfacac6131ca824c8d5f
    url="https://github.com/EmbarkStudios/cargo-deny/releases/download/${version}/cargo-deny-${version}-x86_64-unknown-linux-musl.tar.gz"
    ;;
  gitleaks)
    version=8.30.1
    sha256=551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb
    url="https://github.com/gitleaks/gitleaks/releases/download/v${version}/gitleaks_${version}_linux_x64.tar.gz"
    ;;
  trivy)
    version=0.76.2
    sha256=bc0fc726e017b8927a62b2d3531d7a84ee01769daf5c99ed866dced54089fdbf
    url="https://github.com/aquasecurity/trivy/releases/download/v${version}/trivy_${version}_Linux-64bit.tar.gz"
    ;;
  *)
    echo "usage: $0 cargo-deny|gitleaks|trivy" >&2
    exit 2
    ;;
esac

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
bin="${CI_TOOL_BIN:-${RUNNER_TEMP:-$HOME/.local}/bin}"
mkdir -p "$bin"

curl --fail --silent --show-error --location --retry 5 --retry-all-errors \
  --output "$work/tool.tar.gz" "$url"
echo "${sha256}  $work/tool.tar.gz" | sha256sum --check --strict -

mkdir "$work/x"
tar -xzf "$work/tool.tar.gz" -C "$work/x"
# cargo-deny unpacks into a versioned directory, the others into the root.
found="$(find "$work/x" -type f -name "$tool" | head -n 1)"
[[ -n "$found" ]] || { echo "$tool is not in the archive" >&2; exit 1; }
install -m 0755 "$found" "$bin/$tool"

if [[ -n "${GITHUB_PATH:-}" ]]; then
  echo "$bin" >> "$GITHUB_PATH"
fi
echo "Installed $tool $version in $bin"
