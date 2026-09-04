### Added

- Tasks can now be finished from an agent, not only from the GUI: `task_gate_run`
  runs a task's completion gate (its trusted verify script, or npm lint + test)
  inside the task's own worktree and reports a structured verdict; `task_adopt`
  takes all of a task's changes into the parent repository as a staged,
  uncommitted patch; `task_close` and `task_pr` close a task or open its pull
  request. Each refuses with a named reason — a dirty worktree, unpushed
  commits, missing dependencies, a task branch that needs rebasing — instead of
  failing silently, and an adopt that will not apply cleanly leaves the parent
  repository untouched.
- `git_status`, `git_log` and `gh_pr_view` read a task's worktree as data, so a
  supervising agent no longer has to infer what a task produced from a terminal
  screen.

### Changed

- The sidebar's task list stays visible when it is empty, indents each task under
  the workspace that started it, and summarises finished tasks in one line
  instead of a list.
- Multi Task asks for confirmation before launching tasks with no prompt at all,
  and reports the launch in a single notification rather than one per task.
- Settings names what the `claude-pty` orchestrator option changes: it switches
  the Deck to a terminal interface.
