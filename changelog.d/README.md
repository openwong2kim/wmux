# changelog.d — one file per pull request

A PR does **not** edit `CHANGELOG.md`. It adds one file here, named after its
PR number:

```
changelog.d/684.md
```

## Why

Every PR used to insert its entry at the same place — the line right after
`### Added` inside `## [Unreleased]`. Git sees two different insertions at one
position and cannot order them, so it reports a conflict. That is not a
mistake anyone made; it is what a shared insertion point means. The cost grew
with the number of open PRs: merging one PR left every other open PR
conflicted, and merging a second re-conflicted the ones just fixed.

Separate files cannot collide. The conflict is designed out rather than
resolved over and over.

## Format

Plain Keep a Changelog sections. Use only the headings you need, in any order:

```markdown
### Added

- **Short bold claim.** Then the paragraph, written for a person reading the
  release notes — what changed, and what it was like before.

### Fixed

- **Another one.** …
```

Cite your PR number at the end of an entry the same way as before — `(#684)`.

## Release

`node scripts/collect-changelog.mjs` folds every fragment into
`CHANGELOG.md` under `## [Unreleased]`, in PR-number order, and deletes the
fragments. That runs as part of cutting a release, before the version bump.
`--check` reports what would be folded without writing anything.
