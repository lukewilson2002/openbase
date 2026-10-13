#!/usr/bin/env bash
# Prepare a release on your machine: bump the version everywhere, write the changelog section, run
# the full checks, commit "Release vX.Y.Z" and create an annotated tag. It does NOT push and does
# NOT publish anything; at the end it prints the two commands that do (see docs/releasing.md).
#
#   scripts/release.sh X.Y.Z [--skip-checks] [--allow-branch]
#
#   X.Y.Z           the new version, e.g. 0.2.0 or 1.0.0-rc.1 (a leading "v" is accepted)
#   --skip-checks   do not run scripts/check.sh (CI runs everything again when you publish)
#   --allow-branch  allow a branch other than main (a release candidate from a branch, tests)
#
# What it changes (and nothing else):
#   Cargo.toml                 [workspace.package] version
#   Cargo.lock                 the openbase and ob-core entries (via cargo)
#   web/package.json, web/package-lock.json   the version (via npm)
#   CHANGELOG.md               the Unreleased notes become the section for this version
#
# The binary's `openbase --version` and /api/health report CARGO_PKG_VERSION, i.e. the Cargo.toml
# version, so the bump above is all they need. The first release of a tree whose Cargo.toml already
# says that version (0.1.0 today) skips the bump and only dates the changelog section.
set -euo pipefail
cd "$(dirname "$0")/.."

REPO_URL=https://github.com/lukewilson2002/openbase

die() { printf 'release: %s\n' "$*" >&2; exit 1; }
step() { printf '\n==> %s\n' "$*"; }

