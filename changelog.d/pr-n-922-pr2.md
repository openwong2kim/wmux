### Fixed

- **A UI plugin can no longer read, search, or build in a workspace you are not
  in.** An approved iframe plugin's browser calls have been held to the
  workspace hosting it since #941, and its private event and channel reads
  since #959 — but a family of methods resolved their workspace from the
  request body and were never covered. A plugin that named someone else's
  workspace id was answered about it: `pane.list` enumerated that workspace's
  panes and the agents running in them, `pane.search` and `input.readScreen`
  returned its scrollback and viewport text, `pane.split` created a pane in it,
  and `browser.open` / `browser.close` opened and closed browser surfaces
  there. The ownership check that looked like it covered the terminal reads did
  not: it verified that the named workspace and the terminal agreed, never that
  the named workspace was the caller's, and it was skipped entirely when no
  workspace was named. The workspace the plugin host is showing — which the
  plugin cannot see or set — is now applied to all six before the call runs.
  Reads answer for the plugin's own workspace, so an approved plugin keeps
  working rather than erroring; writes are refused outright, because quietly
  creating a pane or opening a page in a workspace nobody asked for is not a
  safe way to fail. A plugin whose host has no active workspace is refused
  rather than left free to name one. As with the earlier steps, this confines
  an approved plugin to the scope its approval implied — it is not a defence
  against hostile code already running as your user — and callers on the local
  RPC wire are unchanged.
