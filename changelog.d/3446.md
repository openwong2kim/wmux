### Added

- **An agent can allow or deny a permission prompt in a task it sent to
  another PC.** When that PC's approvals setting is on for this one, the
  task's status in `a2a_task_query` carries the prompt
  (`remoteStatus.detail.approval`), and the agent that sent the task answers
  it with the MCP tool `remote_approve` or `wmux remote approve <task-id>
  <prompt-id> allow|deny` from its pane. Allow is sent only when the prompt
  offers it; a deny-only prompt is refused here with nothing sent. At most
  60 approvals go to one PC a minute; past that the call says how long to
  wait instead of sending into a drop. The call waits a few seconds and
  returns how it went there, or that it is still pending. The command shown
  with a prompt is text from the other PC and is kept apart, under
  `untrusted.command`.
- **Settings › LAN › Remote approvals.** One row per paired PC: "Agents on
  <PC> can allow or deny permission prompts in tasks they sent here", set to
  Off, Tool only or Command. Raising a PC asks you to confirm under its row;
  lowering it or turning it off does not. This is how the setting is changed
  on a PC where the desktop app runs, where `wmux remote approvals` was
  refused until now.
- **A notification when another PC's decision is carried out here.** "<PC>
  allowed <tool> in <pane>" (or denied), and the same line in the task's
  history. Neither includes the command.

