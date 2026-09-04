### Fixed

- **A project with no lint or test script can finish a task again.** The
  completion gate refuses to certify a repository it cannot grade, but it also
  recorded nothing when there was nothing to run — and the task ledger will not
  mark a task completed without a recorded pass. So any repository that declares
  neither `scripts/verify.sh` nor npm `lint`/`test` scripts could only be closed
  by forcing it. Running the gate on such a project now records an honest
  verdict — a pass whose command is `none` and whose note says no gate exists —
  and the task completes normally. The two skips that mean the gate *could not*
  run (missing dependencies, a command that would not start) still record
  nothing, because there a human should look. The waiver needs the parent
  repository to agree: a task worktree that has lost the lint or test script its
  project declares records a *failing* gate naming what is missing, not a pass.
  This also unblocks projects that are not Node projects at all, which used to
  be turned away for having no `node_modules` before anything asked whether they
  had a gate to run.

- **The orchestrator can read the repository it just adopted into.** `git_status`
  and `git_log` only accepted a task id, so after taking a task's work into the
  parent checkout there was no way to look at that checkout — the parent
  repository is not a task. Both now work with no task id at all and answer for
  the repository your own terminal is in.

### Added

- **`task_adopt` can commit what it takes, so several tasks can be adopted in a
  row.** Adopt left its changes staged, which made the first adopt easy to review
  and the second one impossible: the target repository was now dirty, and adopt
  refuses a dirty target rather than mixing two authors' edits together. Passing
  `commit: true` commits exactly what was adopted, with a message naming the
  task, and returns the commit's short hash. It commits only the adoption: if
  anything else has been staged in the target since the adopt began, it refuses
  and puts the adopted paths back rather than sweeping someone else's work into
  the task's commit. The default is unchanged — staged and uncommitted — and
  nothing is ever pushed.
