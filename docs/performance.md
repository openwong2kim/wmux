# Performance

How wmux spends CPU and RAM, what background pane optimization changes, the
daemon knobs that actually exist, and how to diagnose a slow workspace switch
before filing an issue.

## Background pane optimization (hidden pane retention)

**On by default.** Panes hidden behind another workspace no longer parse and
render their output in the background. While a pane is hidden, its output is
retained instead of painted; the pane catches up when you reveal it.

This applies to **daemon-backed sessions only** (the default). Local-mode
panes are unaffected and keep rendering live.

You can turn it off in **Settings → Terminal** (the hidden-pane rendering
toggle). Turning it off is permanent — the one-time default migration never
re-flips a choice you made.

### What keeps running while a pane is hidden

Hiding a pane changes nothing about the processes behind it:

- **The PTY and whatever runs in it** (your shell, a Claude/Codex/Gemini
  agent) keep running at full speed. Hidden is not paused.
- **The daemon keeps capturing every output byte** into the session's ring
  buffer (`session.bufferSizeMb`, below). Output is never lost — only the
  on-screen parsing is deferred until reveal.
- **Agent reads stay correct.** `terminal_read` / pane search hydrate the
  pane from the retained data before answering.
- **Titles, status dots, and completion notifications** are daemon- and
  hook-driven, not derived from the on-screen terminal, so they keep updating
  for hidden panes.

### What to expect on reveal

- **Small backlog:** replayed directly on reveal — a brief catch-up, usually
  imperceptible.
- **Large backlog** (a busy agent hidden for a long time): the pane restores
  from the daemon's snapshot of the session instead of replaying every byte,
  bounded by your scrollback setting. The pane shows a **catching-up state**
  while this runs — content on screen is either current or visibly
  refreshing, never silently stale.
- **Many busy panes revealed at once** resync one at a time, so revealing a
  workspace full of long-hidden streaming panes takes proportionally longer
  than revealing one.
- **If a resync fails,** the pane stays in a visible stale/refreshing state
  and retries. A pane that repeatedly lands there is a bug — see
  [Filing a performance issue](#filing-a-performance-issue).

### When turning it off is reasonable

Turning the optimization off restores the old behavior: hidden panes parse
every byte as it arrives, and reveals are always instant. That trade is
reasonable if you flip constantly between a small number of workspaces and
care more about zero reveal catch-up than background CPU.

The cost of off is real and measured: one busy hidden pane costs roughly
**19% of the renderer's main thread** (measured 2026-07-16 on a live
instance). Two or three streaming agents you are not watching can consume
most of a core and make the pane you *are* watching feel heavy.

## Scrollback and RAM

Lowering **Settings → Terminal → Scrollback lines** is **not** an idle-RAM
fix. xterm.js allocates scrollback lazily — an idle pane with a 10,000-line
setting does not hold 10,000 lines of memory; the cost only materializes on
panes that actually produce that much output. A lower setting trims the
ceiling for high-output panes (and how much history a reveal restore can
rebuild), nothing else.

## Daemon knobs — `~/.wmux/config.json`

The daemon writes this file with defaults on first start. Values are
validated per field: an absent or non-numeric value falls back to its
default without resetting the rest of the file, and out-of-range values are
clamped to the bounds below — never treated as "off". (Exception: the core
`session` fields marked † are structurally validated; a wrong *type* there
resets the whole file to defaults.)

| Field | Default | Bounds | What it does |
|---|---|---|---|
| `daemon.idleShutdownMinutes` | `5` | `0` = never | Minutes with zero clients **and** zero sessions before the daemon exits on its own. |
| `daemon.memWarnMb` | `500` | 128 – physical RAM | Daemon RSS above this logs a warning. |
| `daemon.memReapMb` | `750` | 192 – physical RAM, ≥ warn | RSS above this garbage-collects dead-session tombstones early (frees their buffers). |
| `daemon.memBlockMb` | `1024` | 256 – physical RAM, ≥ reap | RSS above this refuses **new** sessions. The ladder never evicts a live session. |
| `session.bufferSizeMb` † | `8` | ≤ min(`bufferMaxMb`, 256) | Per-session output ring buffer the daemon captures — the source for scrollback restore and hidden-pane catch-up. |
| `session.bufferMaxMb` † | `64` | hard cap 256 | Ceiling for `bufferSizeMb`. |
| `session.deadSessionTtlHours` † | `24` | — | How long a dead (exited) session and its buffer are kept before reaping. Stamped per session at creation; changing it affects new sessions only. |
| `session.maxSessions` | `200` | 1 – 10,000 | Ceiling on concurrent daemon sessions. At the ceiling, creation is refused — existing sessions are never evicted. |
| `session.suspendedTtlHours` | `168` (7 days) | 1 – 8,760 | TTL after which an idle suspended-session tombstone is garbage-collected. |

Changes apply the next time the daemon starts. Since the daemon outlives the
app by design, fully quit wmux (tray → **Shut down wmux**) and relaunch —
closing the window is not enough, and a dev rebuild does not replace a
running daemon.

## Diagnosing a slow workspace switch

Every reveal of a hidden pane logs one line, prefixed `[wmux:reveal]`, with
a mechanism code saying which path the reveal took:

| Code | Meaning |
|---|---|
| `live` | The pane was rendering live (optimization off, or a local pane). Nothing to catch up. |
| `retained-catchup` | Small retained backlog replayed directly. The normal, fast path. |
| `dirty-snapshot` | Backlog was too large to replay; restored from a daemon snapshot. Expected for a long-hidden busy pane. |
| `dirty-raw-fallback` | Snapshot path unavailable; fell back to replaying the raw buffered bytes. Slower — occasional is fine, constant is not. |
| `resync-degraded` | The resync failed; the pane is marked stale and will retry. Repeated occurrences are a bug. |
| `dead-snapshot` | The session's process has exited; the pane painted its last serialized screen. Normal for dead panes. |

These lines are persisted to the on-disk logs (not just the DevTools
console): the daemon log lives at `~/.wmux/logs/daemon-YYYY-MM-DD.log`, and
`wmux doctor` prints the exact path of both the main and daemon logs for
your install.

`wmux doctor` also checks daemon liveness, boot phases, and recent log
errors in one shot; `wmux doctor --performance` adds the retention state,
hidden/retained/dirty pane counts, snapshot queue depth, the last switch's
mechanism and timing, and 5-minute counters (overflows, resyncs, failures).

## Filing a performance issue

A report with evidence gets fixed much faster. Attach:

1. **`wmux doctor --performance` output** (`--json` if you prefer).
2. **The `[wmux:reveal]` lines** around the slow switch, from that day's log.
3. **Scale:** how many workspaces and panes, how many were running agents,
   and whether the optimization was on or off.
4. **Version and reproducibility:** the wmux version, and whether it still
   reproduces after a full quit and relaunch. (The first minutes after a
   release update include one-time daemon replacement and reconciliation —
   a lag that self-resolves right after updating is usually that, not a
   regression.)
