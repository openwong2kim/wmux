# Replay a browser flow

An agent that repeats the same web flow — log in, filter a report, export a
CSV — pays for it again every time: one accessibility snapshot per step, plus
the reasoning to pick the right element out of it. `browser_replay` records a
flow that worked and repeats it later without reading a single snapshot.

The snapshot is the cost being removed. A replay does take snapshots
internally, to re-resolve the elements; none of them are returned.

## Record

There is no "start recording". Every successful action from the ten
replayable tools (`browser_navigate`, `browser_click`, `browser_type`,
`browser_fill`, `browser_press_key`, `browser_hover`, `browser_drag`,
`browser_select`, `browser_scroll_into_view`, `browser_scroll`) already goes
into a 40-slot ring on your connection. When a flow works, name it:

```json
{ "action": "save", "name": "weekly-export" }
```

By default this keeps everything since your last `browser_navigate`. Pass
`steps: N` to keep exactly your last N actions instead.

Saving the same name again re-records the flow. It keeps the name's success
history and lifts any quarantine, because you are asserting that these steps
are now the current path.

## Replay

```json
{ "action": "run", "name": "weekly-export" }
```

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

A step whose same-name population merely changed size (a third "Delete" button
appeared) is a warning, not a stop.

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

Two other things become the same kind of hole: an action that fell back to the
RPC transport (which resolves elements by attribute and mints nothing to
re-resolve against), and an argument too long to store intact.

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
