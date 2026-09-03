### Fixed

- `terminal_send({ submit: true })` now reports whether the prompt was actually
  committed. The result carries `accepted` — true only when the pane was
  observed to move (its turn started, or the input line cleared) — plus
  `agentStatusAfter`, and the pane's last screen lines when it did not. The
  Enter is re-sent once before giving up. Previously `submitted: true` meant
  only "a carriage return was written", so an orchestrator reported progress on
  panes whose prompt was still sitting uncommitted in the composer.

- An orchestrator brain can finally reach the agents in its own workspace. A
  brain owns no pane, so every same-workspace A2A reply it sent was suppressed
  as an "unverified sender" and merely stored — the brain was told the message
  landed while the worker sat waiting. A caller carrying the daemon-validated
  commander binding now satisfies that guard and the missing-anchor one, while
  the self-loop protection for pane callers is unchanged. A reply addressed at
  a brain is refused outright with `target_is_brain`: there is no pane behind
  it to write into.
