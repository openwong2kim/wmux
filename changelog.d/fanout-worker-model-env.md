### Fixed

- **A fan-out worker no longer launches on whatever model your shell profile
  exports.** The worker's command is typed into the pane's interactive login
  shell, so an `ANTHROPIC_MODEL` exported by `~/.zshrc` (or any other rc file)
  overrode the environment wmux had set and every worker's first turn came back
  "There's an issue with the selected model", indistinguishable from an idle
  worker. A `claude` worker is now launched with that variable neutralised on the
  command line itself, which is the only place late enough to win. A launch that
  already names a model — an explicit `--model`, or a role bound to an agent and
  model in Settings — is left exactly as it is. `ANTHROPIC_BASE_URL` and
  `ANTHROPIC_AUTH_TOKEN` are deliberately untouched: routing claude through your
  own proxy is a whole-machine choice, and a worker that quietly bypassed it
  would be talking to a different endpoint than every other pane you open.

- A fan-out worker whose first turn fails on its model is now reported as
  `input_required` in the task ledger, with the model it was refused and the
  `/model` fix, instead of sitting in `working` next to an idle-looking pane.
  wmux reports that screen rather than typing at it.
