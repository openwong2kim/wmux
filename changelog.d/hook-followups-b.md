### Fixed

- A Claude Code session that has only just started, sitting at its prompt with
  no turn yet, no longer shows as "needs you" — the red status dot, the
  "Waiting" label and the titlebar's "N need you" count all stay quiet until
  the agent actually wants something.
- The Deck fleet roster's status dots now derive "running" from the same
  signals the sidebar roster uses, so the two can no longer disagree about
  whether the same pane is working.
