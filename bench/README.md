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

The result schema (`schemaVersion: 1`) is documented inline in
`scripts/perf-compare.mjs` (the gated dot-paths) and produced by
`scripts/perf-bench.mjs`.

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
