## Language (owner decision, 2026-07-20)

This is a public open-source repo: **all repo artifacts are English, always** —
commit messages, CHANGELOG entries, PR titles/bodies, code comments, and docs.
This OVERRIDES the global `~/.claude/CLAUDE.md` Korean-commit/comment convention
for this repository. New code comments are written in English; do not mass-rewrite
existing Korean comments (respect the "don't improve adjacent code" rule), just
stop adding new Korean ones. Chat/reports with the owner may stay Korean.

## Design System

Always read DESIGN.md before making any visual or UI decisions.
All chrome/layout contracts (frame and sheet, rail pages, titlebar, the
one-boundary rule), the theme tokens and color grammar (colour carries state
only, no washes), typography, and aesthetic direction are defined there. Do not deviate without explicit user approval.
In QA/design-review mode, flag any code that doesn't match DESIGN.md.

## Versioning & release (owner decision, 2026-07-05)

- **PRs never bump the version.** `package.json` stays at the last released
  version on every feature branch. Do NOT let /ship (or any workflow) bump
  MAJOR/MINOR/PATCH, claim version slots, or prefix PR titles with `vX.Y.Z`.
- CHANGELOG: a PR does **not** edit `CHANGELOG.md`. It adds one fragment,
  `changelog.d/<pr-number>.md`, holding its user-facing entries under plain
  Keep a Changelog headings. Separate files cannot conflict — editing the one
  shared insertion point meant every merge left every other open PR dirty.
  See `changelog.d/README.md`.
- **Release = explicit user action**: run
  `node scripts/collect-changelog.mjs` to fold the fragments into
  `CHANGELOG.md`, bump `package.json` version, rename
  `[Unreleased]` → `[X.Y.Z] — YYYY-MM-DD`, run
  `node scripts/gen-api-reference.mjs` (the generated header bakes the
  version — the CI drift guard enforces this), commit `chore(release)`,
  then push a `v*` tag (installer builds hang off the tag).
- Consequence accepted with this decision: same-version dev builds are not
  distinguishable by semver, so the stale-daemon auto-replacement triggers
  only on (a) pre-B′ daemons (missing version field) and (b) release-to-
  release upgrades and (c) `CHANNELS_EPOCH` bumps — not on every dev rebuild.

### Pre-releases

- Same steps, with a semver prerelease version: `package.json` →
  `4.0.0-beta.1`, CHANGELOG heading `[4.0.0-beta.1] — YYYY-MM-DD`, tag
  `v4.0.0-beta.1`. Fragments are folded as usual, so the final `[4.0.0]`
  section lists only what changed after the last beta.
- `release.yml` treats a run as a prerelease when the tag **or** the
  `package.json` version contains `-`. It then publishes a GitHub prerelease
  that is never marked latest, and skips Chocolatey and WinGet. macOS and
  Linux assets append to that same prerelease.
- Existing users are never offered it: update.electronjs.org skips
  prereleases, and the updater's side-car manifests are read through
  `releases/latest/download/`, which never points at one. Beta testers install
  by hand from the release page. They are not auto-updated from one beta to
  the next either (betas are never served); they are offered the final
  `X.Y.Z` once it ships, since `X.Y.Z` > `X.Y.Z-beta.N`.
- Label shape: `X.Y.Z-<label>.<n>` with at most one dot in the label
  (`beta.1`, `rc.2`). Packager stamps the Windows exe version by splitting on
  `.` and allows at most four parts, so `-beta.1.2` fails the Windows build.
- A beta-to-beta upgrade on one machine does not replace the running daemon
  (same version core, both prereleases) unless `CHANNELS_EPOCH` moved — the
  same trade-off as same-version dev builds above.
