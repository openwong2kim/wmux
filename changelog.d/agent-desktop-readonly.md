### Added

- **Computer use on macOS can search and read an app's interface in more
  depth.** The `computer` tool's new `desktop` action runs read-only commands
  (`snapshot`, `find`, `get`, `is`, `list-surfaces`, `wait`) through
  agent-desktop, which now ships inside the computer-use helper. They follow
  the same rules as `getAppState`: computer use must be on, blocked apps stay
  blocked, and Ask before each app still asks.
