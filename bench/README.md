# A1 Performance Bench

The A1 bench measures three things that users actually feel in wmux, captures
them as a versioned JSON result, and gates regressions against a blessed
baseline. Baselines are **descriptive measurements, never aspirational
targets** — in keeping with the project principle *"measure first, never
pre-announce targets."*

## What it measures

- **Input latency** — via in-renderer instrumentation, two numbers per
  keystroke:
  - `echoMs`: key down → the echoed character arrives back at the renderer
    (full PTY round trip: renderer → main → daemon → ConPTY → shell → back).
  - `frameMs`: key down → the first `requestAnimationFrame` after the echo,
    i.e. the start of the frame that draws the glyph (key → visible, minus the
    final compositor swap).
  - Captured at 1 pane (`inputLatency`) and 8 panes (`inputLatency8`). We report
    p50/p95/p99/min/max/mean plus rAF cadence. If the renderer was
    `throttled` (background tab / GPU stall), frame numbers are flagged
    untrustworthy.
- **Cold start** — milestone timestamps from process spawn:
  `cdpReadyMs` (main process alive at the CDP-announce log — printed before the
  port actually binds, informational only), `pipeReadyMs` (PipeServer accepting,
  polled concurrently from spawn), `rendererReadyMs` (`.xterm` mounted),
  `firstPtyDataMs` (first PTY data reaching the renderer — the gated one), and
  `fcpMs` (First Contentful Paint; may be null). Run several times; the median
  is gated, and `medianRunCounts` records how many runs contributed per
  milestone so a degraded median is visible.
- **RAM** — working-set bytes of the **full process tree**, including the
  detached daemon, at two states: idle with 1 pane (`idle1Pane`) and 8 panes
  (`panes8`). `appMetricsRaw` is captured for context but is **never gated**.
- **Boot-phase attribution** (S-A) — the main process emits one
  `[boot-trace] mark=<name> epoch=<ms>` stderr line per boot milestone
  (`src/main/util/bootTrace.ts`), and the daemon exposes its own marks via the
  `daemon.ping` response (`bootTrace` field). The harness re-bases both onto
  the spawn timeline and records them per run (`runs[i].marks`,
  `runs[i].daemonBoot`) plus medians (`coldStart.medianMarks`,
  `coldStart.medianDaemonMarks`), and prints a derived phase table
  (pre-JS → module eval → app-ready wait → plugin load → daemon bootstrap
  with spawn/pipe/ping sub-phases → ready tail). All fields are **additive
  and never gated** — they exist to attribute regressions, not to gate them.
- **RAM attribution** (PR D) — each `ram` scenario carries an additive
  `breakdown` field that splits the flat working-set / commit total across
  per-process categories: `main` (Electron browser process), `renderer` (React
  UI + every xterm), `gpu` (WebGL contexts), `utility` (network/audio/storage
  services), `daemon` (the detached wmux daemon, matched by its pid file),
  `conhost` (ConPTY hosts, one per shell), and `other` (user shells +
  unclassified Chromium child types such as zygote, crashpad-handler, …).
  Processes are bucketed from the Electron `--type=` command-line flag plus
  image-name heuristics (pure classifier in `scripts/perf-process-classify.mjs`,
  unit-tested in `scripts/__tests__/perfProcessClassify.test.mjs`). Each bucket
  carries `{workingSetBytes, commitBytes, processCount}` and the buckets
  reconcile exactly to the flat total. **Additive and never gated** — it exists
  to locate the ~70 MB/pane cost (renderer V8 heap vs GPU vs daemon vs conhost)
  before any diet PR is built. No product code is touched; the attribution is
  derived entirely in the harness from a `Win32_Process` CIM snapshot.
- **WebGL pool occupancy** (PR D, 8-pane state) — `ram.webglOccupancy8` records
  an **approximation** of the live GPU-context count: `webglContextPool` is a
  module-level singleton not exposed on `window` (and PR D deliberately adds no
  debug hook to product code), so the harness counts `.xterm-screen canvas`
  elements in the DOM and probes each for a live `webgl`/`webgl2` context. This
  is a DOM proxy for `grantedCount()`, not the pool's own counter — it can
  diverge during the 10s deferred-dispose window or right after an eviction. The
  pool budget is `MAX_WEBGL_CONTEXTS=12`, so 8 panes sits below the cap (expect
  up to 8 live canvases). Recorded automatically with the 8-pane RAM scenario;
  `--webgl-occupancy` forces it on runs that skip RAM.

