### Added

- **`browser_snapshot` reaches inside iframes, and a ref minted in one
  resolves there.** A page's payment form, consent banner or login widget lives
  in a separate document, and the snapshot used to stop at its edge with a note
  saying the contents were not included — so an agent could see that a frame
  existed and could not act on anything in it. Frame contents are now stitched
  into the tree, cross-origin ones included, and a ref keeps the route back to
  the document it came from, so clicking, typing and filling work inside a
  frame exactly as they do on the page.

- **An iframe now says why its contents are absent, when they are.** One
  sentence used to cover four different situations. It now distinguishes a
  frame that could not be attached, one nested past the depth limit, one past
  the per-snapshot frame budget, and one that was read and simply holds
  nothing — the last of which used to be indistinguishable from "contents
  withheld", leaving an agent re-snapshotting for content that was never
  coming.

### Fixed

- **A ref from a frame that changed underneath you is refused rather than
  clicked.** A frame can navigate on its own while the page's URL never
  changes, and iframes can be added or removed between snapshots. Replaying a
  ref across any of those now reports what moved and asks for a fresh
  snapshot, instead of resolving to whatever occupies that position now. The
  same refusal covers a frame ref reaching the DOM-attribute fallback, which
  tags the main document only and could otherwise match an unrelated element.

- **One frame can no longer spend the whole snapshot.** A chatty ad or tracking
  frame is capped at a share of the output budget, so it cannot push the page's
  own buttons past the truncation point. A frame cut short says so.
