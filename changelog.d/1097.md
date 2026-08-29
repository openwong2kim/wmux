### Fixed

- **A UI plugin can no longer reach into a workspace you are not in — read it,
  type into it, or tear it down.** An approved iframe plugin's browser calls
  have been held to the workspace hosting it since #941, and its private event
  and channel reads since #959, but the rest of its surface was not. Two
  different gaps, and the second was the worse one. A plugin that *named*
  someone else's workspace was answered about it: `pane.list` enumerated that
  workspace's panes and the agents in them, `pane.search` returned its
  scrollback, `pane.split` created a pane there, `browser.open` /
  `browser.close` opened and closed pages there, and `meta.setSkills` rewrote
  its agent skills. And a plugin that *omitted* the workspace skipped the
  ownership check entirely rather than failing it — the check reads the
  workspace from the request, so leaving it out meant there was nothing to
  check against. That second path reached further: reading another workspace's
  terminal viewport and command history, **typing into its terminal**, and
  reading or clearing its pane metadata, all by naming a terminal or pane id
  that ordinary pane lifecycle events hand to any plugin watching them.

  The workspace the plugin host is showing — which the plugin can neither see
  nor set — is now applied to every one of those before the call runs. Reads
  answer for the plugin's own workspace, so an approved plugin keeps working
  instead of erroring; writes are refused, because quietly redirecting an
  action creates a pane, sends a keystroke, or closes a session somewhere
  nobody asked for. `pane.focus` / `pane.close` / `pane.stash` / `pane.unstash`
  address a pane directly and have no workspace to pin, so they are confined
  through the same channel a workspace-bound agent already uses — `pane.close`
  had no confinement at all before, and closing a pane disposes its terminal
  sessions. A plugin whose host has no active workspace is refused rather than
  left free to name one.

  As with the earlier steps, this confines an **approved** plugin to the scope
  its approval implied — it is not a defence against hostile code already
  running as your user — and callers on the local RPC wire are unchanged.
