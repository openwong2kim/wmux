# Orchestrator track wave 1 — live dogfood (2026-09-04)

Build under test: packaged local build of `feat/orch-integration` at the commit that became #1201 (main `2c4006ec`), i.e. #1195 + #1198 + #1197 + #1200 + #1199 + #1201. Run as an isolated instance (`WMUX_DATA_SUFFIX=-demo`, `~/.wmux-demo`), driven from a pane inside that instance with the worktree's MCP bundle (pane identity) and the demo CLI (`read-screen --pane`, `send-key --pane`). Fan-out approval was clicked through the demo renderer over CDP.

## Scenario run

`fanout_start` × 2 tasks from Workspace 1 (scratch git repo) → workers create `DOGFOOD.md`, commit, post `[done]`.

| Step | Result | Evidence |
|---|---|---|
| fan-out accepted, approval dialog, 2 worktrees + 2 workspaces + 2 mission channels | pass | `fanout_start` poll → `completed`, tasks `wtask-mtme686n-2nk9j3go`, `wtask-mtme68b2-my9j0qr8` |
| ledger registers each task as `working` (system actor, rev 1) | pass | `~/.wmux-demo/task-ledger.jsonl` `entry … working rev1 by=system` ×2 |
| ledger transition posted to the mission channel | pass | channel seq 1: `[ledger] <task> new→working system@daemon` in both channels |
| worker stop events routed to the OWNER workspace, tagged with the task | pass | `orphaned_event agent.stop {osc133, detector, hook} <pty> task=<taskId>` for both workers — three sources each |
| owner has no brain ⇒ events parked as backlog (not dropped) | pass | same rows; nothing consumed silently |
| workers finish the job | pass | commits `6e090d2`, `6d4193b` on `wtask/*` branches; `[done]` at channel seq 2 in both channels |
| brain wake from the backlog | not exercised | the demo workspace has no Deck brain (would need a claude-pty brain + commander token) |
| `task_gate_run` / `task_adopt` / `task_close` / `task_pr`, their approval dialogs, ledger `review_requested → completed` | not exercised | commander-only tools; no commander identity in this harness |
| submit receipt 20/20 and 0/20 tallies | not exercised live | covered by fake-PTY tests in #1199; needs a pane-side harness against a Claude pane |

## Findings

1. **Fan-out workers stall on Claude Code's own first-run prompts.** In a fresh worktree Claude Code shows the folder trust prompt (`Is this a project you created or one you trust? ❯ No, exit`) and then the auto-mode onboarding prompt (`Teach auto mode about your environment? ❯ 1. Yes`). Nothing presses them: they are not approval prompts, so `approvalPress` never applies, and the worker sits there indefinitely with `agentStatus: idle`. Reproduced on all 4 workers across two runs. Candidates: pre-trust the worktree path before spawning (Claude Code stores trust per directory), or pass the flags that skip these prompts in the fan-out launch command.
2. **`ledger_update` is absent from the workers' tool list in the demo instance** because the isolated instance deliberately skips MCP registration (`McpRegistrar … skipping external agent config registration`), so the workers loaded the installed release bundle. Expected for `-demo`; on a real install the new bundle ships with the release. Workers reported it honestly and fell back to `[done]` on the channel.
3. **The daemon keeps the launcher's environment across app restarts.** The first demo launch inherited `ANTHROPIC_MODEL=glm-5.3` from the launching shell; every worker `claude` failed its first turn with "issue with the selected model". Relaunching the app did not help because the daemon process survived with the old env; the workers were recovered with `/model opus` per pane. Operator note, not a product bug — but a fan-out worker whose first turn errors is indistinguishable from an idle one to the owner (finding 1 again).
4. **Fan-out approval window is 45 s** (`APPROVAL_TIMEOUT_MS`), with no phone/remote notification: two earlier attempts from the real instance were denied on timeout while the owner was on the phone. Already recorded in memory.
5. **Cross-workspace `terminal_read` is refused for pane callers** (by design). To watch workers from outside, `wmux read-screen --pane <pty>` (first-party CLI) works.

## What this proves / does not prove

Proves the lane F mechanism the review called decisive: a fan-out worker's stop reaches the parent workspace tagged with its task, survives the parent having no brain, and the ledger + mission channel record the same timeline. Does not prove the brain-side loop (wake → gate → adopt → report); that needs a Deck brain in the isolated instance and is the first item for the wave 2 dogfood.

## Merged PRs

#1195 (cap + ledger types), #1198 (lane F), #1197 (lane O2), #1200 (invariant hotfix), #1199 (lane O1), #1201 (integration).

## Addendum 14:05 — brain boot replays the parked backlog (live)

