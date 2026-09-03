### Fixed

- **A replay can now tell two identical siblings apart by the attribute the
  page gives them.** The neighbourhood check added in the previous release
  abstains on the one shape it was built around: two elements with the same
  role, the same accessible name, and the same container are under the same
  neighbourhood, so it has nothing to say about them and the count rules decide
  by position. Real pages almost always distinguish those siblings on the
  element itself — a `data-testid`, an `id`, a `name`, or an `aria-label` — and
  a recorded step now carries whichever of those the element had, as a second
  verify-only signal. Where the neighbourhood gives no verdict, the sibling
  carrying the recorded attribute wins if it is unique and still at the
  recorded position; if it moved, or if the population carries attributes but
  not that one, the run stops and hands the page back live instead of clicking
  the twin. Nothing is ever *located* by the attribute, and a population that
  carries none at all abstains exactly as before, so no existing flow changes
  behaviour. Both recording lanes — `browser_snapshot` and
  `browser_smart_snapshot` — mint the value from the same pass, so a flow
  recorded on one replays against the other. Traces recorded before this
  release replay unchanged. The irreducible case is now genuinely irreducible:
  identical siblings that carry no identifying attribute at all.
