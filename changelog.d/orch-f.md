### Added
- Task ledger: a status log keyed by WorkTask id (`~/.wmux/task-ledger.jsonl`, WMUX_DATA_SUFFIX-scoped) recording `working → input_required / review_requested → completed / failed / cancelled` with compare-and-swap revisions, actor authorization and a gate-pass requirement for `completed`.

- MCP: `ledger_update` (every profile) lets a fan-out worker record `review_requested` / `input_required` on its own task; `ledger_list` is a commander-only tool (registered only under `--commander`, never in the full or core profile) that shows the brain the tasks it owns. Fan-out prompts now tell workers to report through the ledger instead of a chat "done".

- Orchestrator: `deck.ledgerGate` (default off, `~/.wmux/deck-ledger-gate.json`) makes the brain's Stop gate hold a turn while the ledger lists open tasks it owns, with the existing consecutive-block cap and hysteresis; while on, `deck_ask_decision` shows the human the open-task list.
- Every ledger transition is posted to the task's mission channel as `[ledger] <task> <from>→<to> <by> <summary>`.

### Fixed
- Orchestrator: a brain that fanned out work now learns when its workers stop or wait for input — worker lifecycle events are copied to the owning workspace tagged with the task, bypass the owner's `none` wake policy, and are parked as a backlog when the owner has no brain yet.
