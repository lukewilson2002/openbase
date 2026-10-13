# Security policy

## Reporting a vulnerability

Please report security problems **privately**, not in a public issue, discussion or pull request.

Use GitHub's private vulnerability reporting:
<https://github.com/lukewilson2002/openbase/security/advisories/new>
(repository **Security** tab -> **Report a vulnerability**).

Include what you found, the version (`openbase --version`, or the image tag), how to reproduce it,
and the impact you expect. A proof of concept helps; please do not test against instances you do
not own.

What to expect: OpenBase is maintained by one person, so this is a best-effort promise rather than
an SLA. You should get an acknowledgement within about a week. Confirmed problems are fixed in a
new release, announced in the release notes and, where it makes sense, as a GitHub security
advisory with credit to you if you want it. Please give a reasonable time to fix a problem
before publishing details.

## Supported versions

Only the **latest minor release** receives security fixes (for example, once 1.3.0 is out, 1.3.x;
and while OpenBase is 0.x, the latest 0.y.x). Older versions get no fixes: update to the current
release first. Fixes are published as a new patch release; follow a version tag such as `1.3` or
`1` (see the [README](README.md#versions-tags-and-updates)) to receive them with
`docker compose pull`.

## Scope and background

The threat model, the limits that are enforced, the checklist for administrators and the risks
that are accepted on purpose are in [docs/security.md](docs/security.md). Reports about something
listed there as an accepted risk are still welcome if you think the judgement is wrong.

Problems in a dependency should be reported to that project; tell us as well if OpenBase is
affected and needs a release. Dependabot and `cargo audit` style findings that do not affect
OpenBase need no report.
