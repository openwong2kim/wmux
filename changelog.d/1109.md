### Fixed

- The per-hunk **Comment** button in the diff review panel works again. It
  called a native prompt dialog that Electron's renderer does not implement — the
  call threw, so posting a comment on a diff hunk silently did nothing. Comments
  are now typed inline (Enter to post, Esc to cancel), matching the panel's
  existing "Ask the orchestrator" composer, and the mission-channel post and
  agent mentions are unchanged.
