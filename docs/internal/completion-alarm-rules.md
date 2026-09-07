# Completion-alarm rules

> **Status:** Idea brief. No implementation in this note.
> **Scope:** When a pane may raise a "work finished" alarm. Status dots and
> fleet badges may stay looser; only the alarm is strict.
> **Out of scope:** Copying another product's code, process-table polling,
> or bringing back silence-based "task may have finished" toasts.

---

## Current situation

The alarm still means "a stop-shaped signal arrived," not "this pane's lead
turn actually ended."

That gap is the false-positive. Work is still running, and the user gets
told it is done.

What we already fixed:

- Byte-silence is no longer a completion toast. A quiet mid-turn tool call
  or a plain shell must not look finished.
- While a hook bridge is alive for an agent on a pane, that agent's screen
  heuristics must not raise a completion toast. Claude's status footer
  (`bypass permissions on`, `shift+tab to cycle`) is visible mid-turn.
- `SessionStart` is not a toast.
- `awaiting_input` is a different kind from turn-end.

What is still wrong:

1. **Vendor `Stop` is treated as done.** Claude fires `Stop` while
   background shells, monitors, or builds are still running. We map that
   hook straight to `Task finished`.
2. **There is no rebuttal window.** A `Stop` that is immediately followed
   by another tool still toasts. Some agents also emit milestone "done"
   while the turn continues.
3. **Pause is folded into complete.** Detector `waiting` and hook
   `complete` both become `agent.stop` and a "Ready for input" / "Task
   finished" toast. A visible idle footer is not a transition to idle.
4. **A child finishing toasts.** `SubagentStop` is an emit-kind
   (`Subagent finished`). The parent turn may still be working.
5. **First paint can look like a finish.** A pane that has never been
   seen `working` this turn — session attach, resume, tracking just
   enabled — can still raise a completion alarm from idle chrome.

The hook is the best *source*. It is not yet a *verdict*. Authority has
to sit on a normalized pane state, not on the raw event name.

---

## Direction

Do not import another codebase. Take five rules and sit them on the
existing hook bridge and `HookSignalRouter`.

### 1. Complete and pause are different events

| What actually happened | What the user should hear | Alarm |
|---|---|---|
| Lead turn ended | Work finished, ready for the next prompt | **Complete** |
| Approval, question, or permission | You need to answer | **Attention** (not complete) |
| Only a child agent ended | Parent is still working | **Internal** (no toast) |
| Session attached, resumed, or cleared | Nothing has been worked yet | **Ignore** |
| Screen went quiet for a few seconds | Unknown | **Ignore** |

The only input to a completion alarm is: **this pane's lead turn ended.**

### 2. A vendor hook is a claim, not a fact

Normalize every inbound signal before it can toast:

- `working` — still doing work
- `attention` — human input required (`waiting` / `blocked` / approval)
- `done-candidate` — lead turn looks finished, not yet confirmed
- `ignore` — session boundary, child-only stop, replay of the same turn

Normalization rules:

- If the hook payload still lists unfinished work (background shell,
  monitor, non-terminal task), that `Stop` is `working`, not done.
- If a child is still live, do not complete the parent.
- User interrupt may complete even if leftover work remains.
- Session start / resume / clear idle is `ignore`, never complete.

How we store the leftover-work list is our schema. The idea is the
one-step verdict: **raw `Stop` never reaches the alarm.**

### 3. Completion is provisional

A `done-candidate` opens a short confirm window (about 1.5s).

- `working`, a new tool start, or a new prompt inside the window
  **discards** the candidate.
- Attention inside the window also discards it. "Finished" and "answer
  me" must not fire together.
- Only a quiet window becomes a completion alarm.

This is not debounce. It is a chance to refute.

### 4. A completion alarm needs evidence

Refuse the alarm unless all of these hold:

1. This pane has evidence an agent actually ran.
2. This turn was seen `working`. Idle chrome at first paint is not a
   finish.
3. This turn has not already been announced.
4. If tracking was enabled mid-session, wait for a fresh `working`
   before any complete. The idle that was already on screen is not a
   new finish.

Screen or title may be a backstop only as a **transition**
(`working → idle`), never as "idle-looking chrome is visible."

### 5. Attention and complete cancel each other

- Attention arriving kills a provisional complete.
- A confirmed complete kills a provisional attention — especially a
  self-resolving approval that disappears on its own. Only an
  attention that is still open after a short window may notify.

Keep the status dot allowed to be looser. Only the alarm is strict.

Flow to implement against, without new product surface:

```
hook / detector / (later) title
        ↓
  normalize (working | attention | done-candidate | ignore)
        ↓
  turn gate (ran? seen working? already announced?)
        ↓
  provisional complete window (discard on rebuttal)
        ↓
  complete alarm  |  attention alarm  |  status only
```

Do **not** add process-table polling as a completion backstop. A
degraded scan reading the shell name looks like "the agent exited"
while it is still running. We do not have that path; do not create it.
Do **not** restore silence-based completion.

---

## Effect

These must stop raising a completion alarm:

- `Stop` while a background shell, build, or monitor is still running
- `SubagentStop` for a child while the parent turn continues
- Claude footer repainted mid-turn
- `Stop` immediately followed by the next tool
- Session-start or resume idle
- Idle already on screen when tracking is turned on
- An approval that auto-resolves

A completion alarm should fire only when:

- the lead turn ended,
- no leftover background work remains,
- the short window was not rebutted,
- and this turn was actually seen working.

User-visible result: the bell means you can look away and come back
to a finished pane, not to a job that is still running.
