# Substrate Performance Characterization

> **Status:** Phase 1 characterization. Resolves the open profiling TODO in [`m0-design.md`](./m0-design.md) §8 Q5 and supplies issue #15 the missing honest perf numbers.
> **Bench harness:** [`scripts/substrate-bench.mjs`](../../scripts/substrate-bench.mjs).
> **Companion docs:** [`../PROTOCOL.md`](../PROTOCOL.md) §2 (event bus contract) and §3 (snapshot envelope), [`m0-design.md`](./m0-design.md) §8 (open questions).

---

## 1. Purpose

Two gaps motivated this characterization:

1. **`m0-design.md` §8 Q5 is open.** It asks:
   > `MetadataStore.snapshot()` performance under high write load: 1000 writes/sec for 60 seconds, then a `snapshot()` mid-burst — does it block the main process noticeably? If yes, the snapshot needs to be copy-on-write or use a different read pattern. Profile in M0-c.

   M0-c shipped the snapshot integration (`pane.list` returns the `{ asOfSeq, bootId, panes }` envelope) but the profiling note was never closed. This doc closes it.

2. **Issue #15 lacks honest perf numbers.** "Build a plugin/dashboard/orchestrator on top of wmux" needs concrete answers to: how fast can I write metadata, how fast can I poll events, at what backlog does the event ring drop, and does taking a snapshot stall the daemon. These are the questions a substrate consumer asks before trusting it under load.

The bench measures the substrate **end to end over the Named Pipe against the packaged production app** — the same path an external plugin uses — not the in-memory store in isolation. The numbers therefore reflect what a plugin actually observes, IPC and rate limiter included.

---

## 2. Methodology

### 2.1 Harness

`scripts/substrate-bench.mjs` reuses the isolation model from `scripts/m0-dynamic-verify.mjs`:

- Spawns `out/wmux-win32-x64/wmux.exe` with a temp `USERPROFILE`/`HOME`/`APPDATA`/`LOCALAPPDATA`, so `.wmux/`, the auth token, the pid-map, and the tcp-port file are sandboxed. `WMUX_DISABLE_CDP=true` keeps the browser engine out of the measurement.
- The win32 pipe name is shared per Windows account (`\\.\pipe\wmux-<username>`), so the bench pre-flights `pipeAlive()` and **aborts** if a real wmux daemon is already on it — two daemons collide on the single per-user pipe.
- Reads the token from `<TEST_HOME>/.wmux-auth-token` once the app writes it, then talks raw newline-delimited JSON-RPC over the pipe.
- **No `clientName`.** The request is recorded as `legacy` by `RpcRouter` and grandfathered, so the bench runs against the production **enforce-mode** app without tripping an approval dialog (the same reason `m0-dynamic-verify.mjs` works against the packaged build — see `RpcRouter.dispatch`). **This stops working when #1111 closes the legacy lane (first release on or after 2026-09-30)** — the bench must migrate to a `clientName` (e.g. the `wmux-cli` curated lane) before then.
- Cleanup is SIGTERM then SIGKILL, awaited before exit so the temp HOME is removed.

Unlike the one-shot `rpc()` in the verification scripts, the bench keeps **long-lived sockets** (a small `PipeClient` that buffers on `\n` and correlates by request `id`) so it can issue many RPCs without paying a connect per call or tripping `MAX_NEW_CONNECTIONS_PER_SEC = 30`.

### 2.2 What is measured

| Scenario | Primitive | Measures |
|---|---|---|
| **B1** | `pane.setMetadata` | Sustained write throughput (writes/sec), per-write latency p50/p95/p99, and whether the echoed `version` stayed monotonic. |
| **B2** | `events.poll` | Round-trip latency p50/p95 at page sizes `max` ∈ {1, 32, 256, 1024} against a ring already loaded by B1. |
| **B3** | `pane.setMetadata` → `events.poll` | The real ring-overflow point: drive > `RING_CAPACITY` (1024) events between two polls, find the backlog at which `droppedCount` first appears, confirm `resync: true` + `droppedCount > 0`, and confirm recovery via `pane.list`. |
| **B4** | `pane.list` | Snapshot latency idle vs. mid-burst — the direct answer to §8 Q5. A background writer drives `pane.setMetadata` on one socket while a separate socket times `pane.list`; if `snapshot()` blocked the main process, mid-burst `pane.list` p95 would spike. |

