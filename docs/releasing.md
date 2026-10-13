# Releasing OpenBase (maintainer guide)

The rule: **only publishing a GitHub Release builds and publishes anything.** A push or merge to
`main` runs the checks (`ci.yml`) and nothing else. It cannot move a Docker tag, upload a binary
or deploy anything to anyone. Users get an update when you publish a release, and only if they
pull it (or opted in to the automatic updater, which follows the tag they chose).

```
you:   scripts/release.sh 0.2.0        bump, changelog, checks, commit, tag   (local, publishes nothing)
you:   git push origin main --follow-tags                                     (uploads code; deploys nothing)
you:   gh release create v0.2.0 --verify-tag --notes-from-tag                 <- THIS publishes
CI:    release.yml: verify tag -> full checks -> web once -> amd64 + arm64 -> smoke test
                    -> push ghcr.io/lukewilson2002/openbase:{0.2.0,0.2,latest}
                    -> attach binaries + SHA256SUMS to the release
users: docker compose pull && docker compose up -d
```

## Contents

[One-time setup](#one-time-setup) · [Making a release](#making-a-release) ·
[Pre-releases](#pre-releases) · [Image tags](#image-tags) · [If something fails](#if-something-fails) ·
[Public or private repository](#public-or-private-repository) · [arm64 builds](#arm64-builds) ·
[Verifying a release](#verifying-a-release) · [Maintaining the workflows](#maintaining-the-workflows)

## One-time setup

Done once, in this order. The repository is `https://github.com/lukewilson2002/openbase`.

1. **Create the repository** (empty, no README/licence, so the first push is a plain push) and push:

   ```sh
   git remote add origin https://github.com/lukewilson2002/openbase.git
   git push -u origin main
   ```

   The first push runs `ci.yml` (Actions are on by default). It publishes nothing; this is the
   place to see the checks run on GitHub for the first time. Public or private: see
   [below](#public-or-private-repository).

2. **Settings -> Code security**: turn on **Private vulnerability reporting**
   (`SECURITY.md` points reporters at it), and Dependabot alerts / security updates.

3. **Protect `main`** (Settings -> Rules -> Rulesets -> New branch ruleset, target `main`):
   require a pull request or at least the status checks **Checks (Rust and web)** and
   **End-to-end (Playwright, Chrome)**, block force pushes and deletion. Optional, recommended:
   a second ruleset for **tags** matching `v*` that restricts creation and blocks deletion and
   updates, so a published version can never be re-pointed.

4. **Settings -> Actions -> General**: workflow permissions can stay at the default (read);
   the workflows request exactly what each job needs. If your organisation or account forces
   "Allow actions created by GitHub and ... verified creators", the third-party actions used
   (`docker/*`, `Swatinem/rust-cache`) are covered by "Allow ... specified actions"; every action is
   pinned to a commit SHA.

5. **Private repository only, no arm64 runner**: Settings -> Secrets and variables -> Actions ->
   Variables -> New repository variable `OPENBASE_ARM64_BUILD` = `cross`
   (see [arm64 builds](#arm64-builds)).

6. **First release, then make the image public.** GitHub creates a container package **private by
   default**, even for a public repository, so nobody but you can pull it until you change that:

   1. Publish the first release (next section). The run pushes `ghcr.io/lukewilson2002/openbase`.
   2. GitHub -> your profile -> **Packages** -> **openbase** -> **Package settings** (right side).
   3. **Danger Zone -> Change package visibility -> Public**, type the name to confirm. This cannot
      be undone for a package that has been public (you can delete it, not make it private again).
   4. Check it is **linked to the repository** (the package page shows the repo, and the repo's
      sidebar shows "Packages"). The images carry the label `org.opencontainers.image.source`, which
      links them automatically on the first push. If not: package settings -> **Connect repository**.
   5. Package settings -> **Manage Actions access**: the repository must be listed with **Write**
      role, otherwise the next release cannot push (the first one adds it automatically).
   6. Check from a machine that is not logged in to GHCR: `docker pull ghcr.io/lukewilson2002/openbase:latest`.

   Until step 3 the image works for you (logged in with a token that can read packages) but not for
   users; compose files that point at it fail with "denied" for them.

## Making a release

Before you start: `main` is where you want it, CI is green on it, and the notes for users are
written under `## [Unreleased]` in `CHANGELOG.md` (if that is empty the script falls back to commit
subjects, which is a poor changelog).

1. **Prepare** (on `main`, clean tree):

   ```sh
   git pull
   scripts/release.sh 0.2.0           # add --skip-checks to skip scripts/check.sh
   ```

   It bumps `Cargo.toml` (and `Cargo.lock`), `web/package.json` (and its lock file), turns the
   Unreleased notes into `## [0.2.0] - <date>`, runs `scripts/check.sh`, commits **Release v0.2.0**
   and creates the annotated tag `v0.2.0` whose message is the changelog section. The binary's
   `--version` and `/api/health` report the Cargo version, so this is all they need. The script
   prints the next two commands and changes nothing outside your clone. Look at the result:
   `git show v0.2.0`. To undo: `git tag -d v0.2.0 && git reset --hard HEAD~1`.

   The very first release is special: the tree is already at 0.1.0, so `scripts/release.sh 0.1.0`
   skips the bump, stamps the date on the `## [0.1.0] - unreleased` section, commits and tags.

2. **Push the commit and the tag.** This deploys nothing:

   ```sh
   git push origin main --follow-tags
   ```

   (If `main` is protected and requires pull requests, push the release commit through a
   pull request instead, merge it, then tag the merge commit yourself:
   `git tag -a v0.2.0 -F <notes> <sha> && git push origin v0.2.0`. The release workflow insists the
   tag is on `main` and equals the version in the tree.)

3. **Publish the release.** This is the deliberate step:

   ```sh
   gh release create v0.2.0 --verify-tag --title "OpenBase 0.2.0" --notes-from-tag
   ```

   `--notes-from-tag` uses the tag message (the changelog section). You can also create the
   release on the web (Releases -> Draft a new release -> choose the existing tag -> Publish
   release). Saving it as a **draft** does nothing; clicking **Publish** starts the workflow.

4. **Watch it**: `gh run watch`, or Actions -> Release. About 20-40 minutes: the checks (with
   Playwright) run first, then both architectures are compiled.

5. **Check the result** ([below](#verifying-a-release)). The release page now has
   `openbase-0.2.0-linux-amd64.tar.gz`, `openbase-0.2.0-linux-arm64.tar.gz` and `SHA256SUMS`, and the
   image tags exist.

What the workflow refuses to do (each is a red run with an explanation, before anything is pushed):
a tag that is not `vX.Y.Z` or `vX.Y.Z-pre`; a tag whose version differs from `Cargo.toml`,
`Cargo.lock`, `web/package.json` or `web/package-lock.json`; a tag whose commit is not on `main`
(override on a manual run with `allow_off_main`, for a hotfix branch); a tag with no published
GitHub Release; failing checks; a failing smoke test of either image.

## Pre-releases

A tag with a suffix (`v0.3.0-rc.1`) or a GitHub Release marked "pre-release" builds the same
way but is published **only** as `ghcr.io/lukewilson2002/openbase:0.3.0-rc.1`. No `latest`, no
`0.3`, no major tag moves, so nobody following a normal tag sees it. `scripts/release.sh 0.3.0-rc.1`
prepares it and adds `--prerelease` to the printed `gh release create` command. Use one to try the
pipeline end to end on a real registry before a version that matters.

## Image tags

| You publish | Tags pushed |
|---|---|
| `v1.4.2` (highest 1.4.x, highest 1.x, highest overall) | `1.4.2`, `1.4`, `1`, `latest` |
| `v1.4.3` after `v1.5.0` exists | `1.4.3`, `1.4` (not `1`, not `latest`: 1.5.0 owns those) |
| `v0.2.0` | `0.2.0`, `0.2`, `latest` (never a `0` tag: a 0.x minor may break) |
| `v1.5.0-rc.1` or any pre-release | `1.5.0-rc.1` |

`scripts/release-info.sh vX.Y.Z` prints exactly what a tag would get (it looks at the tags that
exist in your clone, so `git fetch --tags` first). Tags that are not moving (`X.Y.Z`) are never
overwritten except by re-running the workflow for the same tag.

## If something fails

The run is ordered so that nothing is tagged until both architectures are built and smoke-tested.
A failure before the `publish` job leaves at most untagged image layers in GHCR (reachable only by
digest). Fix the cause and re-run:

- **Transient failure** (runner, network): Actions -> the run -> **Re-run failed jobs**.
- **A bug in the code**: do not move the tag. Fix on `main`, then release the next patch version
  (`v0.2.1`). Delete the failed release and tag if nothing was published
  (`gh release delete v0.2.0 --cleanup-tag --yes`), but never reuse a version that was published.
- **A bug in the workflow only**: fix it on `main` and run Actions -> Release -> **Run workflow**
  with the existing tag. Note a manual run uses the workflow file from the branch you select but the
  source from the tag, so the tagged commit does not need to contain the fix.
- **Rebuild an existing release** (for example, to refresh the base image): the same manual run.
  It re-tags the images and replaces the release assets (`--clobber`).
- **Pulling a bad release**: publish a fixed patch release (the `X.Y` and `latest` tags move on),
  mark the bad GitHub Release as pre-release or edit its notes with a warning, and if the image
  must go, delete that version in the package settings (Package settings -> the version ->
  Delete). Users who pinned it keep what they pulled.

Common messages:

| Message | Meaning |
|---|---|
| `Cargo.toml ... is "0.1.0" but the tag v0.2.0 means "0.2.0"` | You tagged without `scripts/release.sh`, or tagged the wrong commit. |
| `... is not on main` | The tag points at a branch commit that was not merged. |
| `There is no published GitHub Release for vX.Y.Z` | A manual run for a tag with no release (or only a draft). |
| `denied` / `permission_denied` when pushing the image | The package exists but the repository lacks **Write** under Package settings -> Manage Actions access. |
| `google-chrome: command not found` in the end-to-end job | The runner image dropped Chrome: set the repository variable `OPENBASE_E2E_BROWSER` = `chromium`. |

## Public or private repository

Everything works in both; this is what differs.

| | Public | Private |
|---|---|---|
| arm64 runner `ubuntu-24.04-arm` | free | not available on the free plan: set `OPENBASE_ARM64_BUILD=cross` |
| Actions minutes | free and unlimited | the plan's allowance (a release takes roughly 100-150 runner-minutes counting both architectures and the end-to-end tests; Linux minutes count 1x, arm64 runner prices differ) |
| GHCR package | private by default; make it public once ([setup](#one-time-setup)) | private; stays private unless you change it, so users need a token to pull: it is not an "official public image" |
| Attestations | BuildKit provenance and SBOM inside the image, **plus** GitHub build attestations for the image and the tarballs (`gh attestation verify`) | BuildKit provenance and SBOM inside the image only (GitHub attestations need Enterprise Cloud for private repositories; the workflow skips them) |
| Private vulnerability reporting, rulesets | available | rulesets and some security features need a paid plan |
| `curl` of release assets | anyone | needs a token |

Making an existing private repository public later needs nothing in the workflows. The package
visibility is separate and must be switched as in the setup steps.

## arm64 builds

`OPENBASE_ARM64_BUILD` (repository variable; a manual run can override it per run):

- **`native`** (default): the arm64 binary is compiled on GitHub's `ubuntu-24.04-arm` runner,
  inside `rust:1-bookworm`, with the same Dockerfile and toolchain as the amd64 one. Simplest and
  the most uniform. Needs the arm64 runner (public repositories).
- **`cross`**: for private repositories without an arm64 runner. The arm64 binary is
  cross-compiled on the ordinary amd64 runner with `cargo-zigbuild` (Zig as the C compiler and
  linker) for `aarch64-unknown-linux-gnu.2.36`, i.e. against glibc 2.36, Debian 12's, which is what
  the runtime image uses. As fast as a native build. The trade-off: the arm64 binary is produced by
  a different toolchain path than the amd64 one (C code such as SQLite is compiled by `zig cc`
  instead of gcc), and the arm64 image is only *started* on the amd64 runner under QEMU for the
  smoke test, not run natively. It was verified here (zigbuild 0.23.4 with Zig 0.15.2: both
  targets build; the arm64 binary starts in a Debian 12 container and passes
  `scripts/smoke-docker.sh`), but it is the less exercised path.
- Compiling under QEMU emulation (`docker buildx --platform linux/arm64` on an amd64 runner) also
  works with no cross toolchain, but compiling this project that way takes an hour or more, so the
  workflow does not offer it.

## Verifying a release

```sh
V=0.2.0
docker pull ghcr.io/lukewilson2002/openbase:$V
docker run --rm ghcr.io/lukewilson2002/openbase:$V --version          # openbase 0.2.0
docker buildx imagetools inspect ghcr.io/lukewilson2002/openbase:$V    # linux/amd64, linux/arm64 (+ attestations)
docker buildx imagetools inspect ghcr.io/lukewilson2002/openbase:$V --format '{{ json .SBOM }}'
docker buildx imagetools inspect ghcr.io/lukewilson2002/openbase:$V --format '{{ json .Provenance }}'
docker inspect ghcr.io/lukewilson2002/openbase:$V --format '{{ json .Config.Labels }}'    # source, version, revision, licenses

gh attestation verify oci://ghcr.io/lukewilson2002/openbase:$V --repo lukewilson2002/openbase   # public repositories
gh release download v$V --repo lukewilson2002/openbase --pattern '*linux-amd64.tar.gz' --pattern SHA256SUMS
sha256sum --check --ignore-missing SHA256SUMS
gh attestation verify openbase-$V-linux-amd64.tar.gz --repo lukewilson2002/openbase               # public repositories
```

Then try the user path on a scratch machine: `cd deploy && docker compose up -d` with
`OPENBASE_VERSION=$V`, and later `docker compose pull && docker compose up -d` after the next
release.

## Maintaining the workflows

- Third-party actions are pinned to full commit SHAs with the version in a comment. Dependabot
  (`.github/dependabot.yml`, weekly, grouped) proposes updates; they run through CI like any change.
  Be extra careful with an update of anything in the release workflow.
- `ci.yml` is also called by `release.yml` (`uses: ./.github/workflows/ci.yml`), so release checks
  cannot drift from pull-request checks. `scripts/check.sh` is the single definition of the
  non-browser checks.
- The Dockerfile's extra targets exist only for the release workflow (`binary`, `runtime-prebuilt`,
  `WEB_DIST=web-prebuilt`); the default `docker build` is still a plain from-source build for
  people building locally.
- Validate workflow edits locally with [actionlint](https://github.com/rhysd/actionlint)
  (with `shellcheck` installed it also checks the `run:` scripts). After changing the release
  workflow, cut a release candidate (`scripts/release.sh 0.2.0-rc.1`, published with
  `--prerelease`): it exercises everything on a real registry without touching `latest` or the
  `0.2` tag. A manual run for that tag repeats it.
- Pushing never needs a Personal Access Token: the workflow uses the built-in `GITHUB_TOKEN`.
