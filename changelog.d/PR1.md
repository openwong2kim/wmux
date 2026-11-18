### Added

- **A paired PC can be allowed to answer permission prompts in the tasks it
  sent here (receiving side).** `wmux remote approvals <pc> tool-only|command`
  turns it on for one PC; it is off for every PC until set, and a missing or
  damaged settings file keeps it off. While it is on, a permission prompt that
  the task's own turn raised in a linked pane is offered in the task's status:
  the tool name, and with `command` the call's command (secrets redacted, at
  most 2 KB). That PC's agent can then deny it, or allow a Bash, PowerShell or
  WebSearch call or a plan whose command it was shown whole. Read, WebFetch,
  Edit, Write and NotebookEdit prompts take only a deny. Any other key typed
  into the pane after the task was submitted ends this for the rest of the
  task. Each decision is typed once, logged with the PC that sent it, and
  never typed again after a restart. The sending side's command comes in a
  later release.