Latency is wall-clock round-trip on the client socket (`process.hrtime`), so it includes JSON serialization, pipe transit, the handler, the synchronous store critical section, the synchronous `metadata.json` persist, and the reply. That is the honest "what the plugin feels" number, not an isolated store microbenchmark.

### 2.3 The rate-limit caveat (read this before quoting B1)

`PipeServer` enforces two wire caps (verified in `src/main/pipe/PipeServer.ts`):

- **per-socket: 50 rpc/s** (`limit.count > 50` → `error: 'rate limited'`)
- **global: 200 rpc/s** across all sockets (`error: 'rate limited (global)'`)

These bound *external* throughput far below the store's internal capacity. A single-threaded synchronous `MetadataStore.set()` can commit writes much faster than 50/s; the pipe just won't let one socket send them. So:

- **B1 is paced under the cap — and sequential.** The bench paces a single socket to just under the per-socket cap (`PER_SOCKET_RATE − 2`) so the loop measures store + IPC *latency* rather than the rate limiter rejecting requests, and it **awaits each write (then sleeps to the pace gap) before dispatching the next**. The achieved writes/sec is therefore bounded by the loop's dispatch cadence — reply latency plus sleep-timer granularity (Windows timers are ~15 ms coarse) — and only reaches the pace ceiling when that cadence allows. In the §3 run it did not: the figure is **cadence-bound below the ceiling**, not the wire cap and not the store ceiling. The latency percentiles are the real per-write cost either way; the bench output labels which bound was hit.
- **B3 and B4 use two sockets** (~2 × 48/s ≈ 96/s) to roughly double event-emission throughput while staying under the 200/s global cap.
- The §8 Q5 spec of "1000 writes/sec" is **not reachable by a single external socket** by design — that rate is an internal-store figure. The bench characterizes the externally-observable substrate; the store's own headroom above the cap is argued from source in §4, not benchmarked over the wire (you cannot push 1000/s through a 50/s socket without measuring the rate limiter instead of the store).

The `--duration` flag sets the B1/B4 burst window (default 10s). Run with a longer window for steadier percentiles.

### 2.4 How to run

Single line, PowerShell (package first — the bench needs the asar bundle):

```
npm run package; node scripts/substrate-bench.mjs --json out\substrate-bench.json
```

The bench prints a results table and emits machine-readable JSON both to `--json <path>` and to stdout between `----- BENCH_JSON_BEGIN -----` / `----- BENCH_JSON_END -----` markers, so the numbers below can be lifted in verbatim.

---

## 3. Results

> Numbers below are from one bench run on the environment noted. They are environment-dependent (pipe IPC latency, CPU, disk — each write persists `metadata.json` synchronously); re-run on the target machine before quoting. Re-generate verbatim with the §2.4 command and lift the values from the `BENCH_JSON` block.

Environment: `win32, Node v22.21.1, packaged app build 2.17.1 (out/wmux-win32-x64), --duration 10s, run 2026-06-10`

### B1 — metadata write throughput (single socket, paced under cap)

| Metric | Value |
|---|---|
| writes/sec (single socket, paced under 50/s cap) | 37.23 — **below the ~48/s pace ceiling**, i.e. dispatch-cadence-bound (sequential await ≈ 5.1 ms + sleep-timer granularity ⇒ ~27 ms/cycle), **not** the wire cap and not the store; see §2.3 |
| write latency p50 / p95 / p99 | 5.089 ms / 8.028 ms / 9.226 ms |
| ok writes / errors over the window | 373 / 0 |
| version monotonic | PASS (final version = 373) |

### B2 — `events.poll` round-trip latency by page size

| `max` | p50 | p95 | events returned |
|---|---|---|---|
| 1 | 1.04 ms | 2.687 ms | 1 |
| 32 | 0.969 ms | 2.24 ms | 32 |
| 256 (`POLL_DEFAULT_MAX`) | 1.911 ms | 3.531 ms | 256 |
| 1024 (`RING_CAPACITY`) | 2.506 ms | 5.079 ms | 373 |

