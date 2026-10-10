### Changed

- **Another computer's workspaces look like its own sidebar.** With a paired
  computer selected, its workspace rows are drawn exactly as that computer
  draws them: numbered in its order, with the same status marks, needs-you
  card, idle time, branch line, and the expandable rows for each pane's agent
  and pane name ("Claude Code · w1-1"). Clicking a pane row opens that tab.
  Nothing there can rename, close, drag or archive anything on that computer.
- **The host list carries each pane's name, tab title and last output time.**
  `GET /api/workspaces` adds optional `paneName`, `surfaceTitle` and
  `lastActivity` to each pane; older clients ignore them.
