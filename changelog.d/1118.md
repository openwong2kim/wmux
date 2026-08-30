### Fixed

- **Opening, closing, and switching browser tabs now land in the workspace the
  caller meant, not the one you happen to be looking at.** Every other browser
  command has resolved its workspace from the caller since #873, but
  `browser.open`, `browser.close` and `browser_tabs` read the workspace
  straight out of the request — the first two then fell back to whichever
  workspace was on screen. A tool working in a background workspace could open
  a page, close a browser, or switch and close tabs in front of you. All three
  now go through the same table as their siblings: a tool that claimed a
  workspace resolves to it without having to name it, naming someone else's is
  refused, and a caller that names nothing gets the same refusal the rest of
  the browser commands already give, with the same instructions for fixing it.
  Closing is the one that mattered most: it tears a surface down, and the two
  halves of the close path did not previously agree on who owned it.

  `wmux open` and `wmux browser close` keep working outside a wmux pane: they
  now ask which workspace is active and say so, the same way `wmux browser
  navigate` already did. And when a call is refused for scope, `browser_tabs`
  passes the refusal through instead of reporting it as a temporary outage — an
  agent that is told to retry something terminal retries it forever.

  Unchanged: the operator crossing workspaces on purpose, callers that already
  name their workspace, and the `external` browser backend — it hands the URL
  to your OS browser, which belongs to no workspace. `mcp.mode: shadow` still
  restores the previous behaviour for all of it. Also unchanged, and worth
  saying plainly: a connection that sends no identity at all is still allowed
  to name a workspace, here as everywhere else. That is the older grandfather
  rule, tracked separately, and this change does not close it.
