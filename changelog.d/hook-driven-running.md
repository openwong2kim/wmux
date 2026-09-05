### Changed

- **A Claude Code pane turns amber the moment you submit a prompt.** The
  running dot used to come from a byte-rate guess — roughly 2 KB of output had
  to flow before wmux would call the pane busy, so the first seconds of every
  turn looked idle. wmux now registers Claude Code's `UserPromptSubmit` hook,
  which fires once per turn, and the pane lights on the prompt itself.

- **A hook-governed pane no longer flickers.** While the hook speaks for a
  pane, the byte heuristic stops writing its status in both directions: quiet
  reasoning, a long web search, or a slow `bash` no longer drops the pane to
  idle mid-turn, and a mid-turn redraw burst no longer overwrites a correct
  "finished" or "needs you" with "running". Panes with no hook bridge — and
  panes whose bridge only reports turn *ends* — keep the heuristic exactly as
  it was.

### Fixed

- **A pane whose agent died without a Stop now settles to idle.** An agent
  killed mid-turn (double Ctrl+C, `/exit`, a crash) sends no Stop hook, so a
  pane the hook had lit could stay amber long after the agent was gone. The
  agent process's death is now its own settle path.

### Upgrading

- **Plugin users:** run `/plugin update` in Claude Code to pick up
  `wmux-claude-integration` 0.4.0, which registers the new hook.
- **Plugin-less installs (`wmux setup-hooks`):** re-run `wmux setup-hooks`, or
  just let the app do it — every launch refreshes the hooks. Then restart the
  Claude Code session. `wmux setup-hooks --status` gained a **turn-start
  signal** row that says whether the hook is installed.
