### Added

- `approval_press` — an orchestrator brain can now answer an approval prompt on
  a fan-out worker **it delegated**, instead of typing the digit `1` at whatever
  happens to be on that worker's screen. The press resolves the approval record,
  so the prompt is confirmed to still be there, the operator's autonomy policy
  decides whether it may land, and the decision is written to the approval
  history. `decision` must be given explicitly — there is no default, and an
  unnamed decision is never taken as an approval. A pane holding more than one
  pending approval is refused as ambiguous rather than guessed at, and the tool
  hands back the ids to choose from. On a pane wmux holds an approval record
  for, a brain's `terminal_send` / `terminal_send_key` is refused and points at
  the tool — except `ctrl+c` and `escape`, which still go through so a runaway
  worker can always be interrupted. If the press is refused because the operator
  has autonomy or approval-press off for that worker, the block lifts so the
  brain is never left with no move at all. Your own typing is unaffected.

- Approvals raised by a permission gate now carry `deadlineAt`, the moment the
  gate really stops waiting — reported by the gate broker that holds the timer,
  so a surface can show an honest countdown.

### Fixed

- Fan-out workers no longer freeze on Claude Code's first-run screens. A `claude`
  worker is launched with the environment flag that skips the workspace-trust
  dialog (wmux writes nothing to your global Claude Code config), and a worker
  left sitting on a known one-shot onboarding screen is dismissed automatically.
  One that is still stuck is reported as `input_required` in the task ledger
  instead of looking idle forever. Set `WMUX_AGENT_FIRST_RUN=off` to turn both
  behaviours off.

- A fan-out task workspace now inherits the autonomy of the workspace that
  launched it, so a brain running in `danger` can actually act on its workers'
  approvals. Previously every task workspace was created with no autonomy entry
  at all, which reads as `off`. An owner in `assist` still gets workers whose
  approvals must be answered by a human — that is what `assist` means.
