### Fixed

- `browser_session_status` now reports the profile **your** workspace is bound
  to. It sent no workspace identity to the daemon, so on the chrome backend the
  server could not tell which workspace was asking and fell back to the default
  profile — a workspace bound to Live Chrome (or any named profile) was reported
  as `default`, hiding that the agent was actually pointed at the owner's real
  browser. It now resolves and passes the caller's workspace, like every other
  workspace-scoped browser tool.
