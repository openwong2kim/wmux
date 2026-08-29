### Fixed

- `browser_snapshot` with a `selector` now scopes the accessibility tree instead
  of always falling back to a raw DOM listing of the subtree. The DOM listing
  cannot see layout, so it handed out refs for elements that were not actually
  rendered and clicking one of those refs timed out; it also meant
  `format: "aria"` was silently unavailable whenever a selector was given. Both
  now work, and `filter: "interactive"` applies within the scope. The DOM listing
  remains the fallback for cases the accessibility route cannot serve (no live
  page, a collapsed tree, or an element with no accessibility presence), and
  still owns the "no element matches selector" error.
- A selector-scoped snapshot numbers its refs within the subtree, so resolving
  one now searches inside that same element. Previously an identical
  role and name elsewhere on the page could win the match, quietly acting on an
  element the caller had scoped out.
