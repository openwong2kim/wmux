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
