### Fixed

- **A bot task that changed nothing is no longer marked completed by the
  check.** A task that made no commits, such as one that only calls an API,
  had the repository's tests run on the unchanged code. When they passed, the
  task was closed as "gate passed, task completed", even when the task's own
  report said it had failed. Such a task now skips the check, shows "Gate
  skipped (the task made no changes)", and stays open until its bot settles it
  as completed or failed from the report.
