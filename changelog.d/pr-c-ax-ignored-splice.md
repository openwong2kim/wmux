### Fixed

- Accessibility snapshots no longer collapse on real pages. Chrome puts a chain
  of "uninteresting" wrapper nodes directly under the page root, and
  `browser_snapshot` used to discard those nodes together with everything below
  them — so on virtually every site the accessibility tree came back empty and
  the snapshot was silently downgraded to the DOM element listing. Those wrapper
  nodes are now spliced out while their contents are kept, which restores
  `format: "aria"` (previously always answered with "aria format unavailable"),
  makes `filter: "interactive"` work again, and stops the DOM listing from
  handing out refs to invisible elements that timed out on click.
- `browser_smart_snapshot` missed every interactive element on such pages for the
  same reason, and now finds them.
