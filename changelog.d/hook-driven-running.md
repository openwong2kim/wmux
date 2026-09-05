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

- **A turn that dies on an API error marks the pane errored (red ✕) instead of
  leaving it amber.** Claude Code fires `StopFailure` and no `Stop` on that
  path, so a pane the turn-start hook had lit stayed amber until the agent
  process died. wmux now registers `StopFailure` too, and reports the failed
  turn as its own notification rather than as "Task finished".

- **A pane settles the moment its shell is back at its prompt.** wmux reads
  your shell's integration markers, and a shell that has drawn its prompt again
  cannot have an agent working in it — so the agent you exited, or one that
  died on a network error with no turn end at all, stops sitting there lit.
  This is the settle that does not need wmux to identify the process that died,
  which is why it fires where the others cannot. `StopFailure` is registered on
  both install paths, but Claude Code does not always emit it — a turn that
  fails on "API Error: Connection refused" after its last retry ends with no
  hook — and panes whose shell emits no markers are unaffected: they keep the
  settle paths they already had. A finished turn keeps its result either way.

### Fixed

- **A pane whose agent died without a Stop now settles to idle.** An agent
  killed mid-turn (double Ctrl+C, `/exit`, a crash) sends no Stop hook, so a
  pane the hook had lit could stay amber long after the agent was gone. The
  agent process's death is now its own settle path — and when wmux cannot tell
  which process died, or never sees the death at all, the pane settles anyway
  30 minutes after its last hook signal. A turn that has already *finished*
  keeps its result: an agent exiting after its turn ended no longer wipes the
  "finished" or "needs you" state you had not read yet.

- **The sidebar roster no longer contradicts the dot above it.** A workspace
  row could show a running agent while its own roster row called the same pane
  "Idle": the row aged the turn out after two quiet minutes, which is exactly
  what a long, silent turn looks like. Both now read the same open turn.

- **A pane that changes agents no longer inherits the previous one's status.**
  Starting `codex` in a pane where `claude` had exited mid-turn left the new
  agent's dot governed by the old one's turn.

### Upgrading

- **Plugin users:** run `/plugin update` in Claude Code to pick up
  `wmux-claude-integration` 0.4.0, which registers the new hook.
- **Plugin-less installs (`wmux setup-hooks`):** re-run `wmux setup-hooks`, or
  just let the app do it — every launch refreshes the hooks. Then restart the
  Claude Code session. `wmux setup-hooks --status` gained a **turn-start
  signal** row that says whether the hook is installed. If you are on a plugin
  older than 0.4.0, that row and the turn-end row now read **STALE** and point
  at `/plugin update` — the plugin owns those hooks, so re-running
  `wmux setup-hooks` cannot supply them.
