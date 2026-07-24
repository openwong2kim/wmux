<!--
Thanks for contributing to Forge Mux. Fill the template out — reviewers use it as the
landing checklist. Sections that don't apply: write "n/a" rather than deleting
the header, so reviewers know you considered them.
-->

## Summary

<!-- One or two sentences. What changed and why. -->

## Changes

<!--
Bulleted list of substantive changes. Keep it tight; the diff is the source of
truth, this is the index.
-->

-
-

## CHANGELOG entry

<!--
Required for every PR that touches user-visible behavior or the external
substrate surface. Skip ONLY for internal-only refactors (with a note saying
"no CHANGELOG — internal only" below).

Use the Keep-a-Changelog sections. Pick the ones that apply; delete the rest.
The release writer will copy this verbatim into CHANGELOG.md.
-->

### Added

-

### Changed

-

### Deprecated

-

### Removed

-

### Fixed

-

### Security

-

## Stability tier impact

<!--
Check one. Definitions in docs/api/versioning.md.

- [ ] No external surface touched (internal refactor / docs / tests / CI).
- [ ] Additive change to a `stable` surface (new optional param, new field, new event type).
- [ ] Breaking change to a `stable` surface (requires major bump — block until release planning is in scope).
- [ ] Change to an `experimental` surface (note in release notes).
- [ ] Change to an `internal` surface (no contract impact).
-->

## Substrate contract impact (Substrate 3.0)

<!--
If this PR touches any of these, link to the relevant docs section that needs
updating in the same PR or in a follow-up:

- PaneMetadata wire shape, mergeMode, version semantics → docs/PROTOCOL.md §1
- EventBus envelope, cursor semantics, bootId → docs/PROTOCOL.md §2, §3
- Permission enforcement points → docs/PROTOCOL.md §4
- Named Pipe security → docs/PROTOCOL.md §5
- New RPC method / event type → docs/api/inventory.md + docs/api/stability.md

Write "n/a" if nothing here applies.
-->

## Test plan

<!--
- Unit tests added / updated: which paths.
- Integration / dynamic tests: link the script or describe the harness.
- Manual verification: what you did locally, especially for UI/UX changes.

CI must pass before merge — don't ship if you haven't run the full suite locally.
-->

## Related issues / PRs

<!-- e.g. Closes #123, Tracks #18, Stacked on #16 -->

## Reviewer checklist

- [ ] CHANGELOG entry above is filled in or explicitly marked n/a.
- [ ] Stability tier impact is correctly classified.
- [ ] Substrate contract docs (PROTOCOL.md, inventory.md, stability.md) updated if the surface changed.
- [ ] Tests cover the new behavior and the regression case (if a bug fix).
- [ ] No accidental commit of secrets, tokens, `.env`, or unrelated large binaries.
