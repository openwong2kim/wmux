### Added

- **A role can start each new task in a fresh conversation.** Settings →
  Roles now offers "Fresh context per task" for roles bound to Claude Code or
  Codex. When the orchestrator hands such a pane a NEW task
  (`terminal_send` with the new `new_task` flag), or another agent sends it a
  new task with `send_message`, wmux first types the agent's own
  fresh-context command (`/clear` for Claude Code, `/new` for Codex), waits
  until the pane shows it finished, and only then delivers the task. Before,
  a long-lived worker pane carried every earlier task's conversation into the
  next one. Both keys are needed: the role's setting and the caller's
  new-task signal, so a follow-up, a reply or a status update never clears a
  pane, and no agent can clear a pane whose role did not opt in. A pane whose
  agent is working, whose input box holds a draft, which runs a different
  agent than the role names, or which still has other open agent tasks gets
  the task without a clear, and the reply says why. If the command does not
  finish within 8 seconds, the task is not sent and the call fails, so the
  text never lands in the old conversation. The `input.send` param `newTask`
  and the reply fields `freshContext`, `freshContextCommand`,
  `freshContextSignal` and `freshContextReason` are experimental.
  `wmux role resolve` reports `freshContext` for a role. (#1680)
