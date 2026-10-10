### Added

- **Ask once before a dangerous action on a protected browser pane.** On a
  protected pane, a page script (`browser_evaluate`), a download
  (`browser_download`, `browser_wait_for_download`) or reading or changing
  sign-in data of a sensitive site (email, banking, auth) now asks you first
  instead of being refused: Allow once, Always on this pane, or Deny. Each
  action gets its own question, which is denied if nobody answers within a
  minute. A scheduled run nobody is watching is refused at once rather than
  left waiting. "Always on this pane" choices are listed in the pane's Browser
  protection editor, where you can revoke them; rebinding or moving the pane
  clears them. An approved download is the only one let through, from the tab
  it was approved for. The agent's own `allowDangerous` and
  `allowSensitiveDomains` flags no longer unlock anything on a protected pane.
  Unprotected panes behave exactly as before.
