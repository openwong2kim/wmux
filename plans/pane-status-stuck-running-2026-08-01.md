# Pane status stuck at `running`, and the destructive escape from it (2026-08-01)

- Status: **design, pre-review**. Tracking issue: #733.
- Scope: `src/main/notification/idleSuppression.ts`, `DaemonNotificationRouter.onIdle`,
  `PTYBridge.onActiveToIdle`, `src/main/deck/deckWorkStore.ts`, `stopGate.ts`,
  and the turn-contract text shipped by #703.
- Root cause confirmed empirically (instrumented dev build, daemon mode, Windows).
  Evidence and repro are in #733; this document only decides what to change.

## 0. What we are fixing

Three defects that compound into one incident: a pane that finished its command
keeps reporting `running`, the Stop gate therefore refuses to end the turn, and
the brain escapes by killing the pane.

They are separable and should be judged separately. F1 is the bug. F2 is what
makes it recur after a restart. F3 is what turns a status bug into data loss.

## 1. F1 — the status clear must not be gated by the notification suppressor

### What is wrong

`recentlySuppressed()` was written to suppress a **toast** ("Task may have
finished") after a resize redraw or a burst of typing. That toast was later
deleted; the comments in both handlers say so. The guard was never narrowed, so
it now sits in front of the only surviving job: clearing `running` to `idle`.

Two properties make a suppressed clear permanent rather than late:

- `ActivityMonitor` mutates its state before invoking callbacks, so the
  transition is consumed even when the callback is dropped. Nothing retries.
- For a plain shell `AgentDetector` never matches, so no `session:agent` ever
  arrives. `session:idle` is the only path that can clear the status.

### The decisive argument

`onActive` is **not** gated by `recentlySuppressed`, but `onIdle` is. A resize
redraw is several KB, so it raises a false `running`, and then the guard blocks
the clear that would have corrected it. The guard makes the exact case it was
named for worse, not better. Either both edges are gated or neither is, and
gating neither is the one that keeps the status honest.

### Change

Drop the `recentlySuppressed()` call from both status-clear paths. That leaves
the function with no callers, and `markUserWrite` / `lastUserWriteAt` exist only
to feed it, so all three are removed. `markResize` stays: `recentlyResized()`
(3 s window, AgentDetector dedup reset) is a separate concern and keeps its
caller.

Agent panes do not lose protection. They are covered twice already, by
`explicitTerminalStatus` inside `DaemonPTYBridge.onActiveToIdle` and by
`AGENT_EVENT_SUPPRESSION_MS` in main. Neither is touched.

Callers verified before writing this: `recentlySuppressed` has exactly the two
production call sites named above, and `markUserWrite`'s two call sites in
`pty.handler` exist only to feed it. One test blocks the removal —
`pty.handler.oversize-segment.test.ts` asserts on the **source text** containing
`markUserWrite(id)`, to prove the call was not hoisted out of the segmentation
loop. That test's subject disappears with the function, so it is deleted rather
than rewritten; the behaviour it guarded (per-write suppression bookkeeping) no
longer exists to guard.

### Deliberately not doing

Making `ActivityMonitor` re-fire a dropped idle. The convergence hole is real —
any future dropped callback wedges a pane the same way — but with the only
dropper removed there is nothing left to converge from, and adding a retry timer
to a hot path to defend against a caller that no longer exists is the wrong
trade. Flagged for review as a judgement call, not silently skipped.

## 2. F2 — active work must expire and must not auto-wake forever

### What is wrong

`deck-work.json` kept the record from a finished one-liner across an Escape
interrupt, a force-kill and a full restart. On the next boot the orchestrator
auto-woke on it with a fresh `wake-budget: 12/12`.

`stopGate` blocks on `activeWork` alone, independent of the pane snapshot, and
`ClaudePtyBrainAdapter` resets `consecutiveStopBlocks` to 0 on every turn that is
allowed to end. So each wake buys three more refusals: twelve wakes is up to
thirty-six refusals for work that finished in milliseconds.

### Options for review

- **(a) Wake budget keyed to the work record, not the session.** The budget stops
  resetting across restarts, so a wedged record burns down and stops.
  Smallest change, does not need a policy call about what "stale" means.
- **(b) Clear active work on interrupt.** Escape / new-session / brain replacement
  finalizes or drops the record. Matches intent: the human stopped it.
- **(c) Staleness on load.** A record older than some threshold does not auto-wake;
  it surfaces to the human instead. Needs a threshold nobody can justify yet, and
  a genuinely long task would trip it.

Recommendation: **(a) + (b)**. (a) bounds the damage of any wedged record whatever
its cause; (b) fixes the specific way this one got wedged. (c) is deferred — the
threshold is unjustifiable without data, and (a) already bounds the blast radius.

## 3. F3 — a status number is not something to fix by killing the pane

### What is wrong

The Stop gate's refusal text says to "read its screen, answer what it is waiting
on, or delegate the next step". Nothing rules out killing the pane. The brain
escalated to `exit`, then Ctrl+D, on a live user shell.

The gate itself worked: it failed open after three refusals as designed. The
damage happened inside those three. This is independent of F1 and F2 — pane
status will be wrong again some day, and the brain must not reach for `exit` when
it is.

### Change

Name the prohibition where the brain actually reads it: the Stop-gate refusal
string and the turn contract from #703. A pane's reported status is not a thing
to resolve by ending the pane — no `exit`, no Ctrl+D, no kill to make a number
change. When a pane cannot be resolved, hand it to a human with
`deck_ask_decision` and leave the work active.

### Also a narrow tool guard (review decision, 2026-08-01)

Prose alone was judged too weak for a path that has already destroyed user data
once. The brain is a separate `claude` process; if it ignores the sentence,
nothing stops it. Blocking session-terminating input outright is still wrong — an
orchestrator legitimately needs to close shells — so the guard is conditioned on
the state this incident was actually in.

Refuse session-terminating input (`exit`, Ctrl+D) when **both** hold: the caller's
workspace is currently held by the Stop gate, and the target pane is one of the
panes the gate named as outstanding. Return the reason rather than failing
silently, so the brain learns why instead of retrying. Everything outside that
intersection is unaffected: a normal `exit` from an unblocked orchestrator still
works.

`consecutiveStopBlocks` and the gate's outstanding-pane list already live in main,
so the condition is readable at the tool boundary without new plumbing. The cost
is carrying that state down to the input RPC, which is the reason this was
originally deferred; the review judged the blast radius worth the wiring.

## 4. Tests

### The reason the suite missed this (review finding, confidence 9/10)

Four test files mock the function that carries the bug:

```
src/main/notification/__tests__/DaemonNotificationRouter.lifecycle.test.ts:40
  recentlySuppressed: vi.fn().mockReturnValue(false),
```

Same line in `DaemonNotificationRouter.nudgeExhausted.test.ts:35`,
`DaemonNotificationRouter.supervision.test.ts:29`, and
`a2a.channel.rpc.test.ts:64`. Suppression never happens in the test world, so the
branch that wedges a pane was never executed by any of the 9251 unit tests. That
is the whole answer to "how did this survive a green suite".

**A regression test that mocks `recentlySuppressed` would repeat that blindness.**
The F1 test therefore uses the real module: call `markResize(ptyId)` directly,
then drive `session:idle`, then assert the `agentStatus: 'idle'` broadcast still
goes out. Reset module state with `clearPty(ptyId)` in teardown, since the maps
are module-global.

The four dead mock lines are removed with the function.

### Coverage

```
F1 — status clear
  DaemonNotificationRouter.onIdle
    ├── [NEW ★★★] real markResize inside the old window -> still clears   <- the wedge
    ├── [NEW ★★ ] no resize, no write -> clears (unchanged behaviour)
    ├── [KEEP ★★] recent agent event -> AGENT_EVENT_SUPPRESSION_MS still suppresses
    └── [KEEP ★★] daemon explicitTerminalStatus -> daemon never emits idle
  PTYBridge.onActiveToIdle
    └── [NEW ★★ ] local-mode twin of the wedge case

F3 — destructive-resolution guard
  Stop gate refusal string
    └── [NEW ★★ ] carries the prohibition (asserted on the string the model receives)
  input RPC guard
    ├── [NEW ★★★] gate-blocked + target is an outstanding pane -> refused with reason
    ├── [NEW ★★ ] gate-blocked + target is some other pane     -> allowed
    └── [NEW ★★ ] not gate-blocked                             -> allowed
```

## 5. Verification

Unit tests are not enough on their own — this bug survived a full green suite for
exactly the reason above. The landing gate is the live repro from #733 against a
dev build: resize a plain shell pane, run a short command inside the window, and
watch the status settle to `idle` by itself. Then the original orchestrator
instruction end to end, with the turn finishing and nothing killed.

## 6. NOT in scope

- **F2 (active-work expiry).** Split to a follow-up PR by review decision — it
  carries a policy question (what counts as stale) that should not hold up F1.
  Until it lands, an old `deck-work.json` record can still drive auto-wakes.
  Note for that PR: `autoWakesUsed` lives in `CommanderEventCoalescer` memory and
  resets on construction, which is why a restart handed the wedged record a fresh
  12/12 budget. Keying the budget to the record means persisting it.
- **The false `running` a resize redraw raises.** A TUI repaint is several KB, so
  it trips `onActive` and flashes `running` for ~5 s. Pre-existing, not introduced
  here, and after F1 it self-heals instead of sticking. Left alone.
- **`ActivityMonitor` retry-on-dropped-callback.** See section 1.
- **The `saveAsync` storm** (277 writes in three minutes). It is a symptom of the
  re-check loop, so F1 and F2 shrink it; coalescing is separate work.

## 7. What already exists

- `recentlyResized()` (3 s) already separates "was this burst a repaint?" from the
  30 s notification suppressor. It keeps its caller and is untouched — the fix
  narrows to the suppressor that lost its purpose.
- The daemon already refuses to emit idle once a hook or detector settled the turn
  (`explicitTerminalStatus`), and main already defers to a recent precise status
  (`AGENT_EVENT_SUPPRESSION_MS`). Agent panes are covered without new code; F1
  only restores the plain-shell path.
- `consecutiveStopBlocks` and the gate's outstanding-pane list already exist in
  main, so the F3 guard reads state rather than computing it.
- `clearPty()` already exists for per-pane teardown and is what the new test uses
  to isolate module-global state.

## 8. Also folded in from review

- Rewrite the `idleSuppression.ts` module docblock. It still describes the deleted
  "Task may have finished" toast as the module's purpose, which is the exact
  misdirection that let this bug live. A module whose header lies is how the next
  reader repeats the mistake.

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | — | — |
| Codex Review | `/codex review` | Independent 2nd opinion | 0 | — | — |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | CLEAR | 2 issues, 0 critical gaps |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | — | — |
| DX Review | `/plan-devex-review` | Developer experience gaps | 0 | — | — |

- **VERDICT:** ENG CLEARED — ready to implement F1 + F3. F2 split to a follow-up PR.

NO UNRESOLVED DECISIONS
