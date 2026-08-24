Closes the last direction of #935 — #939 and #965 closed the other two.

## The bug

`onIdle` (daemon mode) / `onActiveToIdle` (local mode) is the only thing that clears a stale `running` back to `idle` when a pane goes quiet with no precise event to explain it. It defers to a precise `waiting`/`complete` status set in the last `AGENT_EVENT_SUPPRESSION_MS` (10s), on the assumption that status is still correct and the clear would just be redundant.

But `onActive` broadcasts `running` unconditionally on any burst over the byte threshold — no deference to a recent precise status at all. So the sequence that wedges a pane is:

1. Turn ends, Stop hook fires, `agentStatus: 'complete'` — correct.
2. A short burst inside the 10s window (a final chrome repaint, a keystroke echo — not a new turn) fires `onActive`, which overwrites `complete` with `running`.
3. 5s later `onActiveToIdle`/`onIdle` should clear `running` → `idle`, but it's still inside the 10s window from step 1, so it defers — to a status that no longer exists.
4. `ActivityMonitor` already consumed its active→idle transition, and a quiet pane never bursts again, so nothing ever retries the clear. `running` is now permanent.

Same shape, same constant, in both `PTYBridge.ts` (local mode) and `DaemonNotificationRouter.ts` (daemon mode, the packaged build's path) — the wedge isn't specific to either.

(This is the case the maintainer named directly in #965's "Known limits": *"the clearing idle can still be swallowed if a lifecycle event lands between the promotion and the idle... the general one belongs in the router."*)

## The fix

Track the last `agentStatus` actually broadcast per PTY (`lastBroadcastStatus`). The suppression window now only applies while that tracked status is still the precise one — once it's `running` (meaning a burst already clobbered whatever was there), there's nothing left to defer to, and the clear goes through regardless of the window.

A withheld status (hook-governed pane, `#935` direction 1's veto) does not update the tracker — nothing landed that a later clear would need to defer to.

No change to `ActivityMonitor`, the terminal-wins ordering rule, or the resize/typing guards — this is scoped entirely to the suppression check in the notification layer, as the maintainer's own note suggested.

## Test plan

- New regression test in both modes: precise `complete` → burst re-fires `running` inside the suppression window → byte silence must still clear to `idle`. Verified both fail on the pre-fix code (reverted the fix locally, confirmed red) and pass with it.
  - `src/main/pty/__tests__/PTYBridge.staleRunning.test.ts` (new file, local mode)
  - `src/main/notification/__tests__/DaemonNotificationRouter.statusClear.test.ts` (added case, daemon mode)
- Existing #733 protection (`defers to a recent precise agent status instead of overwriting it`) still passes unchanged — a precise status that was never clobbered still gets deference.
- Full suite: `npm run test:parallel` — 11,509 passing, 9 pre-existing failures unrelated to this change (timing races in `deck.handler.loop.test.ts`, a git-checkout timeout in `worktree.handler.test.ts`, one `state.fallback.test.ts` case) — none touch `PTYBridge`, `DaemonNotificationRouter`, or anything in this diff.
- `tsc --noEmit` clean.

## Stability tier impact

None — no new public API, no change to `AgentStatus`, no schema/RPC shape change. Purely internal bookkeeping in the notification layer.
