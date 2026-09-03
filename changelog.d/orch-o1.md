### Fixed

- `terminal_send({ submit: true })` now reports whether the prompt was actually
  committed. The result carries `accepted` — true only when the pane was
  observed to move (its turn started, or the input line cleared) — plus
  `agentStatusAfter`, and the pane's last screen lines when it did not. The
  Enter is re-sent once before giving up. Previously `submitted: true` meant
  only "a carriage return was written", so an orchestrator reported progress on
  panes whose prompt was still sitting uncommitted in the composer.