The result schema (`schemaVersion: 1`) is documented inline in
`scripts/perf-compare.mjs` (the gated dot-paths) and produced by
`scripts/perf-bench.mjs`. The PR D `ram.breakdown` and `ram.webglOccupancy8`
fields are **additive** — the gate iterates only the explicit dot-paths in
`GATES`, so new fields never change PASS/FAIL or trigger a record-only run (same
principle as the #210 boot-trace `marks` addition).

## Running locally

```sh
npm run package
node scripts/perf-bench.mjs --json out/perf-local.json
node scripts/perf-compare.mjs --current out/perf-local.json --baseline bench/baseline-local.json
```

Scenarios can be partially skipped via harness flags (e.g. `--skip-cold`,
`--skip-ram`) when iterating on one area. **Note:** the compare step treats a
scenario that the *baseline* measured but the *current* run skipped as a gate
**FAILURE** — a silently dropped scenario must not pass. Skip a scenario on both
sides (or run record-only) if you genuinely want it out of the gate.

### Scrollback A/B (PR D — RAM diet go/no-go)

To measure how much of the per-pane RAM is xterm scrollback, run the bench twice
with different `--scrollback-lines` and diff the `ram` totals + `breakdown`:

```sh
node scripts/perf-bench.mjs --skip-cold --skip-input --scrollback-lines 10000 --json out/perf-sb-10000.json
node scripts/perf-bench.mjs --skip-cold --skip-input --scrollback-lines 1000  --json out/perf-sb-1000.json
```

`--scrollback-lines N` pre-seeds a minimal `session.json` (one workspace, one
empty-PTY pane) carrying `scrollbackLines: N` into each isolated instance's
`userData`. The renderer's `loadSession` applies the preference **before any
terminal mounts**, so every measured pane — the seeded pane and the 7 split
children — gets an xterm CircularBuffer *configured* for `N` lines. Note the
buffer is lazily populated: RAM only grows as scrollback actually fills, so on
the near-empty terminals this scenario boots, the 8-pane delta between two runs
bounds the *configured worst case*, not a guaranteed linear increase (see the
measured verdict below, where the empty-buffer delta was ~0).

> Why a `session.json` pre-seed and not a live CDP injection: `scrollbackLines`
> is persisted in `SessionData`, but the zustand store is not exposed on
> `window` (no post-boot setter handle) and `loadSession` early-returns on an
> empty `workspaces` array (a preference-only seed is ignored). Seeding one
> schema-valid workspace is the robust persisted-location path. See the
> `buildScrollbackSeedSession` header in `scripts/perf-bench.mjs`.

The `--scrollback-lines` run identity is recorded in `meta.config.scrollbackLines`
so two result files are unambiguous.

#### First measured verdict (2026-06-13, dev machine i5-13420H) — diet NO-GO

The A/B above was run on the C1+Step-1 build. Buckets reconciled exactly to
the flat total in all four samples; `commandLineNullCount` was 0; WebGL
occupancy at 8 panes was 8/12 (cap never hit).

| 8-pane bucket | working set |
|---|---|
| other (user shells ×8 + unclassified Chromium) | **~632 MB (≈48%)** |
| gpu (one process, same at idle) | ~186 MB |
| renderer | ~146 MB |
| daemon | ~120 MB |
| main | ~106 MB |
| conhost (×8) | ~66 MB |

- **Half the 8-pane footprint is the user's own shells** (PowerShell ≈80 MB
  each) — not reachable by any wmux code change.
- **Scrollback A/B delta ≈ 0** (renderer −5 MB, inside noise): xterm's
  CircularBuffer is lazily populated, so on near-empty terminals the
  configured line count costs nothing. A future fill-the-scrollback scenario
  would be needed to measure the *populated* cost; on the diet question the
  empty-buffer result already kills the "cap scrollback by default" idea.
- gpu is a single fixed-cost process (identical at idle and 8 panes) — not a
  per-pane lever either.

