# Replay a browser flow

An agent that repeats the same web flow — log in, filter a report, export a
CSV — pays for it again every time: one accessibility snapshot per step, plus
the reasoning to pick the right element out of it. `browser_replay` records a
flow that worked and repeats it later without reading a single snapshot.

The snapshot is the cost being removed. A replay does take snapshots
internally, to re-resolve the elements; none of them are returned.

## Requires the chrome backend

Flows are keyed on what the accessibility snapshot calls each element. The
builtin webview can fall back to a DOM snapshot that mints no accessibility
refs at all — a flow recorded then is saved with every step marked
unreplayable, so it will never run. Set the workspace's browser backend to
`chrome` before recording.

## Record

There is no "start recording". Every successful action from the ten
replayable tools (`browser_navigate`, `browser_click`, `browser_type`,
`browser_fill`, `browser_press_key`, `browser_hover`, `browser_drag`,
`browser_select`, `browser_scroll_into_view`, `browser_scroll`) already goes
into a 40-slot ring on your connection. When a flow works, name it:

```json
{ "action": "save", "name": "weekly-export" }
```

By default this keeps everything since your last `browser_navigate`, on the
surface you are saving from. Pass `steps: N` to keep exactly your last N
actions instead. A cut longer than 30 steps is refused rather than trimmed —
a flow saved from its middle would replay from the middle and report success.

Saving the same name again re-records the flow. If the steps are the same, it
keeps the name's success history and lifts any quarantine, because you are
asserting these steps are still the current path. If the steps changed, the
history starts over: the old flow's successes say nothing about the new one.

## Replay

```json
{ "action": "run", "name": "weekly-export" }
```

A flow only runs on the page it was recorded on, unless its first step is a
`browser_navigate` — elsewhere its stored elements would match whatever
happens to share their role and name.

Elements are re-found by what the snapshot called them — role, accessible
name, and position among the same-named elements in the same frame — not by a
DOM path. A page that was restructured, or whose refs were renumbered by a
restart, still replays as long as the button still reads as the same button.

## When a replay stops

A step whose element is gone stops the run at that step and reports which
step, why, and how the page's shape compares to the recording. The page is
left exactly where the replay stopped, so the cheapest recovery is to take a
snapshot, finish the flow by hand from there, and `save` under the same name.
That re-records the healed path.

A changed count of same-named elements also stops the run, at every position
including the first. Position N names the recorded element only while that
population is the one that was counted: an element inserted anywhere — above
the first one included — moves something else into that slot, and the replay
would act on it. Take a snapshot and finish the flow live instead.

## Variables

A value that should vary between runs is stored as a placeholder:

```json
{ "action": "save", "name": "search", "steps": 2 }
```

then edit nothing — instead type `{{query}}` when performing the flow, and
supply it at run time:

```json
{ "action": "run", "name": "search", "variables": { "query": "invoices" } }
```

A placeholder with no supplied value stops the run rather than typing
`{{query}}` into the field.

## Passwords

A `browser_type` into a password field is recorded as a marked hole. The value
is never captured, so it cannot reach the trace, the store, or the cache file.
A flow containing one is listed but refuses to run — perform it live.

The same applies to `browser_fill`, which fills a whole form at once: its
credential fields are holes and its ordinary fields are not.

Three other things become the same kind of hole: an action that fell back to
the RPC transport (which resolves elements by attribute and mints nothing to
re-resolve against), an argument too long to store intact, and a URL that
carried a credential (in `user:pass@host` or a password-family query
parameter) — the secret is stripped, which necessarily changes the URL.

Coordinate clicks (`browser_click` with `x`/`y`) are not recorded at all. A
coordinate does not survive a re-render.

## Listing and forgetting

```json
{ "action": "list" }
{ "action": "forget", "name": "weekly-export" }
```

`list` marks each flow as *proven* (it has run successfully and fails less
often than it succeeds), *unproven*, *quarantined* (the same step failed twice
in a row), or *not runnable*. Only proven flows are volunteered: after a
navigation, a one-line `[replay]` note names the flows recorded for the page
you landed on.

## Where flows live

`~/.wmux/browser-action-cache.json`, keyed by workspace and written by the
wmux app rather than the MCP process — so a flow survives your session ending,
which is exactly when it starts being worth having. One workspace can never
read another's flows.

Bounds: 40 flows per workspace (least recently used lose), 30 steps per flow,
512 bytes per argument, and a 30-day idle expiry. The cache is an
optimization; losing an entry costs you a replay and nothing else.

## Keeping a flow permanently: promote

A recorded flow is a cache entry. It expires after 30 idle days, it can be
pushed out by the 40-flow cap, and nothing tells you it exists unless you call
`list`. For the handful of flows you actually repeat, promote them:

```json
{ "action": "promote", "name": "weekly-export" }
{ "action": "demote",  "name": "weekly-export" }
```

Promotion buys two things.

**It is permanent.** A promoted flow carries its own copy of the steps, so it
keeps working after the 30-day recording has expired. `run` falls back to that
copy automatically and tells you it did. (A restored run does not re-create the
recording — `save` it again if you want one.)

**It is offered to you.** When a navigation lands on a promoted flow's page,
the result carries a `[skill]` line naming the flow and the exact call that
runs it, so you can use it without calling `list` first. This is the real
difference: an ordinary recorded flow has to be remembered, a promoted one
arrives when it is relevant.

### What promotion requires

A flow must have succeeded **at least three times**, must not be quarantined,
and must contain no unreplayable step. The threshold is deliberately higher
than the one for the `[replay]` hint: that hint costs you one attempt, while a
promoted flow is permanent and volunteered on every landing.

A refusal names the shortfall (`2 successful run(s) and promotion needs 3`), so
running the flow once more is usually the whole fix.

### What promotion makes permanent

Promoting is an explicit act with an explicit consequence: the flow's recorded
steps, **including the values that were typed**, are stored in plain text and
kept indefinitely — well past the 30 days the recording itself would have
lasted.

Password fields are not affected: they were never captured, and a flow
containing one cannot be promoted because it cannot run. But nothing else is
special-cased. An API token, an account number, or an internal URL typed into
an ordinary field is in the steps and stays there.

Variable-ise anything sensitive before promoting: re-perform the flow with the
value supplied as a `{{placeholder}}`, save it again, and promote that. The
flow then stores the placeholder and takes the value at run time.

### Lifecycle

A promoted flow that goes **30 days without a run** is moved to
`~/.wmux/promoted-archive/`, out of the live tree, and is no longer offered.
After **90 days** a later sweep deletes it from there. Nothing is ever deleted
straight out of the live tree — every flow gets a stop in the archive first,
where you can still recover it by hand. Any run — successful or not — resets the
clock, because a flow you keep reaching for and that keeps failing is one you
still want, and its failures are the signal to re-record it.

Demoting does not touch the recording in the 30-day cache; it only stops the
flow being kept permanently and offered on landing.

### Where promoted flows live

`~/.wmux/promoted-skills/<workspace>/<name>.json`, one file per flow, written
by the wmux app. One workspace can never see or demote another's. To clear one
out by hand, delete its file — the next sweep tidies up whatever is left.

A file this version of wmux cannot read is moved to the archive rather than
deleted. One exception: a file written by a *newer* wmux is left strictly
alone, so running an older build once never destroys flows the newer one
wrote.

Promoting the same flow again is fine and keeps its usage history. Promoting a
*different* flow whose name shortens to one already in use is refused, so a
promotion can never quietly replace a proven flow you did not mean to touch.
