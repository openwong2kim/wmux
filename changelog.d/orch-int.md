### Added

- **An orchestrator can now finish the tasks it starts.** Fanning out could open
  N isolated tasks, and then nothing: running a task's completion gate, taking
  its changes back into the parent repository, opening its pull request and
  closing it were all reachable only from the desktop UI, so a supervising agent
  could do nothing but ask you to click four times per task. It can now do all
  four itself, and read a task's git status, recent commits and PR state as data
  instead of guessing from a terminal screen. It can also stop a gate that is
  still running, rather than waiting out a hung test suite for fifteen minutes.

- **Closing a task or opening its PR asks you first.** Those two are the ones
  nothing can take back — one removes a git worktree, the other pushes a branch
  to your remote — so each raises the same approval prompt a fan-out does, naming
  the task, its branch and the exact commit it points at, and auto-denying if
  nobody answers. If the worker pushes another commit while the prompt is up,
  the pull request is refused rather than sending something you did not see.
  Running a gate and adopting a task's changes do not prompt: a gate run is
  reversible by ignoring it, and adopted changes land staged and uncommitted.

### Fixed

- **An approval prompt waiting behind another no longer expires unseen.** Each
  prompt's 30-second countdown started when it was created, so a second one
  queued behind the first could auto-deny having never been on screen — a
  refusal nobody made. The clock now starts when the prompt is actually shown.

- **An agent with autonomy on can answer its own workers' prompts again.** The
  check that keeps automated approval presses inside delegated task panes had no
  way to learn which panes those were, so it refused every one of them. It is now
  told, and a refusal says whether it was policy or missing wiring. Presses into
  a pane you opened yourself are still refused, and a person answering from the
  phone or the web was never subject to any of this.
