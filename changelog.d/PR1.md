### Added

- **A paired PC can be allowed to answer permission prompts in the tasks it
  sent to a linked pane here (receiving side).** `wmux remote approvals <pc>
  tool-only|command` turns it on for one PC, after you type `yes` in a
  terminal; lowering it or turning it off does not ask. It is off for every
  PC until set, a missing or damaged settings file keeps it off, and a PC
  that is removed and paired again starts off. While it is on, a permission
  prompt that the task's own turn raised is offered in the task's status:
  the tool name, and with `command`, for a Bash, PowerShell or WebSearch
  call or a plan, the call's command (secrets redacted, at most 2 KB). That
  PC's agent can then deny it, or allow such a call whose command it was
  shown whole and that has no other input it was not shown. Read and
  WebFetch prompts can only be denied from the other PC, and their path or
  address is not sent. File-edit prompts (Edit, Write, NotebookEdit) can
  only be denied from the other PC; allowing them stays with the person at
  this PC. Today they are not offered at all, since this PC cannot yet tie
  their dialog to the agent's call. Any other key typed into the pane after
  the task was submitted ends this for the rest of the task, and so does a
  later message delivered into the pane:
  prompts in a follow-up's turn are answered at this PC. Each decision is
  typed once, logged with the PC that sent it, and a resend gets the same
  answer, also after a restart. On a PC where the desktop app runs, the
  daemon takes this setting only from the app, so `wmux remote approvals`
  is refused there until the app has a setting for it in a later release.
  The sending side's command also comes in a later release.
