#!/usr/bin/env bash
# Prepare a release on your machine: bump the version everywhere, write the changelog section, run
# the full checks, commit "Release vX.Y.Z" and create an annotated tag. It does NOT push and does
# NOT publish anything; at the end it prints the two commands that do (see docs/releasing.md).
#
#   scripts/release.sh X.Y.Z [--skip-checks] [--allow-branch] [--notes-from-commits]
#
#   X.Y.Z                 the new version, e.g. 0.2.0 or 1.0.0-rc.1 (a leading "v" is accepted)
#   --skip-checks         do not run scripts/check.sh (CI runs everything again when you publish)
#   --allow-branch        allow a branch other than main (a release candidate from a branch, tests)
#   --notes-from-commits  when there are no notes under "Unreleased" in CHANGELOG.md, use the commit
#                         subjects since the previous release tag instead of refusing
#
# What it changes (and nothing else):
#   Cargo.toml                 [workspace.package] version
#   Cargo.lock                 the openbase and ob-core entries (via cargo)
#   web/package.json, web/package-lock.json   the version (via npm)
#   CHANGELOG.md               the Unreleased notes become the section for this version, and the
#                              [Unreleased] and [X.Y.Z] links at the bottom point at tags that exist:
#                              a comparison with the previous release tag (the previous stable one for
#                              a stable release), or the release page when there is no previous tag
#
# The binary's `openbase --version` and /api/health report CARGO_PKG_VERSION, i.e. the Cargo.toml
# version, so the bump above is all they need. A release whose version Cargo.toml already has, with a
# "## [X.Y.Z] - unreleased" section waiting in CHANGELOG.md, skips the bump and only dates that section.
set -euo pipefail
cd "$(dirname "$0")/.."

REPO_URL=https://github.com/lukewilson2002/openbase

die() { printf 'release: %s\n' "$*" >&2; exit 1; }
step() { printf '\n==> %s\n' "$*"; }