### B3 — ring-overflow point + resync recovery

| Metric | Value |
|---|---|
| events emitted (confirmed writes; emit errors counted separately) | 1230 / 0 errors |
| backlog at which `droppedCount` first appears | ≈ 650 events (first `droppedCount` = 3) |
| final stale poll: `resync` / `droppedCount` | resync: true / 585 |
| `bootId` stable across the burst | true |
| recovered via `pane.list` (`asOfSeq` returned) | PASS (`asOfSeq` = 1613) |

### B4 — snapshot latency idle vs. mid-burst (m0 §8 Q5)

| Metric | Value |
|---|---|
| pane count (this harness) | 1 |
| `pane.list` idle p50 / p95 | 1.718 ms / 3.933 ms |
| `pane.list` mid-burst p50 / p95 | 1.616 ms / 6.354 ms |
| mid-burst / idle p95 ratio | 1.616x (no copy-on-write needed — see §4.3 caveat) |
| concurrent writes completed during the burst | 306 |

---

## 4. Analysis — expected behavior grounded in source

The architecture predicts the shape of these results before the bench runs. Each claim below cites the source that backs it.

### 4.1 Writes serialize in a synchronous critical section

`MetadataStore.set()` (`src/main/metadata/MetadataStore.ts`) is one synchronous critical section: validate → concurrency check → merge → bump version → commit to the in-memory `Map` → persist → emit. There are no `await`s between validation and commit. Single-threaded JS therefore serializes all writers at the event-loop boundary — MCP, pipe RPC, and the renderer bridge all enter the same `set()` with no preemption (m0-design.md §4 race #5). Consequences:

- **`version` is strictly monotonic per pane** (B1 verifies this). Two concurrent `pane.setMetadata` calls cannot interleave inside `set()`, so neither can observe a torn version.
- **Write latency is dominated by the synchronous persist + IPC, not by lock contention** — there is no lock. The per-write cost the bench sees is: pipe transit + `JSON.stringify(merged).length` byte-cap check + the synchronous `metadata.json` write (persist-then-publish, m0-design.md §3) + the reply.

### 4.2 The wire caps, not the store, bound external throughput

The store can commit far more than 50 writes/s — a synchronous in-memory `Map.set` plus a small JSON write is sub-millisecond. The binding constraint for an external client is the `PipeServer` per-socket cap of 50 rpc/s (and 200 rpc/s global). So the practical external bottleneck is **the rate limiter + IPC, not the store**. B1's writes/sec figure sits at or below that cap (cadence-bound in the §3 run — see §2.3); the store has headroom above it that an external single socket cannot exercise. The §8 Q5 "1000 writes/sec" figure is an internal-store rate; reaching it over the wire would require ~20 sockets and would hit the 200/s global cap first.

### 4.3 `snapshot()` does not block the write path (the §8 Q5 answer)

`MetadataStore.snapshot()` iterates the in-memory `Map`, clones each entry, and reads `eventBus.latestSeq()` + `eventBus.bootId` — all in-memory, all synchronous, no I/O (`src/main/metadata/MetadataStore.ts`). Because it is synchronous and the store map is in-memory, a snapshot cannot be *preempted* by a concurrent write, and a write cannot be preempted by a snapshot — single-threaded JS runs each to completion. The only interaction is that a `pane.list` and a `pane.setMetadata` queued at the same tick run back-to-back, each adding its own latency to the other's wait, not multiplying it.

So the §8 Q5 question — "does a snapshot mid-burst block the main process noticeably?" — has a structural answer: **no copy-on-write is needed.** The snapshot is O(panes) in clone cost and O(1) in seq/bootId reads; it never awaits. B4 confirms this empirically, with the nuance the prediction anticipated: **mid-burst p50 is flat** (1.616 ms vs. 1.718 ms idle — the median snapshot is no slower under concurrent writes, exactly what "no blocking" predicts), while **p95 rises to 1.616x idle** (6.354 ms vs. 3.933 ms). That tail elevation is the IPC dispatch queue, not the store: both `pane.list` and the background writer share one main-process event loop, so a snapshot occasionally queues behind a write (and vice versa) and pays that one write's latency as added wait — they run back-to-back, not concurrently, so the tail widens while the median holds. A *store-blocking* failure would have moved the median too. The ratio scales with concurrent traffic and pane count, not with any shared lock — there is none.

**Caveat on pane count.** This harness has one pane, so B4's snapshot cost is a floor, not a worst case. Snapshot clone cost is O(number of panes with metadata): `snapshot()` walks the whole map and clones each `metadata` object. A daemon with hundreds of metadata-bearing panes pays proportionally more per `pane.list`. That cost is still synchronous and non-blocking in the preemption sense, but it lengthens the single critical section. See §5.

### 4.4 `events.poll` is O(ring size) per call

`EventBus.poll()` (`src/main/events/EventBus.ts`) walks from the oldest live entry to newest, scanning up to `size` entries (capped at `RING_CAPACITY = 1024`), applying the type/workspace filters, and stopping at `max` matches. It tracks `lastScannedSeq` so a filtered subscriber does not re-scan unmatched entries on the next poll (PROTOCOL.md §2.3). Consequences for B2:

- Poll cost is bounded by the ring walk (≤ 1024 entries) plus serialization of up to `max` matched events. Larger `max` mostly costs serialization, not scan — the scan is the same ring walk regardless of `max`.
- A poll that matches nothing still advances the cursor to `latestSeq`, so a sparse subscriber pays the ring walk once, not repeatedly.

### 4.5 The overflow contract (B3)

The ring is a fixed `RING_CAPACITY = 1024`-entry buffer (`src/shared/events.ts`). When a client's cursor falls behind by more than the window, `poll()` reports it (`src/main/events/EventBus.ts`):

- `drifted = oldestSeq > 0 && cursor + 1 < oldestSeq` → `resync: true` and `droppedCount = oldestSeq − cursor − 1`.
- `ahead = cursor > latestSeq` (future cursor / daemon restart) → `resync: true`, no `droppedCount`.
- On resync the bus advances the effective cursor to `oldestSeq − 1` so the client gets the oldest still-live events, not an empty page.

Recovery is `pane.list` (PROTOCOL.md §2.5, §3): it returns `{ asOfSeq, bootId, panes }`; the client applies the snapshot and resumes `events.poll(cursor: asOfSeq)`. A `bootId` mismatch is the stricter signal (PROTOCOL.md §2.4) — the daemon restarted and the entire seq space is invalid, so all cached pane/pty ids and cursors must be dropped, not just the missed window.

B3's "first drop at backlog ≈ N" figure will be **less than a clean 1024** in practice: the ring already holds B1 + B2 traffic plus the daemon's own startup events (`process.started`, `pane.created`), so the 1024 window is partly consumed before B3 starts emitting. This is the honest "real ring-overflow point" issue #15 asked for — the usable backlog before drop is `1024 − (events already in the ring)`, not a fixed 1024.

---

## 5. Limitations and future work

- **One-pane harness.** B4 measures snapshot latency with a single metadata-bearing pane. The dominant snapshot cost is O(panes) (§4.3), so a multi-pane characterization (the bench is structured to take a pane count if the harness materializes more panes) would bound the worst case. The structural "no blocking" conclusion holds regardless; only the absolute latency grows.
- **Single-machine numbers.** All figures are environment-dependent — pipe IPC latency, CPU, and synchronous disk writes for `metadata.json` move them. The bench is reproducible; the numbers are not portable. Re-run on the target machine.
- **Sharded ring (future).** The ring is a single global 1024-entry buffer; a busy multi-workspace daemon shares it across all workspaces, so one noisy workspace can shorten everyone's backlog window. PROTOCOL.md §2.2 already reserves the right to evolve to a sharded/segmented ring without notice (opaque cursor). That would change B3's per-workspace overflow point but not the wire contract.
- **Native PID / faster persist (future).** Write latency includes a synchronous `metadata.json` persist. A future async-persist path (e.g. moving the write to a worker) would add a microtask boundary inside `set()` and require a per-pane lock to preserve the version contract (m0-design.md §3) — that is the one place the "single-threaded JS serializes everything" assumption is load-bearing, and the bench is the regression guard for it.
- **`system.capabilities` tier map is still planned.** Per `inventory.md`, the per-method stability tier is not yet reported by `system.capabilities`; this doc does not depend on it.
