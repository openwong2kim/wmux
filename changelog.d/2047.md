### Added

- **Per-account browser memory on protected panes.** A protected pane's
  recorded flows, promoted flows and site memory are now kept for that pane's
  Chrome account alone, instead of being switched off. They start empty, never
  mix with the workspace's other panes, and start over when the pane is
  rebound or moved. Memory of unprotected panes is unchanged.
- **Scheduled runs that act as a protected pane's browser.** A schedule's
  More options now has a Browser identity: pick a workspace and one of its
  protected panes, and the run browses as that pane's Chrome account, limited
  to its allowed sites. wmux confirms the pane, account and sites in its own
  prompt when you save. The run gets wmux's browser tools and nothing else of
  wmux. If the pane's site list, protection or account changes after you
  saved, the run's browser calls are refused at once and the run says why;
  save the schedule again to grant it. Schedules without a browser identity
  run exactly as before.
