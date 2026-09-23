### Changed

- **Fleet is a task list, not a card grid.** Large terminal cards are replaced by compact, task-first rows with status filters and a workspace/task search. Each row shows the reported activity or pending question and an explicit pane action; raw terminal output moved into an optional preview of the selected pane. A completed response is no longer presented as a successful task, and stale activity is shown as unconfirmed.

### Fixed

- **Fleet no longer shows hook-driven active turns as idle.** Fleet now reads the same turn and liveness signals as the sidebar, keeps the selected pane across live reordering, and leaves typing focus in the search field while results change.