VERSION=""
SKIP_CHECKS=false
ALLOW_BRANCH=false
for arg in "$@"; do
  case "$arg" in
    --skip-checks) SKIP_CHECKS=true ;;
    --allow-branch) ALLOW_BRANCH=true ;;
    -h | --help) sed -n '2,19p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    -*) die "unknown option: $arg" ;;
    *) [[ -z "$VERSION" ]] || die "give the version once"; VERSION=${arg#v} ;;
  esac
done
[[ -n "$VERSION" ]] || die "usage: scripts/release.sh X.Y.Z [--skip-checks] [--allow-branch]"
TAG=v$VERSION

# ---------------------------------------------------------------- preconditions
# Syntax and the rule for tags are shared with the release workflow.
scripts/release-info.sh "$TAG" --no-version-check >/dev/null

branch=$(git rev-parse --abbrev-ref HEAD)
if [[ "$branch" != main && "$ALLOW_BRANCH" != true ]]; then
  die "you are on '$branch'. Releases are made from main (merge first), or pass --allow-branch."
fi
[[ -z "$(git status --porcelain)" ]] || die "the working tree is not clean. Commit or stash your changes first."
if git rev-parse -q --verify "refs/tags/$TAG" >/dev/null; then die "tag $TAG already exists."; fi

CURRENT=$(awk '
  /^\[workspace\.package\]/ { in_section = 1; next }
  /^\[/                     { in_section = 0 }
  in_section && /^version[[:space:]]*=/ { gsub(/^[^"]*"|".*$/, ""); print; exit }
' Cargo.toml)
[[ -n "$CURRENT" ]] || die "cannot read the workspace version from Cargo.toml."

FIRST_RELEASE=false
if [[ "$VERSION" == "$CURRENT" ]]; then
  # Only legitimate before the first tag exists for this tree, with a changelog section waiting.
  grep -q "^## \[$VERSION\] - unreleased" CHANGELOG.md \
    || die "Cargo.toml is already at $CURRENT and CHANGELOG.md has no '## [$VERSION] - unreleased' section. Pick a newer version."
  FIRST_RELEASE=true
else
  # Compare the numbers only: 1.0.0-rc.1 -> 1.0.0 and rc.1 -> rc.2 are fine, 0.2.0 -> 0.1.9 is not.
  vcore=${VERSION%%-*}
  ccore=${CURRENT%%-*}
  if [[ "$vcore" != "$ccore" && "$(printf '%s\n%s\n' "$ccore" "$vcore" | sort -V | tail -n 1)" != "$vcore" ]]; then
    die "$VERSION is not newer than the current version $CURRENT."
  fi
fi
[[ -f CHANGELOG.md ]] || die "CHANGELOG.md is missing."
grep -q '^## \[Unreleased\]' CHANGELOG.md || die "CHANGELOG.md has no '## [Unreleased]' heading."
command -v npm >/dev/null || die "npm is needed to bump the web client's version."
command -v cargo >/dev/null || die "cargo is needed to update Cargo.lock."

# ---------------------------------------------------------------------- versions
step "Version $CURRENT -> $VERSION"
if [[ "$FIRST_RELEASE" == false ]]; then
  tmp=$(mktemp)
  awk -v v="$VERSION" '
    /^\[workspace\.package\]/ { in_section = 1 }
    /^\[/ && !/^\[workspace\.package\]/ { in_section = 0 }
    in_section && !done && /^version[[:space:]]*=/ { print "version = \"" v "\""; done = 1; next }
    { print }
  ' Cargo.toml >"$tmp"
  cat "$tmp" >Cargo.toml
  rm -f "$tmp"
  # Refresh only the workspace members' entries in Cargo.lock; no dependency is touched.
  cargo update --workspace --offline >/dev/null 2>&1 || cargo update --workspace >/dev/null
  (cd web && npm version "$VERSION" --no-git-tag-version --ignore-scripts --allow-same-version >/dev/null)
fi
# Whatever happens, these must now agree (also what the release workflow checks).
scripts/release-info.sh "$TAG" >/dev/null

# --------------------------------------------------------------------- changelog
step "CHANGELOG.md"
today=$(date -u +%Y-%m-%d)
if [[ "$FIRST_RELEASE" == true ]]; then
  tmp=$(mktemp)
  awk -v v="$VERSION" -v d="$today" '
    $0 == "## [" v "] - unreleased" { print "## [" v "] - " d; next }
    { print }
  ' CHANGELOG.md >"$tmp"
  cat "$tmp" >CHANGELOG.md
  rm -f "$tmp"
else
  # Notes written under "Unreleased"; if there are none, start from the commit subjects.
  notes=$(awk '/^## \[Unreleased\]/ { grab = 1; next } /^## \[/ { grab = 0 } grab' CHANGELOG.md)
  if [[ -z "$(tr -d '[:space:]' <<<"$notes")" ]]; then
    last_tag=$(git describe --tags --abbrev=0 --match 'v[0-9]*' 2>/dev/null || true)
    range=${last_tag:+$last_tag..}HEAD
    notes=$(printf '### Changed\n\n'; git log --no-merges --pretty='- %s' "$range")
    printf 'No notes under Unreleased: using the commit subjects since %s. Edit CHANGELOG.md before publishing if you want better ones.\n' "${last_tag:-the beginning}"
  fi
  tmp=$(mktemp)
  NOTES=$notes awk -v v="$VERSION" -v d="$today" -v cur="$CURRENT" -v repo="$REPO_URL" '
    /^## \[Unreleased\]/ {
      print; print ""
      print "## [" v "] - " d; print ""
      print ENVIRON["NOTES"]; print ""
      skipping = 1; next
    }
    /^## \[/ { skipping = 0 }
    skipping { next }
    /^\[Unreleased\]:/ {
      print "[Unreleased]: " repo "/compare/v" v "...HEAD"
      print "[" v "]: " repo "/compare/v" cur "...v" v
      next
    }
    { print }
  ' CHANGELOG.md >"$tmp"
  cat "$tmp" >CHANGELOG.md
  rm -f "$tmp"
fi

# The text of this version's section, used for the tag message (and so for the GitHub Release).
section=$(awk -v v="$VERSION" '
  index($0, "## [" v "]") == 1 { grab = 1; next }
  /^## \[/ { grab = 0 }
  /^\[[^]]+\]: / { grab = 0 }
  grab
' CHANGELOG.md |
  awk '{ l[NR] = $0 } END { s = 1; e = NR; while (s <= e && l[s] ~ /^[[:space:]]*$/) s++; while (e >= s && l[e] ~ /^[[:space:]]*$/) e--; for (i = s; i <= e; i++) print l[i] }')
[[ -n "$(tr -d '[:space:]' <<<"$section")" ]] || die "the changelog section for $VERSION is empty."

# ------------------------------------------------------------------------ checks
if [[ "$SKIP_CHECKS" == true ]]; then
  step "Skipping scripts/check.sh (--skip-checks)"
else
  step "scripts/check.sh"
  scripts/check.sh
fi

# ------------------------------------------------------------- commit and tag
step "Commit and tag"
git add Cargo.toml Cargo.lock web/package.json web/package-lock.json CHANGELOG.md
git commit -q -m "Release $TAG"
notes_file=$(mktemp)
{
  printf 'OpenBase %s\n\n' "$VERSION"
  printf '%s\n' "$section"
} >"$notes_file"
git tag -a "$TAG" --cleanup=verbatim -F "$notes_file"
rm -f "$notes_file"
git --no-pager log --oneline -1
git --no-pager tag -n1 --list "$TAG"

pre=""
[[ "$VERSION" == *-* ]] && pre=" --prerelease"
cat <<EOF

Release $TAG is prepared locally. Nothing has been pushed or published yet.

  Review:    git show $TAG
  Undo:      git tag -d $TAG && git reset --hard HEAD~1

Publishing is two commands. The first only uploads the commit and the tag (it deploys nothing);
the second creates the GitHub Release, which is what starts the build and publishes the image:

  git push origin ${branch} --follow-tags
  gh release create $TAG --verify-tag --title "OpenBase $VERSION" --notes-from-tag${pre}

Then watch the run: gh run watch   (or the Actions tab). See docs/releasing.md.
EOF
