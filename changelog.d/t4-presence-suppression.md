### Added

- **Your phone stops buzzing for approvals you are already looking at.** When
  the desktop app is connected and its window was focused within the last 90
  seconds, the push notification for a new approval is skipped — the request
  still lands in the in-app inbox, which is the thing you were reading anyway.
  Before this, sitting at the desk answering prompts also meant a phone
  lighting up for every one of them.

  Every uncertainty still sends: a daemon with no desktop attached, a version
  of the app too old to report focus, or a focus report that has gone stale all
  fall back to notifying. A `critical`-risk approval is pushed even when you are
  present — a destructive action is worth the second channel.

  Configurable via `pushPresenceSuppression` in `~/.wmux/config.json`
  (`enabled`, default `true`; `staleAfterMs`, default `90000`).
