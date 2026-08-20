// A1 performance gate: compare a fresh perf-bench result against a blessed
// baseline and decide PASS/FAIL per metric. The gating philosophy is
// deliberately conservative — a metric only fails when it regresses by BOTH a
// relative ratio AND an absolute margin, so tiny baselines (a few ms, a few
// MiB) can't be tripped by ordinary CI noise.
//
// This module is dual-purpose:
//   - imported by scripts/__tests__/perfCompare.test.mjs for pure-logic tests
//     (no filesystem, no CLI), via the exported compareResults()/GATES.
//   - run as a CLI from perf.yml and locally.
//
// NOTE: intentionally no shebang line. vitest imports this .mjs as a test
// dependency on Windows CI, and a leading shebang makes the loader throw a
// SyntaxError (known repo gotcha). Invoke via `node scripts/perf-compare.mjs`.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { sameFileReason } from './perf-paths.mjs';

export const SCHEMA_VERSION = 1;

// Gated metrics. `path` is a dot-path into the result JSON. A metric FAILS only
// when current > baseline * ratio AND current > baseline + absMargin. `lower`
// is which direction is "better" (all current metrics are lower-is-better).
//
// `baselineFallbackPath` (optional) is where the BASELINE's number is read when
// it has nothing at `path`. It exists so moving a gate to a new estimator does
// not silently ungate the metric against baselines blessed before the move: a
// missing baseline number is status NEW, which gates nothing at all.
export const GATES = [
  // Best-of-N, not the median (#650). Cold start is measured on a shared CI
  // runner whose interference is one-sided: a busy host makes boots slower and
  // never faster, so the fastest of the N boots is the sample least polluted by
  // the machine. The median flaked for exactly that reason — on 2026-07-27 a
  // degraded windows-latest runner spent 2.2s just spawning the daemon process
  // and 2.0s acquiring a file lock, which put the median at 2470ms against a
  // 1207ms baseline on a commit that only changed web pairing-code length. The
  // confirmation re-run (#570) could not save it: the re-run lands on the SAME
  // runner, so a machine that is degraded for the whole job reproduces the red
  // by construction. Best-of-N would have read 1442ms and passed, while a real
  // regression — which slows every boot, not one of them — still trips both
  // thresholds. The median is still measured, still published to the trend, and
  // still reported (see tailRegressionNote) when it regresses on its own.
  //
  // The key is `coldFirstPtyDataBestMs`, NOT the old `coldFirstPtyDataMs`: the
  // trend field is derived from this key, and reusing the old name would splice
  // best-of-N values into a column that has carried medians since the trend
  // began — a silent estimator change inside one series, which is the exact
  // shape of drift #602 exists to prevent. The rename ends the old series and
  // starts a new one, so a consumer sees a new column, never mixed statistics.
  {
    key: 'coldFirstPtyDataBestMs',
    label: 'coldStart.firstPtyDataMs (best)',
    path: 'scenarios.coldStart.best.firstPtyDataMs',
    baselineFallbackPath: 'scenarios.coldStart.median.firstPtyDataMs',
    scenarioPath: 'scenarios.coldStart',
    ratio: 1.5,
    absMargin: 1000, // ms
    unit: 'ms',
  },
  {
    key: 'echoP95Ms',
    label: 'inputLatency.echoMs.p95',
    path: 'scenarios.inputLatency.echoMs.p95',
    scenarioPath: 'scenarios.inputLatency',
    ratio: 1.5,
    absMargin: 10, // ms
    unit: 'ms',
  },
  {
    key: 'frameP95Ms',
    label: 'inputLatency.frameMs.p95',
    path: 'scenarios.inputLatency.frameMs.p95',
    scenarioPath: 'scenarios.inputLatency',
    ratio: 1.5,
    absMargin: 10, // ms
    unit: 'ms',
  },
  {
    key: 'frame8P95Ms',
    label: 'inputLatency8.frameMs.p95',
    path: 'scenarios.inputLatency8.frameMs.p95',
    scenarioPath: 'scenarios.inputLatency8',
    ratio: 1.5,
    absMargin: 10, // ms
    unit: 'ms',
  },
  {
    key: 'ramIdleBytes',
    label: 'ram.idle1Pane.workingSetBytes',
    path: 'scenarios.ram.idle1Pane.workingSetBytes',
    scenarioPath: 'scenarios.ram.idle1Pane',
    ratio: 1.3,
    absMargin: 104857600, // 100 MiB
    unit: 'bytes',
  },
  {
    key: 'ram8Bytes',
    label: 'ram.panes8.workingSetBytes',
    path: 'scenarios.ram.panes8.workingSetBytes',
    scenarioPath: 'scenarios.ram.panes8',
    ratio: 1.3,
    absMargin: 157286400, // 150 MiB
    unit: 'bytes',
  },
  // W2 — N-pane concurrent-streaming frame budget (design §2.1/§3). Calibrated
  // against real CI runs (2026-07-10, 4 runs): frameDeltaMs.p95 is vsync-pinned
  // for every N with zero run-to-run spread. Each N gates against its OWN
  // baseline entry (no single budget across N).
  //
  // #940 — gated on FRAMES rather than on a ratio to the baseline. The metric
  // is quantized: across all 216 `bench-history` records these p95s only land
  // in frame-interval clusters (15.7-15.8, 31.1-31.4, 46.8-47.0, 62.4-62.5,
  // 78.1). Against a 1-frame baseline `ratio: 2.0` puts the threshold at
  // exactly 31.4 — the top of the two-frame cluster — so those records passed
  // only because "regressed past 2x" is strictly-greater. The verdict was
  // riding on threshold placement rather than on measurement, and it drifted
  // multiplicatively: a baseline blessed from a 2-frame run would have allowed
  // 4 frames.
  //
  // `frameMargin: 1` says the intended thing on the metric's own unit — p95 may
  // sit up to one whole frame interval above the blessed baseline, and past
  // that is red. It replaces both halves of the double condition (the 8 ms
  // absMargin was already additive, just half a frame and arbitrary). Drift is
  // now linear: a 2-frame baseline allows 3 frames, not 4.
  //
  // Verdicts are unchanged. Replayed over every record in the trend — 648
  // samples, 216 records x 3 N — the old rule and this one disagree on nothing.
  // The dropped-frame step the original calibration was written around (33.3 ms
  // against 15.7, and the 37.1 ms the confirmation fixtures use) still trips it.
  //
  // `ratio` / `absMargin` stay on these entries for the delta columns and for
  // consumers reading the gate table; they no longer decide the verdict.
  {
    key: 'frameBudgetP95Ms_N4',
    label: 'frameBudget.N4.frameDeltaMs.p95',
    path: 'scenarios.frameBudget.N4.frameDeltaMs.p95',
    scenarioPath: 'scenarios.frameBudget.N4',
    frameMargin: 1, // #940 — whole frame intervals allowed above baseline
    ratio: 2.0,
    absMargin: 8, // ms (see calibration note above)
    unit: 'ms',
  },
  {
    key: 'frameBudgetP95Ms_N8',
    label: 'frameBudget.N8.frameDeltaMs.p95',
    path: 'scenarios.frameBudget.N8.frameDeltaMs.p95',
    scenarioPath: 'scenarios.frameBudget.N8',
    frameMargin: 1, // #940 — whole frame intervals allowed above baseline
    ratio: 2.0,
    absMargin: 8, // ms
    unit: 'ms',
  },
  {
    key: 'frameBudgetP95Ms_N16',
    label: 'frameBudget.N16.frameDeltaMs.p95',
    path: 'scenarios.frameBudget.N16.frameDeltaMs.p95',
    scenarioPath: 'scenarios.frameBudget.N16',
    frameMargin: 1, // #940 — whole frame intervals allowed above baseline
    ratio: 2.0,
    absMargin: 8, // ms
    unit: 'ms',
  },
  // Hidden-flood typing — N agents stream in hidden workspaces while the
  // visible pane is typed into (the multi-workspace multi-agent shape;
  // perf-bench measureHiddenFlood). Two axes per N: focused echo latency
  // (user-perceived typing) and the visible pane's rAF cadence (paint
  // smoothness). echoMs.p95 is the noisiest gated metric — observed CI
  // spread across 4 runs (2026-07-10) was 2.3x (N4 37.1–85.5ms, N8
  // 56.4–126.8ms) because the scenario deliberately saturates the app and
  // runner load dominates. absMargin 50ms keeps the gate from flaking if a
  // future baseline is blessed from a low-noise run, while a real regression
  // (scheduler/retention broken → several hundred ms, 526ms measured locally)
  // still clears both conditions. frameDeltaMs is vsync-pinned like
  // frameBudget, so the tight 8ms margin applies. Each N gates against its
  // OWN blessed baseline entry.
  {
    key: 'hiddenFloodEchoP95Ms_N4',
    label: 'hiddenFlood.N4.echoMs.p95',
    path: 'scenarios.hiddenFlood.N4.echoMs.p95',
    scenarioPath: 'scenarios.hiddenFlood.N4',
    ratio: 2.0,
    absMargin: 50, // ms (see hidden-flood calibration note above)
    unit: 'ms',
  },
  {
    key: 'hiddenFloodFrameDeltaP95Ms_N4',
    label: 'hiddenFlood.N4.frameDeltaMs.p95',
    path: 'scenarios.hiddenFlood.N4.frameDeltaMs.p95',
    scenarioPath: 'scenarios.hiddenFlood.N4',
    ratio: 2.0,
    absMargin: 8, // ms
    unit: 'ms',
  },
  {
    key: 'hiddenFloodEchoP95Ms_N8',
    label: 'hiddenFlood.N8.echoMs.p95',
    path: 'scenarios.hiddenFlood.N8.echoMs.p95',
    scenarioPath: 'scenarios.hiddenFlood.N8',
    ratio: 2.0,
    absMargin: 50, // ms (see hidden-flood calibration note above)
    unit: 'ms',
  },
  {
    key: 'hiddenFloodFrameDeltaP95Ms_N8',
    label: 'hiddenFlood.N8.frameDeltaMs.p95',
    path: 'scenarios.hiddenFlood.N8.frameDeltaMs.p95',
    scenarioPath: 'scenarios.hiddenFlood.N8',
    ratio: 2.0,
    absMargin: 8, // ms
    unit: 'ms',
  },
];

