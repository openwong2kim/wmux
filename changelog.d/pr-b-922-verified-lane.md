### Fixed

- **A browser call that never says which workspace it means no longer lands on
  whichever browser happened to open first.** Until now, a caller on the local
  RPC wire that left the workspace out was resolved against the first surface
  that had registered — which could easily be a workspace it had nothing to do
  with. That case is refused now, and the refusal says what to add: send
  `workspaceId`, with `workspace.current` for the one you are in and
  `workspace.list` for every id. A caller that already names a workspace is
  unchanged.

- **A tool that asked wmux for its own workspace is now held to it, on every
  call that says so.** When an external tool calls `mcp.claimWorkspace`, wmux
  creates a workspace for it and now hands back a token bound to that
  workspace. A call that carries the token resolves to the workspace wmux
  actually created rather than to whatever id the tool names, so naming
  someone else's is refused instead of answered; if that workspace is closed,
  the token stops resolving and the call is told to claim again.

  Three limits, stated rather than left to be inferred.

  The binding is a property of **the call**, not of the caller. wmux has no
  record that a given tool ever claimed — a name a caller picks for itself is
  not an identity — so a call that simply leaves the token out is treated as
  one from a tool that never claimed. The bundled client stamps the token on
  everything it sends once it has one, so an honest tool is held to its
  workspace; a caller that wants the old behaviour can still omit the field.

  It binds an **approved** tool to the scope its approval implied. The token
  sits in that tool's own process, so it is not a defence against hostile code
  already running as your user.

  And it reaches the browser commands that resolve a target through the shared
  scope table. `browser.open`, `browser.close` and `browser_tabs` resolve
  theirs on a separate path and are covered by the change that follows this
  one.
