### Added

- **A `Matrix` terminal palette** — phosphor green on green-tinted black, in
  Settings → Terminal Palette. Green carries the identity (foreground, cursor,
  the green slot and a green-cast white), but red and yellow keep their warmth
  so a failing test, a removed diff line and a warning still read as
  themselves, and blue/cyan/magenta are separated on the hue wheel rather than
  collapsed into green, so `ls` can still tell a directory from an executable.
