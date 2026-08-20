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
  `fcpMs` (First Contentful Paint; may be null). Run several times; both
  `coldStart.median` and `coldStart.best` (fastest boot) are recorded, and
  `medianRunCounts` records how many runs contributed per milestone so a
  degraded median is visible. **`best` is the gated one** (#650): runner
  interference is one-sided — a busy CI host makes boots slower, never faster —
  so the fastest boot is the sample least contaminated by the machine. The
  median stays as the descriptive number and is reported separately when it
  regresses on its own (see Gate semantics). For the trend this is an explicit
  series fork: the `coldFirstPtyDataMs` column (a median since the trend began)
  **ends** at #650 and `coldFirstPtyDataBestMs` starts, because splicing
  best-of-N values into a median column would silently mix two estimators in
  one series. A consumer sees the old column stop and a new one begin — never
  mixed statistics under one name.
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

The main-branch trend is **not** in this directory: CI publishes it to the
`bench-history` branch as `history.ndjson`, one NDJSON line per push. Read it
with `git show origin/bench-history:history.ndjson` (after
`git fetch origin bench-history`) or browse the branch on GitHub. It lives off
`main` because the CI bot cannot push to a protected branch — when the trend
did live here, every append was rejected and the trend silently recorded
nothing for six weeks (#602).

## Gate semantics

Most metrics **FAIL only when both** of these hold:

- `current > baseline * ratio`, **and**
- `current > baseline + absMargin`.

The double condition stops tiny baselines (a few ms, a few MiB) from tripping on
ordinary noise. Thresholds per metric:

| metric | rule |
| --- | --- |
| `coldStart.best.firstPtyDataMs` | ratio 1.5 and +1000 ms |
| `inputLatency.echoMs.p95` | ratio 1.5 and +10 ms |
| `inputLatency.frameMs.p95` | ratio 1.5 and +10 ms |
| `inputLatency8.frameMs.p95` | ratio 1.5 and +10 ms |
| `ram.idle1Pane.workingSetBytes` | ratio 1.3 and +100 MiB |
| `ram.panes8.workingSetBytes` | ratio 1.3 and +150 MiB |
| `frameBudget.N4/N8/N16.frameDeltaMs.p95` | **+1 frame interval** (see below) |
| `hiddenFlood.N4/N8.echoMs.p95` | ratio 2.0 and +50 ms |
| `hiddenFlood.N4/N8.frameDeltaMs.p95` | ratio 2.0 and +8 ms |

### The frame-budget family is gated in frames (#940)

`frameBudget.*.frameDeltaMs.p95` is quantized. The perf job runs on
`windows-latest` only, so there is one frame interval to fit, and across all 216
`bench-history` records these p95s land in clusters one interval apart:
15.7–15.8, 31.1–31.4, 46.8–47.0, 62.4–62.5, 78.1 — one through five frames.

A ratio rule does not fit that shape. Against the blessed 1-frame baseline
`ratio: 2.0` put the threshold at exactly 31.4 ms — the top of the two-frame
cluster — so those records passed only because the comparison is
strictly-greater, and a baseline blessed from a 2-frame run would have moved the
ceiling to 4 frames.

So this family uses `frameMargin: 1` instead of the double condition: **FAIL
when `current > baseline + 15.7 ms`.** One whole frame above the blessed
baseline is the allowance; the second is red. Drift is linear rather than
multiplicative — a 2-frame baseline allows 3 frames, not 4. `ratio` and
`absMargin` remain on those entries for the delta columns only.

The interval is 15.7 and not 15.625: the clusters have width, and 15.625 (the
Windows timer tick these numbers come from physically) would put the threshold
at 31.325, *inside* the two-frame cluster, flipping the two real records that
measured 31.4. The constant is read off the measurement — 15.7 is what
`baseline-ci.json` holds for all three N — and the change was replayed over
every record in the trend (648 samples) with zero verdict changes.

Each `N` gates against its own baseline entry — there is no single budget shared
across N. Two further gates are baseline-**independent** correctness checks
(`ime.pass`, `webglContextLoss.pass`): present-and-not-`true` fails, absent
skips. `GATES` and `BOOL_GATES` in `scripts/perf-compare.mjs` are the source of
truth for this table, and every one of them writes a trend field of the same
name (see `historyLine`).

Other rules:

- **No baseline** (missing/unreadable file) → `record-only run`, exit 0. This is
  the bootstrap path before `baseline-ci.json` exists.
- **schemaVersion mismatch** between baseline and current → record-only, exit 0.
- **Metric present in current but absent in baseline** → `NEW` (informational),
  not a failure. A gate may name a `baselineFallbackPath` for the case where
  the metric merely MOVED: `coldStart.best.firstPtyDataMs` reads
  `coldStart.median.firstPtyDataMs` out of a baseline blessed before the
  estimator changed, so a pre-#650 baseline keeps gating (conservatively — the
  old median is never below the new best) instead of silently going `NEW`, and
  the note says to re-bless.
- **Tail-only regression** (the median trips both thresholds while the gated
  fastest boot does not) → printed as a NOTE, never a failure. That case is a
  startup race or a runner that was busy for part of the job; both deserve a
  look at `runs[i]` in the artifact, neither deserves a red build on a machine
  nobody owns.
- **Improvement** (`current < baseline * 0.8`) → flagged "consider refreshing
  baseline".
- **`throttled: true`** in an input-latency scenario → loud warning in the
  summary (frame numbers untrustworthy); echo is still gated, no auto-fail.

Exit codes: `0` pass or record-only, `1` any gate failure, `2` usage / current
-file IO error.

## Confirmation re-run (#570)

A red gate on CI is not final on its own. Given `--confirm-retry <path>`,
`perf-compare.mjs` measures the failing scenarios once more on the same runner
and only lets the red stand if the failure **reproduces** — a deterministic
regression should; a runner-interference tail spike should not. It costs extra
CI time only on runs that are already red, and it touches no baseline: the
policy below is unaffected in either direction.

It happens inside the compare process, not as a second CI step, and that is
deliberate: the confirmation is handed the very numbers this invocation judged.
There is no second read of the result file that could see different bytes, and
no handshake file that could outlive its run and describe a different one.

**What the re-run cannot answer**, and why the cold-start gate reads the fastest
boot instead (#650): the re-run lands on the SAME runner. That covers a spike
lasting seconds; it cannot cover a host that is degraded for the whole job. On
2026-07-27 one was — the daemon needed 2.2s just to spawn its Node process and
2.0s to take a file lock — and the red reproduced exactly as designed, on a
commit whose entire diff was the length of a web pairing code. A confirmation on
the same machine is a check on the code's determinism, not on the machine's
fitness to measure.

## Fresh-runner confirmation (#940)

That one unanswerable case now has an answer that is not a human clicking
"re-run all jobs". When the same-runner re-run REPRODUCES the failure — and
only then — `perf-compare.mjs --escalate <path>` writes the failing plan
(commit, gates, legs, bench args) to that file and exits **0**; `perf.yml`
then runs the `bench-confirm` job, a dependent job on a different machine by
construction, and **that job carries the gate's verdict**
(`perf-confirm-fresh.mjs`):

- every escalated gate passes there → green. The failure was measured twice on
  one machine and not at all on another; that is the signature of a runner
  degraded for its lifetime. The first sample is already in the trend — the
  trend records what was measured, not what was excused.
- anything fails there → red, reproduced on a **second machine** — the
  strongest claim this pipeline can make.
- anything unverifiable → red. Same fail-closed contract as the in-job re-run.

Escalation is deliberately narrow: a red that CLEARED needs nothing, and an
UNCONFIRMABLE red (correctness gate, harness failure) fails closed on the
first runner — "could not measure it again" is not a measurement question and
must not ride to another machine as one.

The in-job re-run avoids a cross-job handshake on principle; a dependent job
cannot, so the handshake is bound to the only identity that matters — the
**commit**. The escalation file names the short SHA the gate measured;
`bench-confirm` checks out `github.sha` explicitly, refuses to run unless its
own HEAD matches the escalation, and refuses the verdict unless the fresh
sample's recorded SHA matches too. A stale artifact, a moved PR base, or a
replayed escalation all fail closed on the same check. The whole topology —
the `--escalate` flag, the literal existence-check step, the job wiring, the
single-line verdict command — is pinned by `perfWorkflow.test.mjs`, because an
escalated red exits the first job green and every link in that chain is
load-bearing.

Stating the compounded trade plainly: best-of-N and the confirmation re-run
multiply. A cold-start red now requires the fastest boot of the first run AND
the fastest boot of the re-run to both trip the thresholds — a regression that
slows a boot with probability p is caught with roughly p^(2N), so the gate is
effectively for deterministic regressions. That is the deliberate posture: the
probabilistic tail is covered by the tail note (a `::warning::` annotation on
both the first run and a cleared re-run) and by the trend, not by a red build.

**Only measurements are confirmed.** A red that includes a boolean correctness
gate (`ime.pass`, `webglContextLoss.pass`) stands at once and is never re-run —
they are a consistency check, not a tail-prone measurement, and "it worked the
second time" is not a reason to ship a broken one. The rule cuts both ways: a
leg re-runs *all* of its scenarios, so a correctness gate that fails in the
re-run keeps the red even though it is not what went red first. Everything the
re-run measured has to come back clean, and a scenario the first run measured
inside a selected leg cannot disappear from the re-run — "could not measure it
again" is not a pass.

The trade is real and worth stating: a regression that only shows up in half of
runs now needs to land twice, so its chance of red-lighting a given push drops
from 50% to 25%. That is the price of a gate people believe; a gate that fires
at random is one nobody reads.

What gets re-run is a **leg** — one packaged-app instance — not the failing
metric. `scripts/perf-bench.mjs` measures several scenarios in sequence on one
instance and each inherits what the previous ones left behind (`ram.panes8` is
sampled after `inputLatency` has typed into that app; `webglContextLoss`
deliberately reuses the layout `frameBudget` leaves at max N), so a retry
narrowed to the failing metric would measure a different scenario and its
verdict would mean nothing. `scripts/perf-legs.mjs` holds that mapping —
`coldStart`, `a1` (ram + inputLatency), `w2` (ime + frameBudget +
webglContextLoss), `hiddenFlood` — and a gate whose scenario belongs to no leg
is refused loudly rather than skipped.

Two further properties are load-bearing:

- **The files the verdict rests on survive.** The re-run's target
  (`out/perf-retry.json`) is refused if it is the result file or the baseline by
  any name — resolved path, real path (symlinks and `\\?\` spellings), or
  hard-link identity — and is created with an atomic `wx+` open, so an existing
  file is refused rather than deleted (clearing whatever sits at a mistyped path
  would turn a typo into data loss). Its original handle stays open through the
  bench: identity is captured from that handle with the full 64-bit `dev:ino`,
  the path must still resolve to it afterward, and the verdict parses bytes
  through the original handle rather than reopening the checked name. A name
  swap is therefore detected, and keeping the original open prevents a deleted
  inode from being reused to masquerade as the same file; a filesystem that
  exposes no usable identity (`ino = 0`) makes the confirmation unconfirmable
  instead of weakening the check. The result file *and* the baseline are also
  compared byte for byte against what they held before the re-run — whatever happened in
  between, including a crash — and put back if they moved. The trend line
  published to `bench-history` is written from that first, tail-carrying
  measurement before any re-run starts. Both result files are uploaded as
  artifacts, and the job summary shows them side by side.

  For the same reason, `perf-compare` refuses at startup if `--summary`,
  `--append-history` or `--confirm-retry` names the same file as `--current` or
  `--baseline` (exit 2), and refuses a `--current` that is valid JSON but not a
  result object — it would otherwise read as every gate `SKIP` and pass green.
- **It fails closed.** An unreadable file, a re-run that crashes, a commit or
  schema mismatch, a gate that comes back `SKIP` because its leg died — all of
  those are "could not confirm", and could-not-confirm keeps the red. Only an
  explicit second `PASS` on every failing gate clears the job.

A cleared red is still reported (`::warning::` plus a job-summary section). If
one metric keeps clearing this way, that is a calibration problem worth its own
issue, not a re-run.

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
(`--mode ci`) → compare against `bench/baseline-ci.json`, confirming a red with
a re-run of the failing legs → write `perf-summary.md` into the job step summary
and upload artifacts.

The gate's verdict is one step's exit code, and YAML is where that can be broken
without a test, a type-check or a lint noticing: `continue-on-error` on the step
or on the job makes a red non-fatal, an `if:` lets the step not run at all, and
a block or folded `run:` with a second command hands the step the last command's
exit code instead of the gate's. Even a harmless-looking `--help`, or shell
syntax smuggled through another step's output, can turn the exact command into a
zero. `scripts/__tests__/perfWorkflow.test.mjs` therefore pins the invocation
and the only two literal values that its history output may splice into it,
against the shipped file.

On pushes to `main` it also publishes that run's trend line to the
`bench-history` branch (`[perf-history]`), appending it to `history.ndjson`
there. Three properties of that step are deliberate:

- It runs **even when the gate failed**. A red run is precisely the sample a
  noise investigation needs; skipping it would leave the trend describing only
  the runs that already passed.
- It never checks the branch out. The commit is assembled with git plumbing
  (`hash-object` → `update-index`/`write-tree` → `commit-tree` → `push`), so the
  packaged build in the working tree is untouched, and a concurrent `main` push
  simply rejects the (fast-forward-by-construction) push and the retry re-reads
  the new tip. If the existing trend cannot be read, the step refuses to publish
  rather than replace the series with a single line.
- A failure to publish is **loud but never fatal** — an `::error::` annotation
  plus a job-summary caution, and exit 0. A lost trend line must not fail the
  perf gate, but it must not pass unnoticed either: as a bare warning it went
  unnoticed for six weeks (#602). The line also rides along in the run's
  uploaded artifacts, so a failed publish can still be recovered by hand.
