### Added

- `browser_snapshot` now ends with a short page-facts footer when it has
  something to say: a readiness note when the page is nearly empty or looks
  like a skeleton screen, and the list of scrollable containers (by CSS
  selector, with size and scrollHeight) so a container can be scrolled
  deliberately instead of by guessing. The footer is charged against
  `maxLength`, so a snapshot never grows past the budget the caller asked for,
  and it is not added to selector-scoped snapshots.
- `browser_file_upload` with a `ref` now accepts the VISIBLE upload button:
  when the ref is not itself an `<input type=file>`, the nearby hidden input is
  found (up to 3 levels of ancestors, their descendants and siblings) and the
  files go there. The "no file input" errors now say to pass that button's ref.

### Changed

- On the `chrome` backend, `browser_click` reports when the click opened a
  popup, naming its URL. The popup is not a wmux surface and the note says so.
  The builtin webview loads popups into the same webview and is unaffected.
