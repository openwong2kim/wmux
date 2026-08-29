### Fixed

- **Creating a Chrome profile works again.** The workspace menu's
  "New profile…" row asked for the name with a browser prompt dialog, which
  Electron's renderer does not implement — the call threw, so the row did
  nothing at all and no profile was ever created. It now opens a small inline
  form right in the submenu: type the name, press Enter or Create, and the
  workspace is bound to the new profile. If the name is rejected (bad
  characters, the reserved `live`, or the 20-profile limit) the reason is
  shown under the field with what you typed still there, instead of being
  swallowed.
