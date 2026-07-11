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
