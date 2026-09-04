### Fixed

- **A fan-out worker no longer launches on whatever model your shell profile
  exports.** The worker's command is typed into the pane's interactive login
  shell, so an `ANTHROPIC_MODEL` exported by `~/.zshrc` (or any other rc file)
  overrode the environment wmux had set and every worker's first turn came back
  "There's an issue with the selected model", indistinguishable from an idle
  worker. A `claude` worker's launch now unsets that variable in the pane's own
  shell, which is the only place late enough to win — and it does it without
  bypassing your shell, so an aliased `claude` (what `claude migrate-installer`
  leaves behind) still resolves.

  Three things call it off, each because wmux would otherwise be overruling a
  choice you made: a launch that already passes `--model`; a role bound to an
  agent and a model in Settings, whose flag is spliced in first; and a shell
  that routes claude through a gateway (`ANTHROPIC_BASE_URL`), where the model
  name is exactly what the gateway needs. `ANTHROPIC_BASE_URL` and
  `ANTHROPIC_AUTH_TOKEN` are never touched — routing claude through your own
  proxy is a whole-machine choice, and a worker that quietly bypassed it would
  be talking to a different endpoint than every other pane you open. Panes whose
  shell is fish, PowerShell or nushell are left alone entirely.

- A fan-out worker whose first turn fails on its model is now reported as
  `input_required` in the task ledger, with the model it was refused and where
  that model came from, instead of sitting in `working` next to an idle-looking
  pane. wmux reports that screen rather than typing at it, and looks once more a
  few seconds after the pane goes quiet — the error only arrives after the agent
  has painted its composer and been refused.
