### Added

- **Attach a remote machine's live panes into your local sidebar.** Run
  `wmux web --tailscale --allow-input` on the remote box, then in the app go
  Titlebar `+` → "Attach remote workspace…", paste the URL `wmux web` printed,
  and pick a workspace from its live list. The attached workspace shows up in
  its own sidebar section with a mirror grid (up to 6 concurrent panes) that
  reads scrollback and, when the remote allows it, types into the remote
  panes. Detaching never touches anything on the remote — there is no
  remote create, rename, or close from this view yet.
