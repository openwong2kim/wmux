### Changed

- **A2A messages now name the pane, not just the workspace.** The sender and
  receiver in an agent-to-agent message read `Workspace.pane` (for example
  `Simply.q1` writing to `Simply.release`), using the pane's own name. Before,
  two panes in one workspace were indistinguishable. A broadcast, and a message
  from a sender wmux cannot tie to a pane, still show the workspace name only.