VERSION=""
SKIP_CHECKS=false
ALLOW_BRANCH=false
NOTES_FROM_COMMITS=false
for arg in "$@"; do
  case "$arg" in
    --skip-checks) SKIP_CHECKS=true ;;
    --allow-branch) ALLOW_BRANCH=true ;;
    --notes-from-commits) NOTES_FROM_COMMITS=true ;;
    -h | --help) awk 'NR > 1 && /^#/ { sub(/^# ?/, ""); print; next } NR > 1 { exit }' "$0"; exit 0 ;;
    -*) die "unknown option: $arg" ;;
    *) [[ -z "$VERSION" ]] || die "give the version once"; VERSION=${arg#v} ;;
  esac
done
[[ -n "$VERSION" ]] || die "usage: scripts/release.sh X.Y.Z [--skip-checks] [--allow-branch] [--notes-from-commits]"
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

# The release this one follows, for the changelog link and for --notes-from-commits: the nearest
# release tag before HEAD. A stable release is measured against the nearest stable one (a release
# candidate does not count) when there is one, else against the nearest tag of any kind. Empty when
# no release tag exists yet.
PREV_TAG=""
[[ "$VERSION" == *-* ]] || PREV_TAG=$(git describe --tags --abbrev=0 --match 'v[0-9]*' --exclude 'v*-*' 2>/dev/null || true)
[[ -n "$PREV_TAG" ]] || PREV_TAG=$(git describe --tags --abbrev=0 --match 'v[0-9]*' 2>/dev/null || true)

# Where the notes come from, checked now so that a refusal leaves the tree untouched:
#   section  CHANGELOG.md already has "## [X.Y.Z] - unreleased" (written ahead of the release): date it
#   notes    the text under "## [Unreleased]"
#   commits  the commit subjects since PREV_TAG, only with --notes-from-commits
trim_blank_lines() {
  awk '{ l[NR] = $0 } END { s = 1; e = NR; while (s <= e && l[s] ~ /^[[:space:]]*$/) s++; while (e >= s && l[e] ~ /^[[:space:]]*$/) e--; for (i = s; i <= e; i++) print l[i] }'
}
UNRELEASED_NOTES=$(awk '/^## \[Unreleased\]/ { grab = 1; next } /^## \[/ { grab = 0 } /^\[[^]]+\]: / { grab = 0 } grab' CHANGELOG.md | trim_blank_lines)
if grep -q "^## \[$VERSION\] - unreleased" CHANGELOG.md; then
  [[ -z "$UNRELEASED_NOTES" ]] \
    || die "CHANGELOG.md has notes under '## [Unreleased]' and a '## [$VERSION] - unreleased' section. Move the notes into that section (or drop the section), then run this again."
  NOTES_SOURCE=section
elif [[ -n "$UNRELEASED_NOTES" ]]; then
  NOTES_SOURCE=notes
elif [[ "$NOTES_FROM_COMMITS" == true ]]; then
  NOTES_SOURCE=commits
else
  die "there are no release notes: CHANGELOG.md has nothing under '## [Unreleased]'.
Write what changed for users there (### Added / Changed / Fixed ...) and run this again, or pass
--notes-from-commits to use the commit subjects since ${PREV_TAG:-the beginning} (a poor changelog)."
fi

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
step "CHANGELOG.md ($NOTES_SOURCE)"
today=$(date -u +%Y-%m-%d)
if [[ "$NOTES_SOURCE" == section ]]; then
  tmp=$(mktemp)
  awk -v v="$VERSION" -v d="$today" '
    $0 == "## [" v "] - unreleased" { print "## [" v "] - " d; next }
    { print }
  ' CHANGELOG.md >"$tmp"
  cat "$tmp" >CHANGELOG.md
  rm -f "$tmp"
else
  if [[ "$NOTES_SOURCE" == commits ]]; then
    range=${PREV_TAG:+$PREV_TAG..}HEAD
    commits=$(git log --no-merges --invert-grep --grep='^Release v' --pretty='- %s' "$range")
    [[ -n "$commits" ]] || die "there are no commits since ${PREV_TAG:-the beginning} to take notes from."
    UNRELEASED_NOTES=$(printf '### Changed\n\n%s' "$commits")
    printf 'Using the commit subjects since %s as the notes. Edit CHANGELOG.md before publishing if you want better ones.\n' "${PREV_TAG:-the beginning}"
  fi
  tmp=$(mktemp)
  NOTES=$UNRELEASED_NOTES awk -v v="$VERSION" -v d="$today" '
    /^## \[Unreleased\]/ {
      print; print ""
      print "## [" v "] - " d; print ""
      print ENVIRON["NOTES"]; print ""
      skipping = 1; next
    }
    /^## \[/ { skipping = 0 }
    /^\[[^]]+\]: / { skipping = 0 }
    skipping { next }
    { print }
  ' CHANGELOG.md >"$tmp"
  cat "$tmp" >CHANGELOG.md
  rm -f "$tmp"
fi

# The links at the bottom: [Unreleased] compares the new tag with HEAD; [X.Y.Z] compares the previous
# release tag with the new one, or, when there is no previous tag, is the release's own page. A link to
# a tag that does not exist (the old "v<current version>...") would be a dead link on GitHub.
if [[ -n "$PREV_TAG" ]]; then
  version_link="$REPO_URL/compare/$PREV_TAG...$TAG"
else
  version_link="$REPO_URL/releases/tag/$TAG"
fi
tmp=$(mktemp)
awk -v v="$VERSION" -v unreleased="$REPO_URL/compare/$TAG...HEAD" -v link="$version_link" '
  /^\[Unreleased\]: / { print "[Unreleased]: " unreleased; print "[" v "]: " link; seen = 1; next }
  index($0, "[" v "]: ") == 1 { next }
  { print }
  END { if (!seen) { print ""; print "[Unreleased]: " unreleased; print "[" v "]: " link } }
' CHANGELOG.md >"$tmp"
cat "$tmp" >CHANGELOG.md
rm -f "$tmp"

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