Per the plan gate (renderer attribution >60% AND A/B delta >100 MB → build a
scrollback-cap PR): **both conditions failed → no RAM-diet code work.** The
remaining footprint is Chromium/V8/shell tax; this section is the
documentation-closure the plan called for.

## Isolation

The bench spawns the **packaged exe** with a `WMUX_DATA_SUFFIX` so it runs in an
isolated data namespace — you can keep a live wmux open while benching. When a
run finishes, the harness shuts the detached daemon down via `daemon.shutdown`
on the daemon pipe, so no orphaned background process survives the run.

## File inventory

| file | meaning |
| --- | --- |
| `baseline-local.json` | Blessed numbers for the **dev machine**. The sensitive baseline — local hardware is stable, so thresholds bite. |
| `baseline-ci.json` | Blessed numbers for **windows-latest** runners. May not exist yet; until it does, CI runs record-only. |
| `history.ndjson` | Main-branch trend, one NDJSON line per push, appended by CI. |

## Gate semantics

A metric **FAILS only when both** of these hold:

- `current > baseline * ratio`, **and**
- `current > baseline + absMargin`.

The double condition stops tiny baselines (a few ms, a few MiB) from tripping on
ordinary noise. Thresholds per metric:

| metric | ratio | abs margin |
| --- | --- | --- |
| `coldStart.firstPtyDataMs` | 1.5 | 1000 ms |
| `inputLatency.echoMs.p95` | 1.5 | 10 ms |
| `inputLatency.frameMs.p95` | 1.5 | 10 ms |
| `inputLatency8.frameMs.p95` | 1.5 | 10 ms |
| `ram.idle1Pane.workingSetBytes` | 1.3 | 100 MiB |
| `ram.panes8.workingSetBytes` | 1.3 | 150 MiB |

Other rules:

- **No baseline** (missing/unreadable file) → `record-only run`, exit 0. This is
  the bootstrap path before `baseline-ci.json` exists.
- **schemaVersion mismatch** between baseline and current → record-only, exit 0.
- **Metric present in current but absent in baseline** → `NEW` (informational),
  not a failure.
- **Improvement** (`current < baseline * 0.8`) → flagged "consider refreshing
  baseline".
- **`throttled: true`** in an input-latency scenario → loud warning in the
  summary (frame numbers untrustworthy); echo is still gated, no auto-fail.

Exit codes: `0` pass or record-only, `1` any gate failure, `2` usage / current
-file IO error.

## Baseline update policy

Baselines are **descriptive, not aspirational**. Update them only when an
*intentional* perf change lands (a deliberate optimization, a new dependency, a
runtime bump), via a deliberate PR that explains why the numbers moved. Do not
quietly re-bless a baseline to make a red gate green — investigate the
regression first.

## Known noise caveats

- CI runners are shared and use software GL, so absolute numbers there are
  noisier and slower than real hardware. The CI gate thresholds are
  intentionally loose for exactly this reason.
- **Antivirus tax on cold start**: real-time scanning (Windows Defender) can
  dominate local cold-start numbers — the same commit measures ~2.4x slower on
  a Defender-active dev machine than on CI. To attribute it, compare the
  boot-phase table local vs CI: AV cost concentrates in `pre-JS`, module eval,
  and the `daemon-spawned → daemon-pipe-file-seen` span (a second exe image
  scan), while genuine code cost inflates phases uniformly. For a one-off
  LOCAL diagnosis you can temporarily add a Defender exclusion for
  `out\wmux-win32-x64` plus the bench temp root via the Windows Security UI,
  re-run `--skip-input --skip-ram --cold-runs 3`, diff the phase tables, and
  **remove the exclusions afterwards**. Never automate or ship exclusions —
  this is a diagnostic procedure only.
- `baseline-local.json` is the sensitive one — the dev machine is stable, so its
  thresholds are the meaningful guardrail for everyday work.
- frame numbers depend on the compositor; trust `echoMs` first when a run looks
  surprising, and check the `throttled` flag.

## CI

`.github/workflows/perf.yml` runs on `windows-latest`: package → bench
(`--mode ci`) → compare against `bench/baseline-ci.json` → write
`perf-summary.md` into the job step summary and upload artifacts. On pushes to
`main` it also appends a trend line to `bench/history.ndjson` and commits it
(`[perf-history]`); `paths-ignore` keeps that commit from re-triggering the
workflow.
