### Added

- `browser_snapshot` now marks the focused element. Exactly one node per page
  carries `focused`, so "which field am I in" no longer costs a second snapshot
  or an `browser_evaluate` round-trip.
- `browser_snapshot` names iframe boundaries. An `<iframe>` used to appear as a
  bare childless node, indistinguishable from an empty one; it now reads
  `Iframe "..." (separate document — contents not in this snapshot)`, and the
  marker survives `filter:"interactive"` so a filtered tree can no longer be
  misread as "this page has no such button".
- `browser_snapshot` warns when a CSS overlay is covering the page. Chrome's
  accessibility tree already drops content behind a native `<dialog>` modal or
  an `inert` subtree, but a plain high-z-index `<div>` — every React/Tailwind
  modal, cookie wall and paywall — leaves every covered control looking
  clickable. The snapshot now opens with one note naming the overlay and marks
  the controls that still receive clicks as `clickable`, instead of the agent
  discovering it through a 30-second click timeout.
