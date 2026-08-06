### Fixed

- **Mirrored remote panes now use your terminal font and theme.** An attached
  remote workspace built its terminal without any of the app's visual settings,
  so it fell back to xterm's own defaults — `monospace` at 15px on black,
  outside the theme's ANSI palette. Next to a local pane it read as slightly
  bolder and slightly larger, because it was. Font size, font family, theme and
  the contrast floor now match a local pane, and changing them updates the
  mirror without dropping what the remote has already sent.
