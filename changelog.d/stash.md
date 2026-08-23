<!-- TODO-renumber: rename to changelog.d/<pr-number>.md and replace (#977) with the PR number at ship time. -->

### Added

- **Stash a pane instead of killing it.** Until now the only way to take a pane
  off the screen was `✕`, which destroys its daemon session with no way back —
  so tidying a split and killing an agent were the same gesture. The pane
  header's new archive button (and `prefix` + `!`, tmux's break-pane) removes a
  pane from the layout and leaves its session running. It shows up in the
  workspace's sidebar list, where its status keeps updating as proof it is still
  working, and one click brings it back next to its former neighbour with its
  scrollback replayed. A ten-second undo rides the confirmation toast.

  Stashing is refused, with the reason, when the pane is the only one on screen,
  when there is no daemon connection (nothing would be holding the session), or
  when the pane holds an editor or diff tab whose unsaved state cannot be
  replayed. If a stashed session dies while it is off-screen, the row says so
  rather than pretending, and bringing it back offers the same recovery a dead
  visible pane gets — never a silent fresh shell wearing the old pane's name.

  Everything that watches your agents already counts stashed panes: the "N need
  you" chip, the fleet cards, notifications, the sidebar's idle badge. Clicking
  any of them brings the pane back and takes you to it.

- **`pane.stash` / `pane.unstash` RPC + the `pane_stash` / `pane_unstash` MCP
  tools.** A stashed pane stays fully addressable: `terminal_send`,
  `terminal_read`, `pane_close` and A2A delivery all work against it, because
  its PTY is alive and none of them need to know where the pane is on screen.
  Only position-dependent calls (`pane_focus`, `surface_focus`) are refused, and
  they answer with a `PANE_STASHED` error carrying a `recovery` payload the
  caller can invoke verbatim.

  `pane_list` and `surface_list` keep their existing membership — they still
  mean "what is in the layout" — and gained `includeStashed: true` for the rest.
  Every row now carries an explicit `stashed` boolean; stashed rows add
  `stashedLiveness`. Two new events, `pane.stashed` and `pane.unstashed`, keep
  the `pane_list` + `wmux_events_poll` recovery path complete: a pane leaving the
  default listing is always explained by an event, never by silence. Feature
  detection: `system.capabilities` → `features.paneStash`.

### Notes

- Stashed panes count against the 20-pane-per-workspace limit. The cap exists to
  bound memory, and a stashed session is still running; when the stash is part of
  why you hit the limit, the message says so.
- Downgrading to a build without stash support does not lose the panes: the
  older session writer round-trips the field it does not understand, so they
  reappear on upgrade. While you are on the older build those sessions keep
  running unmanaged — the same thing that already happens to any session when the
  app is not there to show it.
- A session that stays silent for more than 8 hours while the app is CLOSED can
  still be reaped by the daemon (#557). That is unchanged and applies to every
  pane, not just stashed ones; the difference is that a stashed pane now tells
  you it happened instead of quietly coming back empty.
