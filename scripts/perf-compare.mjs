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

export const SCHEMA_VERSION = 1;

// Gated metrics. `path` is a dot-path into the result JSON. A metric FAILS only
// when current > baseline * ratio AND current > baseline + absMargin. `lower`
// is which direction is "better" (all current metrics are lower-is-better).
export const GATES = [
  {
    key: 'coldFirstPtyDataMs',
    label: 'coldStart.firstPtyDataMs',
    path: 'scenarios.coldStart.median.firstPtyDataMs',
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
  // W2 — N-pane concurrent-streaming frame budget (design §2.1/§3). ratio 2.0
  // encodes the strategy doc's "예산 2배" trigger directly. Calibrated against
  // real CI runs (2026-07-10, 4 runs): frameDeltaMs.p95 is vsync-pinned at
  // 15.7ms for every N with zero run-to-run spread, so a single dropped-frame
  // step (33.3ms) trips the 2.0x + 8ms double condition exactly as designed.
  // Each N gates against its OWN baseline entry (no single 16.7ms budget
  // across N).
  {
    key: 'frameBudgetP95Ms_N4',
    label: 'frameBudget.N4.frameDeltaMs.p95',
    path: 'scenarios.frameBudget.N4.frameDeltaMs.p95',
    scenarioPath: 'scenarios.frameBudget.N4',
    ratio: 2.0,
    absMargin: 8, // ms (see calibration note above)
    unit: 'ms',
  },
  {
    key: 'frameBudgetP95Ms_N8',
    label: 'frameBudget.N8.frameDeltaMs.p95',
    path: 'scenarios.frameBudget.N8.frameDeltaMs.p95',
    scenarioPath: 'scenarios.frameBudget.N8',
    ratio: 2.0,
    absMargin: 8, // ms
    unit: 'ms',
  },
  {
    key: 'frameBudgetP95Ms_N16',
    label: 'frameBudget.N16.frameDeltaMs.p95',
    path: 'scenarios.frameBudget.N16.frameDeltaMs.p95',
    scenarioPath: 'scenarios.frameBudget.N16',
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
export function compareResults(current, baseline, gates = GATES) {
  const results = [];
  for (const gate of gates) {
    const cur = getPath(current, gate.path);
    const base = baseline == null ? undefined : getPath(baseline, gate.path);

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

    // Both sides have numbers — apply the double-condition gate.
    r.deltaPct = deltaPct(cur, base);
    const overRatio = cur > base * gate.ratio;
    const overAbs = cur > base + gate.absMargin;
    if (overRatio && overAbs) {
      r.status = 'FAIL';
      r.note = `regressed past ${gate.ratio}x and +${fmtValue(
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

export function hasFailure(results) {
  return results.some((r) => r.status === 'FAIL');
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
  const args = { current: null, baseline: null, summary: null, appendHistory: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--current') args.current = argv[++i];
    else if (a === '--baseline') args.baseline = argv[++i];
    else if (a === '--summary') args.summary = argv[++i];
    else if (a === '--append-history') args.appendHistory = argv[++i];
    else if (a === '--help' || a === '-h') args.help = true;
  }
  return args;
}

function readJson(file) {
  const raw = fs.readFileSync(file, 'utf8');
  return JSON.parse(raw);
}

function historyLine(current, meta) {
  const v = (p) => {
    const x = getPath(current, p);
    return typeof x === 'number' && Number.isFinite(x) ? x : null;
  };
  return JSON.stringify({
    ts: new Date().toISOString(),
    commit: meta?.commit ?? null,
    mode: meta?.mode ?? null,
    appVersion: meta?.appVersion ?? null,
    coldFirstPtyDataMs: v('scenarios.coldStart.median.firstPtyDataMs'),
    echoP95Ms: v('scenarios.inputLatency.echoMs.p95'),
    frameP95Ms: v('scenarios.inputLatency.frameMs.p95'),
    frame8P95Ms: v('scenarios.inputLatency8.frameMs.p95'),
    ramIdleBytes: v('scenarios.ram.idle1Pane.workingSetBytes'),
    ram8Bytes: v('scenarios.ram.panes8.workingSetBytes'),
    // W2 trend fields (additive — older readers ignore unknown keys).
    frameBudgetP95Ms_N4: v('scenarios.frameBudget.N4.frameDeltaMs.p95'),
    frameBudgetP95Ms_N8: v('scenarios.frameBudget.N8.frameDeltaMs.p95'),
    frameBudgetP95Ms_N16: v('scenarios.frameBudget.N16.frameDeltaMs.p95'),
    imePass: getPath(current, 'scenarios.ime.pass') === true ? true
      : getPath(current, 'scenarios.ime') != null ? false : null,
    webglContextLossPass: getPath(current, 'scenarios.webglContextLoss.pass') === true ? true
      : getPath(current, 'scenarios.webglContextLoss') != null ? false : null,
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
    '       [--summary <md-path>] [--append-history <ndjson-path>]',
    '',
    'Exit codes: 0 pass / record-only, 1 gate failure, 2 usage or current-file IO error.',
  ].join('\n');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(usage() + '\n');
    return 0;
  }
  if (!args.current) {
    process.stderr.write('error: --current <path> is required\n\n' + usage() + '\n');
    return 2;
  }

  // The CURRENT file is mandatory and any IO/parse error on it is a usage error.
  let current;
  try {
    current = readJson(args.current);
  } catch (err) {
    process.stderr.write(`error: cannot read current file '${args.current}': ${err.message}\n`);
    return 2;
  }

  const meta = current.meta ?? {};
  const extraNotes = [];

  // Baseline missing / unreadable → record-only bootstrap path.
  let baseline = null;
  let recordOnly = false;
  let recordReason = '';
  if (!args.baseline) {
    recordOnly = true;
    recordReason = 'no --baseline supplied — record-only run';
  } else {
    try {
      baseline = readJson(args.baseline);
    } catch {
      recordOnly = true;
      recordReason = 'no baseline — record-only run';
    }
    if (baseline) {
      const baseSchema = baseline.schemaVersion;
      const curSchema = current.schemaVersion;
      if (baseSchema !== curSchema) {
        recordOnly = true;
        recordReason = `schemaVersion mismatch (baseline ${baseSchema} vs current ${curSchema}) — record-only run`;
        baseline = null;
      }
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
  const results = compareResults(current, baseline, GATES);
  // W2 boolean consistency gates (baseline-independent). Displayed always; they
  // only enforce (nonzero exit) once NOT record-only — i.e. once the owner has
  // blessed a baseline file, which is the same "gate goes live after bless"
  // signal the numeric gates use (design §3). This keeps the first landings
  // record-only so the job doesn't fail before a baseline exists.
  const boolResults = compareBoolGates(current, BOOL_GATES);
  const allResults = [...results, ...boolResults];

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
  return hasFailure(allResults) ? 1 : 0;
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
    process.exit(main());
  }
}