Packaged build of main `2c4006ec` (post-#1201), same `-demo` instance. Setting the owner workspace's Deck mode to **Danger** through the mode listbox spawned a claude-pty brain (`brain-758252ee…`). Within seconds the brain's first turn was the **replayed orphan backlog**: the wake prompt carried the worker's last message (the `[done]` report from task b) with `autonomy: summarize=on continue-instruction=on approval-press=on wake-budget 5/5`, and the ledger log gained `orphans_drained` for the owner workspace. So the wave-1 chain "worker stop → owner backlog → brain boot → wake" is confirmed end to end.

**Finding 6 (brain-side, wave 2 item):** the brain then concluded "no follow-up needed" and ended its turn without calling `ledger_list` or `task_gate_run`. The replayed wake prompt names the worker pane and its last message but not the task id, its ledger status (`working`), or the expected next step; the brain has no reason to look at the ledger. The wake prompt for task-tagged events should carry `task=<id> status=<ledger status>` and a one-line contract ("run task_gate_run, then ledger_update completed, then task_adopt"), and the Stop gate (`deck.ledgerGate`, OFF here) is what would have held the turn open. Both belong to wave 2 lane A/B scope.

## Wave 2 — brain-side dogfood (2026-09-04, 17:45–18:00)

Build under test: packaged local build of main `d7110915` (#1203 revert + #1206 A + #1204 B + #1205 C + #1207 E; #1208 D is browser-only and not on this path). Same isolated instance (`WMUX_DATA_SUFFIX=-demo`), owner workspace already in Deck mode **Danger** from the wave 1 run. Fresh scratch repo with no gate scripts (to exercise E-1). `fanout_start` × 2 tasks from a pane in the owner workspace, approval clicked through the demo renderer over CDP.

| Check | Result | Evidence |
|---|---|---|
| Worker first-run screens (A-1) | pass | both workers landed on the composer with no trust / onboarding dialog; screen shows the task prompt and Claude working within seconds of spawn |
| Task workspace inherits owner autonomy (A-2 precondition) | pass, with a side effect (finding 7) | `deck-autonomy.json` gained `danger` rows for both task workspaces |
| Fan-out accepted → 2 worktrees, 2 workspaces, 2 mission channels, ledger `working` rev 1 | pass | `wtask-mtmpqbtw-morg5nvv`, `wtask-mtmpqglw-kbi4efo3` |
| Workers do the job | pass | commits `0ba4351` / `5701853` `dogfood: note` on `wtask/w2-task-*` |
| Worker stop → **owner** backlog / owner brain wake ≤ 5 s | **fail** (finding 7) | ledger shows 0 new `orphaned_event` rows; owner brain session untouched; the stops were consumed by the task workspaces' own brains |
| Wake prompt carries task id + ledger status + next-step contract (A-2 coalescer) | not observed | the only wakes that fired were the task-workspace brains' own `[pane-events]` (no `task=` tag, because they are not owner-routed) |
| `task_gate_run` no-gate record (E-1), `task_adopt commit:true` (E-2), `git_status` on the caller repo (E-3), `approval_press` | not exercised | no owner brain turn happened; see finding 7 |
| Deck task panel (B-1) | pass (visual) | sidebar TASKS (4→6) listed the new tasks immediately after fan-out |

## Findings (wave 2)

7. **Autonomy inheritance spawns a Deck brain per task workspace, which hijacks the worker's stop events.** `inheritTaskAutonomy` writes `mode: danger` for the task workspace; the Deck treats any workspace with a non-off mode as brain-eligible, so `deck-commander.json` gained a `claude-pty` session for each task workspace within one second of spawn (`brain-4c7c…` for task a, `brain-9c8a…` for task b). Those brains received the workers' stop events as `[pane-events] seq=25 … kind=stop` and acted as operators on their own worker (typed `/model opus`, re-instructed the worker, asked it to record a `TASK-B-RESULT.md`, which produced an extra commit `82ae027`). Nothing reached the owner: no `orphaned_event`, no owner brain wake. Cost: one extra Claude session per worker; the Stop gate then held task b's brain for 66 assistant turns / 32 tool calls / 6 gate holds because "1 worker pane still need you — running". Fix shape for wave 3: inherit only the press caps for the task workspace (or mark it brain-less), never a mode that makes it brain-eligible; alternatively route task-workspace pane events to the owner before the workspace's own Deck sees them.
8. **Demo workers still load the installed release MCP bundle**, so `ledger_update` is absent and the workers cannot move the ledger to `review_requested` (repeat of finding 2; the task brains noticed and reported it correctly). The brain-side chain past `working` therefore cannot be driven from the workers in the `-demo` instance without registering the packaged bundle for them.
9. **Fan-out worker inherits a bad `ANTHROPIC_MODEL` from the login shell** (`glm-5.3`, repeat of finding 3, now from `~/.zshrc` rather than the daemon env): worker a's first turn failed with "issue with the selected model". The task brain recovered it with `/model opus`; the owner would have seen an idle worker. Operator environment, not a product bug, but the wake prompt has no way to distinguish "errored first turn" from "idle".
10. **Demo CDP port can collide with the real app's port** (`18800 + random(100)`): the first demo launch logged port 18885, which the real /Applications wmux already owned, so the CDP driver was talking to the real renderer (it clicked "expand dock" there once; no approval was pressed). Check `lsof -iTCP:<port>` owns the demo pid before driving anything.

## What this proves / does not prove (wave 2)

Proves A-1 (no first-run stall) and A-2's inheritance write, B-1's panel, and the fan-out → worker → commit chain on the packaged wave 2 build. Does not prove the owner-brain loop (wake with task id/status → gate → adopt → press): finding 7 blocks it structurally, so the wave 2 pass criteria (5 unattended runs, wake ≤ 5 s, 0 stalled workers) were not attempted. First item for wave 3.

## Merged PRs (wave 2)

#1206 (lane A), #1204 (lane B), #1205 (lane C), #1207 (lane E), #1208 (lane D), after one review round (Claude + GLM) with fixes pushed to each branch; #1203 reverted the unshipped 3.51.0 release commit.

## Wave 3 — re-run on the task-workspace fix (2026-09-04, 18:07–18:20)

Build under test: packaged local build of main `2125041e` + `fix/task-workspace-no-brain` (PR #1212, first commit). Same `-demo` instance and owner workspace, fresh `fanout_start` × 2 (`w3-task-a/b`), approval clicked over CDP on the demo's own port (checked with `lsof`).

| Check | Result | Evidence |
|---|---|---|
| No brain for a task workspace (finding 7 fix) | pass | `deck-commander.json` gained no session for `ws-86df…`/`ws-90ad…`; no new `brain-*` pty for 5 min after spawn (the wave 2 run had one within 1 s) |
| Worker first-run screens (A-1) | pass | both workers on the composer immediately |
| Owner brain wake on a worker stop | **blocked by design, then pass** | the owner workspace carried a **pending decision** from the previous session ("A request from before this wmux session is still on the books. Resume it, or drop it?") — a pending decision consumes every wake, so nothing woke the owner in the wave 2 run either. Answering it (Drop it) spawned the owner brain `brain-751330e3…` within seconds |
| Brain reads the wave 2 tool contracts | pass | 23 tool calls in one session: `task_adopt` ×2 with `commit: true` (it quoted the "sequential adopts need commit: true" description), `git_status` ×2, `ledger_update`, `deck_complete_work` ×2, `deck_ask_decision`, `terminal_read`/`terminal_send` on its workers |
| E-2 `task_adopt commit:true` | tools honest, brain not | first adopt → `dirty-target` (the wave 1 repo had uncommitted changes), second → `commit-failed` with the affected paths restored. The brain then reported "adopt finished (ff51d7e, target clean)" — no such commit exists anywhere; its `git_status` of the (fresh) caller repo was clean for an unrelated reason |
| E-3 `git_status` without `task_id` | pass | `target: "caller-repo"`, `repoRoot` = the owner pane's repository |
| E-1 no-gate completion | not reached | `ledger_update completed` → `ILLEGAL_TRANSITION working → completed` (the brain skipped `review_requested`, which only the worker can set — and the demo workers still have no `ledger_update`, finding 8) |
| `deck_complete_work` | **false refusal** (finding 11) | `workers_outstanding` naming `daemon-5dac0302` — the operator's idle **shell** pane in the owner workspace (`agent: null`, `status: running`), i.e. the pane the dogfood harness was typed into. The brain raised a decision about it and stopped |
| `approval_press` | not exercised | worker a hit a Claude Code permission prompt ("Create DOGFOOD.md and stage it — proceed?") while the owner brain was mid-turn (4 min, held by the active-work gate); the buffered `awaiting_input` was then swallowed by the brain's own new pending decision |

## Findings (wave 3)

11. **The stop gate counts an agent-less shell pane as an outstanding worker.** `deck_complete_work` refused with `workers_outstanding` for `daemon-5dac0302`, a plain zsh pane (`agent: null`) whose `status` read `running` because a command had been typed into it. A shell is not a worker; the completion gate (and the Stop gate's snapshot inference) should only count panes with an agent, or the owner's open ledger tasks.
12. **A pending decision is a silent kill switch for the whole delegation loop.** The parked-work prompt from the previous session was raised automatically at boot and sat unanswered; every worker stop routed to the owner was consumed while it was pending, with nothing in the ledger or the app log saying why. The wave 2 run's "owner never woke" had this as a second cause on top of finding 7. At minimum the coalescer should log the consumed wake with the decision id, and the fan-out reply should warn when the owner workspace has a pending decision.
13. **The brain reported an adopt the tools had refused.** Both `task_adopt` calls answered `ok: false` (`dirty-target`, `commit-failed`) and the brain's summary still said "adopt finished (ff51d7e)". The tool results were correct; this is the coalescer/verdict text problem the wave 2 lane A work targeted, now visible on the adopt path.
14. **`ledger_update` from the brain straight to `completed` is refused** (`ILLEGAL_TRANSITION working → completed`). Correct by the ledger rules, but the brain has no way past it when the worker lacks the ledger tool (finding 8): the brain-side contract text should say `review_requested` is the worker's, and name `force` with a reason as the only brain-side exit.

## What this proves / does not prove (wave 3)

Proves the fix: no brain spawns for a task workspace, and the owner brain wakes, reads its ledger, and uses the wave 2 task/git tools once the pending decision is cleared. Does not prove `approval_press`, the no-gate `completed` path, or a clean `task_adopt commit:true` — each was blocked by one of findings 8, 11, 12 rather than by its own code. Pass criteria (5 unattended runs, wake ≤ 5 s) still not attempted.

## Wave 3 — second run, findings 11–14 fixed (2026-09-04, 23:31–23:40)

Build under test: packaged local build of main `90a8c7ec` (= #1212 + #1214 + #1213). Same `-demo` instance and owner workspace, which still carried the brain's own pending decision from the first run (the shell-pane question). Fresh `fanout_start` × 2 (`w3b-task-a/b`) was sent **while that decision was still pending**, on purpose, then the decision was answered over CDP.

| Check | Result | Evidence |
|---|---|---|
| `fanout_start` warns about the pending decision (F12) | pass | reply started with `WARNING: owner workspace … has a pending decision 3056a333…; worker events will not wake the brain until it is answered` and carried the same text in `warnings[]` |
| Dropped wakes are logged and delegated events parked (F12) | pass | app log: `[deck] wake for <owner> dropped: pending decision 3056a333…; 4 events (4 delegated parked for replay: wtask-…)`; ledger gained `orphaned_event` rows and an `orphans_drained` |
| Parked events replay on the resume turn (F12) | pass | answering the decision spawned `brain-3e74c566…`; its first prompt was a `[pane-events]` block carrying the four parked `worker-task=…` stops, followed later by the two new workers' stops |
| No brain for a task workspace (#1212) | pass | `deck-commander.json` unchanged for `ws-16d5…`/`ws-b71c…` |
| `deck_complete_work` ignores the operator's shell pane (F11) | pass | the same harness pane (`daemon-5dac0302`) that refused the first run was live again; the call answered `ok: true` and the work record closed |
| Owner brain wake on a worker stop | pass, late | first new-worker stop 14:34:57Z → wake delivered 14:36:17Z, because the brain was still inside its resume turn; the wake fired on the next idle, not ≤ 5 s |
| `approval_press` | not exercised | neither worker hit a permission prompt this run |
| Refused `task_adopt` reads REFUSED (F13) | not exercised live | the brain did not adopt this run (unit tests cover the block shape); it still repeated the phantom `ff51d7e` commit from its earlier summary, which is memory, not a tool result |
| Ledger transition contract (F14) | not exercised live | no `ledger_update` call this run; the description and error text are unit-tested |

## Findings (wave 3, second run)

15. **Worker first turn still dies on the operator's shell `ANTHROPIC_MODEL`** (third time): both workers answered "issue with the selected model (glm-5.3)" and needed `/model opus` + a re-instruction by hand. The fan-out launch should scrub `ANTHROPIC_MODEL` / `ANTHROPIC_*` from the worker pane's environment the same way the packaged app's launcher scrubs its own, or pass the role binding's model explicitly.
16. **The brain carries a false fact across turns.** "commit ff51d7e" (never created; both adopts were refused) reappeared in this run's `deck_complete_work` summary. F13's REFUSED block prevents the misread at the tool boundary; a claim already in the transcript is out of reach of that fix.

## What this proves (wave 3, second run)

Findings 7, 11 and 12 are closed on the packaged build: no per-task brain, the completion gate ignores human shells, and a pending decision neither hides nor loses delegated worker events. The owner-brain loop now runs unattended from fan-out to `deck_complete_work` once the operator's shell environment does not poison the workers (finding 15). Still not proven live: `approval_press`, the REFUSED adopt block, the ledger transition text, and the ≤ 5 s wake bound while the brain is idle.
