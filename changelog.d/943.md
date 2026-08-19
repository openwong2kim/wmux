### Fixed

- **A pane no longer stays "complete" through its next turn.** The activity
  cycle that re-arms the `running` status only reset after five seconds of
  complete byte silence — which a TUI painting a live elapsed-time counter
  never reaches. So the `complete` written when a turn ended survived the whole
  next turn, and a turn the agent started by itself (a background task
  finishing and the agent resuming, with no submitted input to open a new
  cycle) never reported running at all. An authoritative turn end now re-arms
  the cycle, threshold-based, so the next real burst of output reports running
  while idle chrome still cannot.
