### Added
- Task ledger: a status log keyed by WorkTask id (`~/.wmux/task-ledger.jsonl`, WMUX_DATA_SUFFIX-scoped) recording `working → input_required / review_requested → completed / failed / cancelled` with compare-and-swap revisions, actor authorization and a gate-pass requirement for `completed`.

### Fixed
- Orchestrator: a brain that fanned out work now learns when its workers stop or wait for input — worker lifecycle events are copied to the owning workspace tagged with the task, bypass the owner's `none` wake policy, and are parked as a backlog when the owner has no brain yet.
