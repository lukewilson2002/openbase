#!/usr/bin/env bash
# Validate a release tag against the source tree and work out what to publish for it.
# Used by .github/workflows/release.yml (and runnable by hand); it changes nothing.
#
#   scripts/release-info.sh vX.Y.Z [--github-prerelease true|false] [--no-version-check]
#
# Run it in a checkout of the tag with the tags fetched (git fetch --tags). It fails unless
#   - the tag is vMAJOR.MINOR.PATCH or vMAJOR.MINOR.PATCH-prerelease (semver, no build metadata);
#   - the workspace version in Cargo.toml, the openbase and ob-core entries of Cargo.lock,
#     web/package.json and web/package-lock.json all equal the tag without the leading "v".
#     scripts/release.sh keeps these in step. (--no-version-check skips this, for tests.)
#
# On success it prints key=value lines (the workflow appends them to $GITHUB_OUTPUT):
#   version     1.2.3 or 1.2.3-rc.1
#   prerelease  true when the version has a "-suffix" or --github-prerelease true was given
#   tags        comma-separated Docker image tags to publish:
#                 prerelease: just the exact version (1.2.3-rc.1);
#                 stable:     1.2.3 always, plus 1.2 if this is the highest 1.2.x release, plus 1
#                             if it is the highest 1.x.y release (not for major 0, where a minor
#                             version may break things), plus latest if it is the highest stable
#                             release overall. So a 1.2.9 patch for an old line never moves latest.
set -euo pipefail
cd "$(dirname "$0")/.."

die() { printf 'release-info: %s\n' "$*" >&2; exit 1; }

TAG=${1:-}
[[ -n "$TAG" ]] || die "usage: $0 vX.Y.Z [--github-prerelease true|false] [--no-version-check]"
shift
GH_PRERELEASE=false
CHECK_VERSIONS=true
while [[ $# -gt 0 ]]; do
  case "$1" in
    --github-prerelease) GH_PRERELEASE=${2:?--github-prerelease needs true or false}; shift 2 ;;
    --no-version-check) CHECK_VERSIONS=false; shift ;;
    *) die "unknown argument: $1" ;;
  esac
done
[[ "$GH_PRERELEASE" == true || "$GH_PRERELEASE" == false ]] || die "--github-prerelease must be true or false"

IDENT='[0-9A-Za-z-]+'
SEMVER_RE="^v(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)(-${IDENT}(\\.${IDENT})*)?\$"
[[ "$TAG" =~ $SEMVER_RE ]] || die "'$TAG' is not a release tag. Use vMAJOR.MINOR.PATCH, for example v1.2.3, or v1.2.3-rc.1 for a pre-release."
VERSION=${TAG#v}
CORE=${VERSION%%-*}
IFS=. read -r MAJOR MINOR _ <<<"$CORE"

if [[ "$CHECK_VERSIONS" == true ]]; then
  # [workspace.package] version = "x" in the root manifest.
  cargo_version=$(awk '
    /^\[workspace\.package\]/ { in_section = 1; next }
    /^\[/                     { in_section = 0 }
    in_section && /^version[[:space:]]*=/ { gsub(/^[^"]*"|".*$/, ""); print; exit }
  ' Cargo.toml)
  lock_version() { # crate name -> version recorded in Cargo.lock
    awk -v want="$1" '
      /^name = / { name = $3; gsub(/"/, "", name) }
      /^version = / && name == want { v = $3; gsub(/"/, "", v); print v; exit }
    ' Cargo.lock
  }
  web_version=$(jq -r .version web/package.json)
  web_lock_version=$(jq -r .version web/package-lock.json)
  web_lock_root_version=$(jq -r '.packages[""].version' web/package-lock.json)

  mismatch=0
  check() { # label found
    if [[ "$2" != "$VERSION" ]]; then
      printf 'release-info: %s is "%s" but the tag %s means "%s".\n' "$1" "$2" "$TAG" "$VERSION" >&2
      mismatch=1
    fi
  }
  check "Cargo.toml [workspace.package] version" "$cargo_version"
  check "Cargo.lock openbase" "$(lock_version openbase)"
  check "Cargo.lock ob-core" "$(lock_version ob-core)"
  check "web/package.json version" "$web_version"
  check "web/package-lock.json version" "$web_lock_version"
  check "web/package-lock.json packages[\"\"].version" "$web_lock_root_version"
  [[ $mismatch -eq 0 ]] || die "version mismatch: run scripts/release.sh ${VERSION}, or tag the commit that carries the version."
fi

prerelease=false
if [[ "$VERSION" == *-* || "$GH_PRERELEASE" == true ]]; then prerelease=true; fi

tags=$VERSION
if [[ "$prerelease" == false ]]; then
  # Every stable release tag that exists (this one included even if it is not fetched yet).
  stable=$( { git tag --list 'v*' || true; printf '%s\n' "$TAG"; } | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' | sort -uV)
  highest() { sort -V | tail -n 1; }
  [[ $(highest <<<"$stable") == "$TAG" ]] && latest=true || latest=false
  [[ $(grep -E "^v${MAJOR}\\." <<<"$stable" | highest) == "$TAG" ]] && top_major=true || top_major=false
  [[ $(grep -E "^v${MAJOR}\\.${MINOR}\\." <<<"$stable" | highest) == "$TAG" ]] && top_minor=true || top_minor=false
  [[ $top_minor == true ]] && tags+=",${MAJOR}.${MINOR}"
  [[ $top_major == true && $MAJOR != 0 ]] && tags+=",${MAJOR}"
  [[ $latest == true ]] && tags+=",latest"
fi

printf 'version=%s\n' "$VERSION"
printf 'prerelease=%s\n' "$prerelease"
printf 'tags=%s\n' "$tags"
