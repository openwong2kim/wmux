### Added

- **Quit and Stop Sessions.** Quitting wmux keeps the background service and
  every terminal and agent running, so the next launch picks them back up.
  When you want everything to end, the app menu (next to Quit on macOS, under
  File on Windows and Linux) now has **Quit and Stop Sessions**. It asks first,
  saying how many agent sessions and terminals are running, then stops the
  background service and all of its sessions and quits. If the service does not
  stop, wmux stays open and tells you to run `wmux daemon stop`. Before, only
  the tray menu could do this. Plain Quit is unchanged. (#2021)
