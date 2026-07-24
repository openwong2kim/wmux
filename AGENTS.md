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
  then push the tag explicitly to the fork — `git push fork vX.Y.Z`,
  never bare `git push --tags` (installer builds hang off the tag).
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

## CHANGELOG on upstream syncs (owner decision, 2026-07-24)

- Section layout, top to bottom: `[Unreleased]` (mirrors upstream fixes not yet
  in any release, plus pending fork entries), fork release sections (`[1.0.0]`…)
  carrying **fork-facing entries only** with their stated upstream base, then the
  `---` provenance separator and the inherited upstream `[3.x]` sections, which
  stay authoritative for upstream-authored work.
- A fork release cut from a pre-release upstream base will overlap the upstream
  section that later ships the same work. After a sync imports that section,
  drop the byte-identical twin from the fork section (keep fork-adapted
  variants), and update the fork section's "based on upstream wmux X.Y.Z" line
  if the rebase moved the base before the release tag was published.
- Per-clone (like `tagOpt`, not versioned): `.git/info/attributes` contains
  `CHANGELOG.md merge=union`, so replayed fork commits append instead of
  conflicting during a rebase. Union merges can duplicate or mis-section
  entries, so **always audit the final CHANGELOG after a sync**: header order,
  duplicated bold entry titles, and empty `###` subsections.

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
- The identity layer is the range of fork-local commits above the upstream
  base; `git merge-base main origin/main` marks the boundary, so no tag is
  needed. To sync with upstream, run
  `git fetch origin && git rebase origin/main main`, which replays the whole
  layer onto the new upstream tip (then force-push `main` to the fork).
  The former single-commit `fmux-identity-boundary` tag is retired — the
  layer may span multiple commits, but keep them few and focused.

## Remotes & tag policy (owner decision, 2026-07-24)

- Remotes: `origin` is upstream `openwong2kim/wmux` — read-only tracking,
  never push there. `fork` is `github.com/skflowne/fmux`, the repository
  Forge Mux ships from. Upstream syncs rewrite `main`, so pushing `main`
  to `fork` uses `--force-with-lease`.
- Forge Mux versioning restarts at **1.0.0**, and the fork's `v*` tag
  namespace belongs to fmux releases only. The inherited wmux tags
  (`v1.0.1`–`v3.31.0`) were purged from the fork remote and the local
  clone on 2026-07-24; upstream keeps them all, so fetch one explicitly
  if ever needed (`git fetch origin tag vX.Y.Z`) and delete it locally
  after use.
- Every clone must set `git config remote.origin.tagOpt --no-tags` — this
  is per-clone config, not versioned — so fetching upstream never
  re-imports wmux tags.
- Release tags are annotated, point at the `chore(release)` commit on
  `main`, and are pushed one at a time (`git push fork vX.Y.Z`). Never run
  bare `git push --tags`.
