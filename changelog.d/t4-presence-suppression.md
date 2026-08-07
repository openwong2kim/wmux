### Added

- **Your phone stops buzzing for approvals you are already looking at.** When
  the desktop app is connected and its window was focused within the last 90
  seconds, the push notification for a new approval is held back — the request
  still lands in the in-app inbox, which is the thing you were reading anyway.
  Before this, sitting at the desk answering prompts also meant a phone
  lighting up for every one of them.

  Held, not dropped. The moment you leave — the window blurs, you lock the
  screen, the machine sleeps, the app quits, or the focus report simply ages
  out because you walked away — any still-pending approval's push is delivered.
  It carries the same collapse id as the original, so the phone replaces that
  pane's banner rather than stacking a second one. An approval you answered
  while parked is dropped instead of sent.

  Every uncertainty still sends: a daemon with no desktop attached, a version
  of the app too old to report focus, an unreadable config, or a focus report
  that has gone stale all fall back to notifying. A `critical`-risk approval is
  pushed even when you are present — a destructive action is worth the second
  channel. Only the app's own process can report presence; the CLI, the MCP
  server, and anything an agent can reach are refused, so nothing can silence
  its own approval prompts.

  Configurable via `pushPresenceSuppression` in `~/.wmux/config.json`
  (`enabled`, default `true`; `staleAfterMs`, default `90000`, capped at ten
  minutes).
