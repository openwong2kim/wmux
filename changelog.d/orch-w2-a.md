### Fixed

- Fan-out workers no longer freeze on Claude Code's first-run screens. A `claude`
  worker is launched with the environment flag that skips the workspace-trust
  dialog (wmux writes nothing to your global Claude Code config), and a worker
  left sitting on a known one-shot onboarding screen is dismissed automatically.
  One that is still stuck is reported as `input_required` in the task ledger
  instead of looking idle forever. Set `WMUX_AGENT_FIRST_RUN=off` to turn both
  behaviours off.