// W2 — boolean consistency gates (design §3). Unlike GATES (numeric regression
// vs a baseline), these are a pass/fail CORRECTNESS check with NO baseline: the
// IME composition must echo back exactly, and the WebGL context must recover
// after a forced loss. Judgment is baseline-independent — `current !== true` is
// an immediate FAIL when the scenario is present. When the scenario is absent
// (e.g. --skip-ime) the gate is SKIP, not FAIL. `path` points at the boolean
// field; `scenarioPath` distinguishes "absent" from "present-but-false".
export const BOOL_GATES = [
  {
    key: 'imePass',
    label: 'ime.pass',
    path: 'scenarios.ime.pass',
    scenarioPath: 'scenarios.ime',
  },
  {
    key: 'webglContextLossPass',
    label: 'webglContextLoss.pass',
    path: 'scenarios.webglContextLoss.pass',
    scenarioPath: 'scenarios.webglContextLoss',
  },
];

// Below this fraction of the baseline we suggest re-blessing the baseline so it
// stops being generous relative to reality.
const IMPROVEMENT_FRACTION = 0.8;

// --- pure helpers -----------------------------------------------------------

// Resolve a dot-path into an object. Returns undefined if any segment is
// missing. Treats undefined as "absent"; null is returned as null so callers
// can distinguish "scenario produced a null metric" from "scenario absent".
export function getPath(obj, dotPath) {
  if (obj == null) return undefined;
  const parts = dotPath.split('.');
  let cur = obj;
  for (const p of parts) {
    if (cur == null || typeof cur !== 'object') return undefined;
    if (!(p in cur)) return undefined;
    cur = cur[p];
  }
  return cur;
}

