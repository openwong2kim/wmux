## Language (owner decision, 2026-07-20)

This is a public open-source repo: **all repo artifacts are English, always** —
commit messages, CHANGELOG entries, PR titles/bodies, code comments, and docs.
This OVERRIDES the global `~/.Codex/AGENTS.md` Korean-commit/comment convention
for this repository. New code comments are written in English; do not mass-rewrite
existing Korean comments (respect the "don't improve adjacent code" rule), just
stop adding new Korean ones. Chat/reports with the owner may stay Korean.

## Skill routing

When the user's request matches an available skill, ALWAYS invoke it using the Skill
tool as your FIRST action. Do NOT answer directly, do NOT use other tools first.
The skill has specialized workflows that produce better results than ad-hoc answers.

Key routing rules:
- Product ideas, "is this worth building", brainstorming → invoke office-hours
- Bugs, errors, "why is this broken", 500 errors → invoke investigate
- Ship, deploy, push, create PR → invoke ship
- QA, test the site, find bugs → invoke qa
- Code review, check my diff → invoke review
- Update docs after shipping → invoke document-release
- Weekly retro → invoke retro
- Design system, brand → invoke design-consultation
- Visual audit, design polish → invoke design-review
- Architecture review → invoke plan-eng-review

## Design System

Always read DESIGN.md before making any visual or UI decisions.
All chrome/layout contracts, color grammar (amber = alive + focus, 5±2
points per screen, no washes), typography, and aesthetic direction are
defined there. Do not deviate without explicit user approval.
In QA/design-review mode, flag any code that doesn't match DESIGN.md.

## Versioning & release (owner decision, 2026-07-05)

- **PRs never bump the version.** `package.json` stays at the last released
  version on every feature branch. Do NOT let /ship (or any workflow) bump
  MAJOR/MINOR/PATCH, claim version slots, or prefix PR titles with `vX.Y.Z`.
- CHANGELOG: each PR adds its user-facing entries under `## [Unreleased]`
  at the top (Keep a Changelog). Merge conflicts there are append-merges.
- **Release = explicit user action**: bump `package.json` version, rename
  `[Unreleased]` → `[X.Y.Z] — YYYY-MM-DD`, run
  `node scripts/gen-api-reference.mjs` (the generated header bakes the
  version — the CI drift guard enforces this), commit `chore(release)`,
  then push a `v*` tag (installer builds hang off the tag).
- Consequence accepted with this decision: same-version dev builds are not
  distinguishable by semver, so the stale-daemon auto-replacement triggers
  only on (a) pre-B′ daemons (missing version field) and (b) release-to-
  release upgrades and (c) `CHANNELS_EPOCH` bumps — not on every dev rebuild.

## Fork workflow (owner decision, 2026-07-23)

- `origin/main` is the upstream tracking reference. Do not add fork-specific
  commits directly to it.
- `develop` is the long-lived integration branch. Rebase it onto `origin/main`,
  resolve conflicts there, and verify it before promoting changes.
- For a fork release, rebase `main` onto the same upstream base and squash merge
  the verified `develop` delta into `main`. Do not cherry-pick its history.
- Keep `develop`; feature branches may be deleted after their integrated work is
  verified and released. Keep a recovery ref if needed.
- Preserve upstream CHANGELOG history. Fork-facing changes go under
  `## [Unreleased]`; releases follow the explicit versioning policy above.

## Fork identity boundary (owner decision, 2026-07-23)

Forge Mux must coexist with upstream wmux while remaining easy to rebase. Keep its
identity as a small, deliberate patch layer; never perform repository-wide
wording or symbol renames.

- Preserve upstream identifiers, module and file names, historical docs, tests,
  and comments unless a change is required for real coexistence.
- Change only collision-facing boundaries: package, product, and CLI names;
  installer/updater and application IDs; data directories; IPC endpoints;
  project config filenames; and installed integration destinations.
- Centralize identity values at existing packaging and path boundaries. Do not
  scatter product-name literals through feature code.
- Keep the patch isolated and replayable after rebasing `develop` onto
  `origin/main`.
- Do not read or migrate wmux state automatically. Forge Mux uses its own namespace.
- Keep this layer in one dedicated commit, tagged `fmux-identity-boundary`.
  Rebase it with `develop`; if recovery is needed, replay that tag with
  `git cherry-pick fmux-identity-boundary`.
