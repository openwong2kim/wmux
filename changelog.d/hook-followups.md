### Fixed

- **An orchestrator now wakes when a worker's turn dies on an API error.**
  Claude Code reports that as `StopFailure` and no `Stop`, and wmux published
  no lifecycle event for it — so a Deck brain or fan-out parent waiting on the
  worker sat on the stop gate with nothing to react to. The failed turn is now
  its own `agent.lifecycle` kind (`agent.stop_failure`), pollable through
  `wmux_events_poll` and woken on like a stop, but with its own reason so the
  brain can tell a turn that finished from one that died.
