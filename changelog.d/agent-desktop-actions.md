### Added

- **Computer use on macOS can press, toggle and scroll an element by its
  ref, in the background.** The `computer` tool's `desktop` action now takes
  `click`, `focus`, `select`, `toggle`, `check`, `uncheck`, `expand`,
  `collapse` and `scroll` on a ref from a window snapshot or `find`. They act
  through accessibility without moving the pointer or bringing the app
  forward, count as input actions (the stop key, the rate limit and the
  per-app lock apply), and report whether the input may have been delivered.
  A ref whose element changed since the snapshot is refused, and password
  fields are never acted on.
