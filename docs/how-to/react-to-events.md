# How to react to wmux events

> **Goal:** run a poll loop that reacts to pane/process/agent lifecycle events
> in near-real-time, without losing events or busy-spinning the rate limiter.

Assumes you can already [connect to wmux](./connect-to-wmux.md). The event-bus
contract is [`PROTOCOL.md` §2](../PROTOCOL.md#2-event-bus-contract); this recipe
is the working loop.

## Background

The event bus is **pull, not push**. You call `events.poll(cursor)` and the
daemon returns every event with `seq > cursor`. It is an in-memory ring of
`1024` events (`RING_CAPACITY`), and one poll returns at most `256` events
(`POLL_DEFAULT_MAX`) unless you pass a larger `max` (capped at the ring size).
There are exactly **eight** event types (`WmuxEventType` in
`src/shared/events.ts`):

| Type | Key fields (beyond `seq`, `ts`, `workspaceId`, `type`) |
|---|---|
| `pane.created` | `paneId`, `parentBranchId?` |
| `pane.closed` | `paneId` |
| `pane.focused` | `paneId`, `previousPaneId?` |
| `pane.metadata.changed` | `paneId`, `metadata`, `version?` |
| `workspace.metadata.changed` | `metadata`, `patch` |
| `process.started` | `ptyId`, `pid?`, `shell` |
| `process.exited` | `ptyId`, `exitCode`, `signal?` |
| `agent.lifecycle` | `ptyId`, `kind`, `source`, `agent`, `decision`, `exitCode?` |

`agent.lifecycle` carries **`ptyId`, not `paneId`**: its `kind` is one of
`agent.stop` / `agent.subagent_stop` / `agent.awaiting_input` /
`agent.stop_failure`; its `source` is `hook` / `detector` / `osc133`; `agent`
is a slug (`claude`, `codex`, …) or `null` for `osc133` shell commands.

`agent.stop_failure` is a turn that ENDED on an API error — a turn boundary
like `agent.stop`, but nothing finished. It is never collapsed into
`agent.stop`: an orchestrator waiting on the pane must retry or escalate, not
be told the work is done.

## Steps

1. **Bootstrap with `cursor: 0`.** That means "replay from the oldest event
   still in the ring." On the first poll, record the returned `bootId`.

2. **Treat `nextCursor` as opaque.** Pass back exactly what the previous poll
   returned. Never increment it, compare it, or persist it across daemon
   restarts. It happens to be an integer today; that is not a contract.

3. **Filter server-side when you can.** Pass `types?: WmuxEventType[]` and/or
   `workspaceId?: string`. Filtering on the server keeps your pages small and
   advances the cursor past unmatched events so you do not rescan them. Over the
   raw pipe there is **no per-caller visibility scoping**: omitting `workspaceId`
   returns events for **all** workspaces currently in the ring. Pass
   `workspaceId` to isolate a single workspace; omit it (and `types`) only when
   you genuinely want every event across every workspace.

4. **Process the page, then poll again from `nextCursor`.** Handle each event
   in `result.events`, then loop. Sleep between polls — you do not need to poll
   faster than your reaction latency requires.

5. **Watch for `bootId` change every poll.** If `result.bootId` differs from the
   value you recorded, the daemon restarted: every cached id and cursor is
   invalid. Drop all caches and re-bootstrap — see
   [handle-daemon-restart](./handle-daemon-restart.md).

6. **Watch for `resync: true` and `droppedCount`.** If your cursor drifted past
   the ring window (you polled too slowly during a burst), the response carries
   `resync: true` and, when the drift is past the window, a `droppedCount`. The
   bus already advanced your effective cursor to the oldest surviving event, so
   the reply still **delivers** that oldest page — process it (you will not
   double-process), then: a state-cache consumer reconciles via `pane.list` and
   resumes from its `asOfSeq`; an append-only consumer just continues from
   `nextCursor` so only the `droppedCount` events are lost. See
   [handle-daemon-restart](./handle-daemon-restart.md).

## Code

```js
import { connect } from './wmux-rpc.mjs';

const client = await connect(); // async — resolves to a WmuxClient
let cursor = 0;
let lastBootId = null;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

for (;;) {
  const res = await client.rpc('events.poll', {
    cursor,
    types: ['pane.created', 'process.started', 'agent.lifecycle'], // omit for all 8
    max: 256,
  });

  if (lastBootId && res.bootId !== lastBootId) {
    // Daemon restarted — see handle-daemon-restart.md
    cursor = 0;
    lastBootId = res.bootId;
    continue;
  }
  lastBootId = res.bootId;

  if (res.resync) {
    // Drifted past the ring (droppedCount may be set) — reconcile via pane.list
    // and resume from asOfSeq. See handle-daemon-restart.md.
  }

  for (const ev of res.events) {
    switch (ev.type) {
      case 'pane.created':     console.log('pane', ev.paneId, 'created'); break;
      case 'process.started':  console.log('pty', ev.ptyId, 'started', ev.shell); break;
      case 'agent.lifecycle':  console.log('agent', ev.agent, ev.kind, 'on pty', ev.ptyId); break;
    }
  }

  cursor = res.nextCursor; // opaque — pass back verbatim
  await sleep(1000);       // stay well under 50 rpc/s
}
```

## Pitfalls

- **The ring holds 1024 events.** A burst beyond what you drain between polls
  silently rolls off. If you must not miss events, poll often enough that your
  page never approaches `max`, or rely on `resync` + `pane.list` reconciliation
  to recover state. Use `droppedCount` to detect that you fell behind.
- **`agent.lifecycle` is keyed by `ptyId`, not `paneId`.** To map a `ptyId` to a
  pane, call `pane.list` once and cache. The daemon does not resolve it for you
  on the event.
- **`decision: 'dedup'` events still arrive.** The lifecycle event is published
  regardless of whether wmux fired a user-facing notification. Filter on
  `ev.decision === 'emit'` if you only want first-of-kind signals. (`osc133`
  events are always `emit`.)
- **Cross-producer ordering is arrival order, not causal order.** A same-tick
  `pane.created` and `process.started` can land in either order. Use `ts` when
  you need to reason across producers — see `PROTOCOL.md` §2.7.
- **Rate limits are per second.** 50 RPC/s per socket, 200/s global. A tight
  poll loop with no sleep will hit them. One poll per second per consumer is
  more than enough for human-paced workflows.
- **Filtering still advances the cursor.** A poll filtered to `process.exited`
  on a busy bus does not rescan the events it skipped — the cursor moves past
  scanned events, matched or not.

## See also

- [`PROTOCOL.md` §2](../PROTOCOL.md#2-event-bus-contract) — full polling model, cursor opacity, ordering caveat.
- [Handle a daemon restart](./handle-daemon-restart.md) — `bootId` vs `resync`, the reconciliation recipe.
- [`examples/event-recorder/recorder.mjs`](../../examples/event-recorder/recorder.mjs) — a complete, runnable poll loop.
