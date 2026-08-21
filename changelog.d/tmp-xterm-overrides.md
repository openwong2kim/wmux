### Fixed

- **Terminal colour overrides survive a restart.** Customising individual ANSI
  colours on top of a palette preset (Settings → Terminal Palette → Customize
  terminal colors) worked for the rest of the session and was then lost at the
  next launch: the custom-theme migration that runs on every session load
  rebuilt the theme from a fixed field list that did not include the overrides,
  while documenting itself as idempotent. The preset id survived, so only users
  who tuned individual colours were affected.