function isNumber(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

function fmtBytes(n) {
  if (!isNumber(n)) return String(n);
  const mib = n / (1024 * 1024);
  return `${mib.toFixed(1)} MiB`;
}

function fmtMs(n) {
  if (!isNumber(n)) return String(n);
  return `${n.toFixed(1)} ms`;
}

export function fmtValue(v, unit) {
  if (v == null) return '—';
  if (unit === 'bool') return v === true ? 'true' : 'false';
  if (unit === 'bytes') return fmtBytes(v);
  return fmtMs(v);
}

function deltaPct(current, baseline) {
  if (!isNumber(current) || !isNumber(baseline) || baseline === 0) return null;
  return ((current - baseline) / baseline) * 100;
}

/**
 * Pure comparison core. Returns a structured verdict array — no IO, no process
 * exit — so it is unit-testable in isolation.
 *
 * Verdict per gate:
 *   status: 'PASS' | 'FAIL' | 'SKIP' | 'NEW'
 *     PASS  — current within bounds (or improved)
 *     FAIL  — regressed past both ratio and abs margin, OR baseline has the
 *             metric but current dropped it (silently skipped scenario)
 *     SKIP  — neither side has a comparable number, or scenario absent on both
 *     NEW   — current has it, baseline doesn't (informational)
 *   improved: boolean — current < baseline * IMPROVEMENT_FRACTION
 */
/**
 * One frame interval, in ms — the quantum `frameDeltaMs.p95` is measured in.
 *
 * Read off the measurement, not off a refresh rate: 15.7 is what
 * `bench/baseline-ci.json` holds for all three N, and it is the top of the
 * one-frame cluster in the trend. The perf job is `windows-latest` only, so
 * there is one quantum to fit.
 *
 * The cluster has width — across all 216 `bench-history` records the two-frame
 * samples run 31.1 to 31.4 and the three-frame ones 46.8 to 47.0 — so the
 * constant has to be the TOP of the one-frame cluster, not its middle. At
 * 15.625 (the Windows timer tick, which is where these numbers come from
 * physically) the threshold lands at 31.325, inside the two-frame cluster, and
 * two real records at 31.4 flip from PASS to FAIL. That is the same
 * between-quanta accident this change exists to remove, one quantum lower.
 *
 * Checked against every record in the trend: 648 samples (216 records x 3 N),
 * zero verdict changes.
 */
export const FRAME_INTERVAL_MS = 15.7;

export function compareResults(current, baseline, gates = GATES) {
  const results = [];
  for (const gate of gates) {
    const cur = getPath(current, gate.path);
    let base = baseline == null ? undefined : getPath(baseline, gate.path);
    // A baseline blessed before this gate moved estimators has no number at
    // `path`. Read the older field rather than report NEW — NEW gates nothing,
    // and a gate that quietly stops gating is the worst of the three outcomes.
    // Every fallback in use is conservative by construction (the old median is
    // >= the new best), so the substitute can only ever be more forgiving.
    let baselineFallback = false;
    if (!isNumber(base) && baseline != null && gate.baselineFallbackPath) {
      const alt = getPath(baseline, gate.baselineFallbackPath);
      if (isNumber(alt)) {
        base = alt;
        baselineFallback = true;
      }
    }

    const baseScenarioPresent =
      baseline != null && getPath(baseline, gate.scenarioPath) != null;
    const curScenarioPresent = getPath(current, gate.scenarioPath) != null;

    const r = {
      key: gate.key,
      label: gate.label,
      unit: gate.unit,
      ratio: gate.ratio,
      absMargin: gate.absMargin,
      baseline: isNumber(base) ? base : null,
      current: isNumber(cur) ? cur : null,
      deltaPct: null,
      status: 'SKIP',
      improved: false,
      note: '',
      baselineFallback,
    };

    // Baseline has no usable number for this metric.
    if (!isNumber(base)) {
      if (isNumber(cur)) {
        // Current produced a number the baseline never had — informational.
        r.status = 'NEW';
        r.note = 'new metric (no baseline)';
      } else {
        // Neither side has it: nothing to gate.
        r.status = 'SKIP';
        r.note = baseScenarioPresent ? 'no baseline value' : 'scenario absent';
      }
      results.push(r);
      continue;
    }

    // Baseline has a number but current is missing/null.
    if (!isNumber(cur)) {
      if (curScenarioPresent || baseScenarioPresent) {
        // A scenario that the baseline measured must not silently vanish: a
        // skipped-but-expected scenario is a gate FAILURE, not a free pass.
        r.status = 'FAIL';
        r.note = 'baseline present but current missing (scenario skipped?)';
      } else {
        // Defensive: should be unreachable since base is a number here.
        r.status = 'SKIP';
        r.note = 'scenario absent';
      }
      results.push(r);
      continue;
    }

    // Both sides have numbers — apply the gate.
    r.deltaPct = deltaPct(cur, base);
    // #940 — a frame-margin gate allows a fixed number of whole frame intervals
    // above the baseline instead of the ratio + margin double condition,
    // because the metric is quantized and a ratio threshold lands between
    // quanta. No rounding: the margin is wall-clock, so a sample that is not on
    // a quantum is judged by how far past the allowance it actually is.
    const frameAllowance = gate.frameMargin ? gate.frameMargin * FRAME_INTERVAL_MS : null;
    const overRatio = cur > base * gate.ratio;
    const overAbs = cur > base + gate.absMargin;
    const failed = gate.frameMargin
      ? cur > base + frameAllowance
      : (overRatio && overAbs);
    if (failed) {
      r.status = 'FAIL';
      r.note = gate.frameMargin
        ? `regressed past +${gate.frameMargin} frame interval`
          + `${gate.frameMargin === 1 ? '' : 's'} `
          + `(+${fmtValue(frameAllowance, gate.unit)})`
        : `regressed past ${gate.ratio}x and +${fmtValue(
          gate.absMargin,
          gate.unit,
        )}`;
    } else {
      r.status = 'PASS';
      if (cur < base * IMPROVEMENT_FRACTION) {
        r.improved = true;
        r.note = 'improved — consider refreshing baseline';
      }
    }
    if (baselineFallback) {
      // Cross-estimator comparison (current best vs baseline median), so two
      // adjustments: the improvement flag is suppressed — best sits below the
      // median by construction, and "consider refreshing baseline" earned that
      // way would be a statistical artifact, not an improvement — and on a FAIL
      // the note must not say "re-bless", because blessing a baseline from a
      // run that just failed the gate would launder the regression into it.
      r.improved = false;
      const from = r.status === 'FAIL'
        ? `baseline read from \`${gate.baselineFallbackPath}\` — this baseline predates \`${gate.path}\`; fix the regression first, then re-bless`
        : `baseline read from \`${gate.baselineFallbackPath}\` — this baseline predates \`${gate.path}\`, so re-bless it`;
      r.note = r.note && !r.note.startsWith('improved') ? `${r.note}; ${from}` : from;
    }
    results.push(r);
  }
  return results;
}

/**
 * Pure boolean-gate core (W2). Baseline-independent correctness check — no
 * ratio, no margin. Per gate:
 *   status: 'PASS'  — scenario present AND value === true
 *           'FAIL'  — scenario present AND value !== true
 *           'SKIP'  — scenario absent (e.g. skipped by a flag)
 * Structurally shaped like compareResults() entries so renderTable/renderMarkdown
 * can render both in one table.
 */
export function compareBoolGates(current, gates = BOOL_GATES) {
  const results = [];
  for (const gate of gates) {
    const scenarioPresent = getPath(current, gate.scenarioPath) != null;
    const val = getPath(current, gate.path);
    const r = {
      key: gate.key,
      label: gate.label,
      unit: 'bool',
      baseline: null,
      current: val === true ? true : val === false ? false : null,
      deltaPct: null,
      status: 'SKIP',
      improved: false,
      note: '',
      bool: true,
    };
    if (!scenarioPresent) {
      r.status = 'SKIP';
      r.note = 'scenario absent (skipped?)';
    } else if (val === true) {
      r.status = 'PASS';
      r.note = 'consistency check passed';
    } else {
      r.status = 'FAIL';
      r.note = 'consistency check failed (expected true)';
    }
    results.push(r);
  }
  return results;
}

// Did any inputLatency scenario report rAF throttling (background tab / GPU
// stall)? Frame numbers are then untrustworthy; we still gate echo.
export function detectThrottled(current) {
  const flags = [];
  for (const sc of ['inputLatency', 'inputLatency8']) {
    const v = getPath(current, `scenarios.${sc}.throttled`);
    if (v === true) flags.push(sc);
  }
  return flags;
}

/**
 * What best-of-N deliberately does not fail on: the middle boot got much slower
 * while the fastest one did not.
 *
 * Gating on the fastest boot buys immunity to a runner that is degraded for the
 * whole job, and it pays for it with the case where only SOME boots regress —
 * a startup race, a retry that fires half the time. That case is real and worth
 * a human look, it is just not worth failing a build on a machine nobody owns.
 * So it is reported, never enforced: same double threshold as the gate, applied
 * to the median, printed as a note when the gated best came back clean.
 *
 * Returns a string to print, or null when there is nothing to say.
 */
export function tailRegressionNote(current, baseline, gates = GATES) {
  if (current == null || baseline == null) return null;
  const flagged = [];
  for (const gate of gates) {
    if (!gate.baselineFallbackPath) continue; // only the best-of-N gates have a median twin
    const medianPath = gate.baselineFallbackPath;
    const curMedian = getPath(current, medianPath);
    const baseMedian = getPath(baseline, medianPath);
    const curBest = getPath(current, gate.path);
    const baseBest = getPath(baseline, gate.path) ?? baseMedian;
    if (!isNumber(curMedian) || !isNumber(baseMedian) || !isNumber(curBest) || !isNumber(baseBest)) continue;
    const trips = (value, base) => value > base * gate.ratio && value > base + gate.absMargin;
    if (trips(curMedian, baseMedian) && !trips(curBest, baseBest)) {
      flagged.push(
        `${gate.label}: the fastest boot is within bounds (${fmtValue(curBest, gate.unit)} vs `
        + `${fmtValue(baseBest, gate.unit)}) but the median regressed `
        + `(${fmtValue(curMedian, gate.unit)} vs ${fmtValue(baseMedian, gate.unit)})`,
      );
    }
  }
  if (flagged.length === 0) return null;
  return (
    `NOTE: ${flagged.join('; ')}. The gate reads the fastest boot on purpose (#650), so this does `
    + 'not fail the build — but a regression only some boots hit is either a startup race or a '
    + 'runner that was busy for part of the job. Check the per-run numbers in the uploaded artifact.'
  );
}

export function hasFailure(results) {
  return results.some((r) => r.status === 'FAIL');
}

/**
 * The comparison half of the gate: both gate tables judged against an
 * already-parsed baseline. Pure.
 *
 * `recordOnly` here covers ONLY the schema-mismatch case. Whether a baseline
 * was supplied and could be read is the caller's business, and deliberately so:
 * a baseline file whose contents parse to `null` is NOT a record-only run —
 * numeric gates have nothing to compare against, but the baseline-independent
 * boolean gates still enforce, which is what this gate has always done.
 */
export function evaluateRun(current, baseline) {
  let usable = baseline ?? null;
  let recordOnly = false;
  let recordReason = '';
  if (usable && usable.schemaVersion !== current.schemaVersion) {
    recordOnly = true;
    recordReason = `schemaVersion mismatch (baseline ${usable.schemaVersion} vs current ${current.schemaVersion}) — record-only run`;
    usable = null;
  }
  const results = [
    ...compareResults(current, usable, GATES),
    ...compareBoolGates(current, BOOL_GATES),
  ];
  return { recordOnly, recordReason, results, baseline: usable };
}

// --- formatting -------------------------------------------------------------

function pad(s, n) {
  s = String(s);
  return s.length >= n ? s : s + ' '.repeat(n - s.length);
}

function padLeft(s, n) {
  s = String(s);
  return s.length >= n ? s : ' '.repeat(n - s.length) + s;
}

function deltaStr(r) {
  if (r.deltaPct == null) return '—';
  const sign = r.deltaPct >= 0 ? '+' : '';
  return `${sign}${r.deltaPct.toFixed(1)}%`;
}

export function renderTable(results) {
  const rows = results.map((r) => ({
    metric: r.label,
    baseline: r.baseline == null ? '—' : fmtValue(r.baseline, r.unit),
    current: r.current == null ? '—' : fmtValue(r.current, r.unit),
    delta: deltaStr(r),
    verdict: r.status,
  }));
  const headers = {
    metric: 'metric',
    baseline: 'baseline',
    current: 'current',
    delta: 'delta',
    verdict: 'verdict',
  };
  const all = [headers, ...rows];
  const w = {
    metric: Math.max(...all.map((x) => x.metric.length)),
    baseline: Math.max(...all.map((x) => x.baseline.length)),
    current: Math.max(...all.map((x) => x.current.length)),
    delta: Math.max(...all.map((x) => x.delta.length)),
    verdict: Math.max(...all.map((x) => x.verdict.length)),
  };
  const line = (x) =>
    `${pad(x.metric, w.metric)}  ${padLeft(x.baseline, w.baseline)}  ${padLeft(
      x.current,
      w.current,
    )}  ${padLeft(x.delta, w.delta)}  ${pad(x.verdict, w.verdict)}`;
  const out = [line(headers), line({
    metric: '-'.repeat(w.metric),
    baseline: '-'.repeat(w.baseline),
    current: '-'.repeat(w.current),
    delta: '-'.repeat(w.delta),
    verdict: '-'.repeat(w.verdict),
  })];
  for (const row of rows) out.push(line(row));
  return out.join('\n');
}

export function renderMarkdown(results, meta, extraNotes = []) {
  const lines = [];
  lines.push('## A1 Perf Gate');
  lines.push('');
  if (meta) {
    const commit = meta.commit ?? 'n/a';
    const mode = meta.mode ?? 'n/a';
    const cpu = meta.cpuModel ?? 'n/a';
    const appVersion = meta.appVersion ?? 'n/a';
    lines.push(`- commit: \`${commit}\``);
    lines.push(`- mode: \`${mode}\``);
    lines.push(`- appVersion: \`${appVersion}\``);
    lines.push(`- machine: ${cpu}`);
    lines.push('');
  }
  for (const note of extraNotes) lines.push(`> ${note}`);
  if (extraNotes.length) lines.push('');
  lines.push('| metric | baseline | current | delta | verdict |');
  lines.push('| --- | ---: | ---: | ---: | --- |');
  for (const r of results) {
    const baseline = r.baseline == null ? '—' : fmtValue(r.baseline, r.unit);
    const current = r.current == null ? '—' : fmtValue(r.current, r.unit);
    const verdict =
      r.status === 'FAIL'
        ? 'FAIL ❌'
        : r.status === 'PASS'
        ? (r.improved ? 'PASS ⬇' : 'PASS ✅')
        : r.status === 'NEW'
        ? 'NEW 🆕'
        : 'SKIP';
    lines.push(
      `| ${r.label} | ${baseline} | ${current} | ${deltaStr(r)} | ${verdict} |`,
    );
  }
  lines.push('');
  const notes = results.filter((r) => r.note).map((r) => `- ${r.label}: ${r.note}`);
  if (notes.length) {
    lines.push('### Notes');
    lines.push('');
    lines.push(...notes);
    lines.push('');
  }
  return lines.join('\n');
}

// --- CLI --------------------------------------------------------------------

function parseArgs(argv) {
  const args = {
    current: null, baseline: null, summary: null, appendHistory: null,
    confirmRetry: null, confirmBench: null, escalate: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--current') args.current = argv[++i];
    else if (a === '--baseline') args.baseline = argv[++i];
    else if (a === '--summary') args.summary = argv[++i];
    else if (a === '--append-history') args.appendHistory = argv[++i];
    else if (a === '--confirm-retry') args.confirmRetry = argv[++i];
    else if (a === '--confirm-bench') args.confirmBench = argv[++i];
    else if (a === '--escalate') args.escalate = argv[++i];
    else if (a === '--help' || a === '-h') args.help = true;
  }
  return args;
}

// One trend field per gated metric, DERIVED from the gate tables rather than
// hand-listed. The field names were always the gate keys reading the gate
// paths — but as a hand-copied second list it could drift, and it did: the four
// hiddenFlood gates landed with no trend fields, so the noisiest gated family
// had no trend record for as long as it had existed (#602). Deriving removes
// the copy. A gate cannot be added without its trend field now, because they
// are the same list.
//
// The record is therefore exactly the two gate tables, in their order, behind
// the run's identity fields — which is also the shape the pre-#602 lines
// already have. A test pins that shape, so a field hand-added here to "just add
// one more" reintroduces the second list loudly rather than quietly.
export function historyLine(current, meta) {
  const num = (p) => {
    const x = getPath(current, p);
    return typeof x === 'number' && Number.isFinite(x) ? x : null;
  };
  // Tri-state, mirroring compareBoolGates: true when it passed, false when the
  // scenario ran and did not, null when the scenario never ran (--skip-ime).
  const bool = (g) =>
    getPath(current, g.path) === true ? true
      : getPath(current, g.scenarioPath) != null ? false
        : null;
  return JSON.stringify({
    ts: new Date().toISOString(),
    commit: meta?.commit ?? null,
    mode: meta?.mode ?? null,
    appVersion: meta?.appVersion ?? null,
    ...Object.fromEntries(GATES.map((g) => [g.key, num(g.path)])),
    ...Object.fromEntries(BOOL_GATES.map((g) => [g.key, bool(g)])),
  });
}

function appendHistory(file, line) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  let prefix = '';
  if (fs.existsSync(file)) {
    const existing = fs.readFileSync(file, 'utf8');
    if (existing.length > 0 && !existing.endsWith('\n')) prefix = '\n';
  }
  fs.appendFileSync(file, prefix + line + '\n', 'utf8');
}

function usage() {
  return [
    'Usage:',
    '  node scripts/perf-compare.mjs --current <path> --baseline <path> \\',
    '       [--summary <md-path>] [--append-history <ndjson-path>] \\',
    '       [--confirm-retry <json-path>] [--confirm-bench <path>]',
    '       [--escalate <json-path>]',
    '',
    '--confirm-retry turns a red into a question: the bench legs behind the',
    'failing metrics are measured once more into that file, and the failure only',
    'stands if it reproduces (#570). The original --current file is never',
    'touched, and the history line is written from it before any re-run.',
    '--confirm-bench overrides which bench script the re-run invokes.',
    '',
    '--escalate hands the one verdict a same-runner re-run cannot settle to a',
    'fresh-runner confirmation job (#940): when the failure REPRODUCED on this',
    'runner, the failing plan is written to that file and the exit code is 0 —',
    'the caller (perf.yml) runs perf-confirm-fresh.mjs on a different machine,',
    'and THAT job carries the verdict. Every other red still exits 1 here:',
    'an unconfirmable red (correctness gate, harness failure) fails closed on',
    'this runner, and without --escalate nothing about the gate changes.',
    '',
    'Exit codes: 0 pass / record-only / a red that did not reproduce / a',
    'reproduced red escalated via --escalate, 1 gate failure, 2 usage or',
    'current-file IO error.',
  ].join('\n');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(usage() + '\n');
    return 0;
  }
  if (!args.current) {
    process.stderr.write('error: --current <path> is required\n\n' + usage() + '\n');
    return 2;
  }

  // No output may name an input. Writing the summary over the result file used
  // to corrupt it and still exit with the gate's verdict, and it would also
  // defeat the confirmation re-run's promise to keep the original sample: the
  // "before" bytes it restores would already be the summary. Refused as the
  // usage error it is, before anything is read or written.
  for (const [outFlag, outPath] of [
    ['--summary', args.summary],
    ['--append-history', args.appendHistory],
    ['--confirm-retry', args.confirmRetry],
    ['--escalate', args.escalate],
  ]) {
    if (!outPath) continue;
    for (const [inFlag, inPath] of [['--current', args.current], ['--baseline', args.baseline]]) {
      const why = sameFileReason(outPath, inPath);
      if (why) {
        process.stderr.write(`error: ${outFlag} would write over ${inFlag} '${inPath}' (${why})\n`);
        return 2;
      }
    }
  }

  // The CURRENT file is mandatory and any IO/parse error on it is a usage
  // error. Its raw bytes are kept: they are the "before" image the confirmation
  // re-run restores from, and capturing them here rather than later means no
  // output written in between can be mistaken for the original.
  let current;
  let currentBytes;
  try {
    currentBytes = fs.readFileSync(args.current);
    current = JSON.parse(currentBytes.toString('utf8'));
  } catch (err) {
    process.stderr.write(`error: cannot read current file '${args.current}': ${err.message}\n`);
    return 2;
  }
  if (current === null || typeof current !== 'object' || Array.isArray(current)) {
    // Valid JSON that is not a result object. Every gate would read as SKIP and
    // the run would pass green on a corrupt file, so refuse it by name.
    process.stderr.write(`error: current file '${args.current}' is not a result object\n`);
    return 2;
  }

  const meta = current.meta ?? {};
  const extraNotes = [];

  // Baseline missing / unreadable → record-only bootstrap path. Which of the
  // two it was is only a message; evaluateRun decides the verdict.
  let baseline = null;
  let baselineBytes = null;
  let ioRecordReason = null;
  if (!args.baseline) {
    ioRecordReason = 'no --baseline supplied — record-only run';
  } else {
    try {
      baselineBytes = fs.readFileSync(args.baseline);
      baseline = JSON.parse(baselineBytes.toString('utf8'));
    } catch {
      ioRecordReason = 'no baseline — record-only run';
    }
  }

  // Throttle warning (frame numbers untrustworthy). Does not auto-fail.
  const throttled = detectThrottled(current);
  if (throttled.length) {
    extraNotes.push(
      `WARNING: rAF throttling detected in ${throttled.join(', ')} — frameMs numbers are untrustworthy (echoMs still gated).`,
    );
  }

  // Compare against baseline (null baseline → everything NEW/SKIP, never FAIL).
  // The W2 boolean consistency gates ride along in the same list: they are
  // displayed always but only enforce (nonzero exit) once NOT record-only —
  // i.e. once the owner has blessed a baseline file, which is the same "gate
  // goes live after bless" signal the numeric gates use (design §3). This keeps
  // the first landings record-only so the job doesn't fail before a baseline
  // exists.
  const evaluated = evaluateRun(current, baseline);
  const recordOnly = ioRecordReason != null || evaluated.recordOnly;
  const recordReason = ioRecordReason ?? evaluated.recordReason;
  const allResults = evaluated.results;

  // Tail-only regression (median red, best green). Reported, never gating. Also
  // emitted as a workflow annotation: nobody opens a green job's summary, and a
  // note whose entire audience is people who open green summaries reaches no
  // one.
  const tailNote = tailRegressionNote(current, evaluated.baseline);
  if (tailNote) {
    extraNotes.push(tailNote);
    process.stdout.write(`::warning::${tailNote}\n`);
  }

  // Human-readable table to stdout.
  if (recordOnly) {
    process.stdout.write(`${recordReason}\n\n`);
  }
  process.stdout.write(renderTable(allResults) + '\n');
  const notes = allResults.filter((r) => r.note);
  if (notes.length) {
    process.stdout.write('\nNotes:\n');
    for (const r of notes) process.stdout.write(`  - ${r.label}: ${r.note}\n`);
  }
  for (const n of extraNotes) process.stdout.write(`\n${n}\n`);

  // Markdown summary for $GITHUB_STEP_SUMMARY.
  if (args.summary) {
    const mdNotes = [...extraNotes];
    if (recordOnly) mdNotes.unshift(`Record-only: ${recordReason}.`);
    const md = renderMarkdown(allResults, meta, mdNotes);
    try {
      fs.mkdirSync(path.dirname(path.resolve(args.summary)), { recursive: true });
      fs.writeFileSync(args.summary, md + '\n', 'utf8');
    } catch (err) {
      process.stderr.write(`warning: could not write summary '${args.summary}': ${err.message}\n`);
    }
  }

  // Append history ndjson (one line). Best-effort; never gates.
  if (args.appendHistory) {
    try {
      appendHistory(args.appendHistory, historyLine(current, meta));
    } catch (err) {
      process.stderr.write(`warning: could not append history '${args.appendHistory}': ${err.message}\n`);
    }
  }

  if (recordOnly) return 0;
  // Numeric OR boolean gate failure fails the job.
  if (!hasFailure(allResults)) return 0;

  // Confirmation re-run (#570). Deliberately in this process rather than a
  // second CI step: the confirmation is handed the very objects this gate
  // judged, so there is no window in which the files could change underneath
  // it and no handshake that could describe a different run than the one that
  // went red. The history line above has already been written from the
  // ORIGINAL sample, which is the contract — the re-run never becomes the
  // published measurement.
  if (args.confirmRetry) {
    const { confirmGate } = await import('./perf-confirm.mjs');
    const { cleared, escalation } = confirmGate({
      current,
      baseline: evaluated.baseline,
      results: allResults,
      // The bytes as they were BEFORE this process wrote anything, so what the
      // re-run is checked against — and restored from — is the run's own
      // sample and not something written in between.
      currentJson: args.current,
      currentBytes,
      baselineJson: args.baseline,
      baselineBytes,
      retryJson: args.confirmRetry,
      benchScript: args.confirmBench,
      summaryPath: args.summary,
    });
    // Fail closed by construction: confirmGate returns cleared only on an
    // explicit second PASS of every failing gate.
    if (cleared) return 0;
    // #940: a red that REPRODUCED on this runner is the one verdict a
    // same-runner measurement cannot settle — it separates a transient spike
    // from a repeatable one, but not a code regression from a machine degraded
    // for its whole lifetime. With --escalate, that exact case is handed to a
    // dependent fresh-runner job: the failing plan is written for
    // perf-confirm-fresh.mjs and THIS invocation exits 0, so the verdict moves
    // to the job that can actually render it. perf.yml pins the topology
    // (perfWorkflow.test.mjs): the marker's existence is what triggers the
    // fresh job, so a marker that fails to write must keep the red HERE.
    // Unconfirmable reds never reach this branch with a non-null escalation —
    // they fail closed on this runner, above.
    if (args.escalate && escalation) {
      const payload = {
        schemaVersion: 1,
        commit: current?.meta?.commit ?? null,
        resultSchemaVersion: current?.schemaVersion ?? null,
        ...escalation,
      };
      try {
        fs.mkdirSync(path.dirname(path.resolve(args.escalate)), { recursive: true });
        fs.writeFileSync(args.escalate, JSON.stringify(payload, null, 2) + '\n', 'utf8');
      } catch (err) {
        process.stderr.write(
          `::error::could not write the escalation file '${args.escalate}' (${err.message}) — `
          + 'the fresh-runner confirmation cannot be requested, so the red stands here.\n',
        );
        return 1;
      }
      process.stdout.write(
        '::warning::Perf gate: the failure reproduced on the same runner — escalated to a '
        + 'fresh-runner confirmation job (#940). That job now carries the verdict; this one '
        + 'only measured.\n',
      );
      if (args.summary) {
        try {
          fs.appendFileSync(
            args.summary,
            '\n> [!CAUTION]\n'
            + '> The failure reproduced on the same runner, which cannot distinguish a code '
            + 'regression from a machine degraded for its whole lifetime (#940). A fresh-runner '
            + 'confirmation job has been requested — **its verdict is the gate\'s**.\n',
            'utf8',
          );
        } catch { /* the verdict does not depend on the summary */ }
      }
      return 0;
    }
  }
  return 1;
}

// Guard the CLI entry so importing this module (vitest) does not run main().
// Windows path safety: compare normalized file URLs of import.meta.url and the
// invoked script path.
if (process.argv[1]) {
  const invokedUrl = pathToFileURL(path.resolve(process.argv[1])).href;
  const selfUrl = import.meta.url;
  // fileURLToPath round-trips both to compare on-disk paths case-insensitively
  // on Windows where drive-letter / separator casing can differ.
  const samePath =
    invokedUrl === selfUrl ||
    fileURLToPath(invokedUrl).toLowerCase() === fileURLToPath(selfUrl).toLowerCase();
  if (samePath) {
    // main() is async only because the confirmation re-run (#570) is imported
    // on demand; an unexpected throw must still be a nonzero exit, never an
    // unhandled rejection that some runner reports as success.
    main().then(
      (code) => process.exit(code),
      (err) => {
        process.stderr.write(`error: ${err?.stack || err}\n`);
        process.exit(2);
      },
    );
  }
}
