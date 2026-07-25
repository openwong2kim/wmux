// Confirmation re-run support (#570): which perf-bench LEG each gated scenario
// belongs to, and how to re-run those legs and only those.
//
// Imported by perf-confirm.mjs, which turns a red gate into a re-run of just
// these legs. Deliberately pure — no filesystem, no spawning — so the whole
// mapping is unit-tested without a packaged app.
//
// WHY A LEG AND NOT A METRIC. A leg is one packaged-app instance in
// scripts/perf-bench.mjs, and it is the unit a confirmation re-run has to
// reproduce. The harness measures several scenarios in sequence on ONE
// instance, and each inherits the state the previous ones left behind, so a
// retry narrowed to the failing metric measures a *different scenario* than the
// one that went red and its reproduce / does-not-reproduce verdict stops
// meaning anything:
//
//   coldStart   — its own isolated boots (a discarded warmup, then N fresh
//                 instances). Nothing else runs on them.
//   a1          — ram.idle1Pane → inputLatency → split to 8 → ram.panes8 →
//                 inputLatency8, all on one instance. ram.panes8 is sampled
//                 AFTER inputLatency has typed into that app, so re-running ram
//                 with --skip-input measures an app that never did the work.
//   w2          — ime (deliberately on the clean, un-flooded boot layout) →
//                 frameBudget (measured incrementally 4 → 8 → 16, and it leaves
//                 the layout at max(N) panes) → webglContextLoss (which reuses
//                 that layout, as perf-bench's own comment says).
//   hiddenFlood — its own instance, from the clean 1-visible-pane layout.
//
// The same argument covers the N inside a family and the scenarios beside it in
// the leg; expressing it once, at the instance boundary, is what keeps a future
// gate from being retried in a way that quietly measures something else.

// `roots` are the first segment under `scenarios.` in a gate's scenarioPath —
// e.g. `scenarios.frameBudget.N8` has root `frameBudget`. `skipFlags` are every
// perf-bench flag that turns this leg off; to run a leg we pass the skip flags
// of all the OTHER legs, which is why a leg with two scenarios (a1) always
// re-runs both halves rather than the failing one.
export const LEGS = [
  {
    key: 'coldStart',
    label: 'coldStart (isolated boots)',
    roots: ['coldStart'],
    skipFlags: ['--skip-cold'],
  },
  {
    key: 'a1',
    label: 'ram + inputLatency (one shared instance)',
    roots: ['ram', 'inputLatency', 'inputLatency8'],
    skipFlags: ['--skip-ram', '--skip-input'],
  },
  {
    key: 'w2',
    label: 'ime + frameBudget + webglContextLoss (one dedicated instance)',
    roots: ['ime', 'frameBudget', 'webglContextLoss'],
    skipFlags: ['--skip-ime', '--skip-frame-budget', '--skip-webgl-recovery'],
  },
  {
    key: 'hiddenFlood',
    label: 'hiddenFlood (one dedicated instance)',
    roots: ['hiddenFlood'],
    skipFlags: ['--skip-hidden-flood'],
  },
];

// Built once at import so a root claimed by two legs is a loud startup error
// rather than a silently-dropped retry (the retry would then re-run the wrong
// instance and "confirm" a metric it never measured).
const LEG_BY_ROOT = (() => {
  const m = new Map();
  for (const leg of LEGS) {
    for (const root of leg.roots) {
      if (m.has(root)) {
        throw new Error(`perf-legs: scenario root '${root}' is claimed by both '${m.get(root)}' and '${leg.key}'`);
      }
      m.set(root, leg.key);
    }
  }
  return m;
})();

/** `scenarios.frameBudget.N8` → `frameBudget`. Null for anything else. */
export function scenarioRoot(scenarioPath) {
  const parts = String(scenarioPath ?? '').split('.');
  if (parts[0] !== 'scenarios' || parts.length < 2 || !parts[1]) return null;
  return parts[1];
}

/** Leg key for a gate (from GATES or BOOL_GATES), or null if unmapped. */
export function legForGate(gate) {
  const root = scenarioRoot(gate?.scenarioPath);
  return root == null ? null : (LEG_BY_ROOT.get(root) ?? null);
}

/**
 * perf-bench flags that run exactly `legKeys` and nothing else — i.e. the skip
 * flags of every other leg, in LEGS order so the argv is stable and diffable.
 */
export function benchArgsForLegs(legKeys) {
  const wanted = new Set(legKeys);
  for (const key of wanted) {
    if (!LEGS.some((l) => l.key === key)) throw new Error(`perf-legs: unknown leg '${key}'`);
  }
  const args = [];
  for (const leg of LEGS) if (!wanted.has(leg.key)) args.push(...leg.skipFlags);
  return args;
}

/**
 * Flags that reproduce the ORIGINAL run's knobs, read back from its meta.
 *
 * A retry at different sample counts, a different N sweep or a different
 * scrollback seed is a different measurement, and "did it reproduce?" would
 * then be answering a question nobody asked. Everything is passed explicitly
 * rather than leaning on the mode presets, so a future change to a default
 * cannot silently make the retry incomparable to the run it is confirming.
 */
export function benchArgsForConfig(meta) {
  const cfg = meta?.config ?? {};
  const args = ['--mode', meta?.mode === 'ci' ? 'ci' : 'local'];
  const int = (v) => (typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : null);
  const list = (v) =>
    Array.isArray(v) && v.length > 0 && v.every((n) => Number.isInteger(n) && n > 0) ? v.join(',') : null;

  if (int(cfg.coldRuns)) args.push('--cold-runs', String(cfg.coldRuns));
  if (int(cfg.inputSamples)) args.push('--samples', String(cfg.inputSamples));
  if (int(cfg.inputSamples8)) args.push('--samples8', String(cfg.inputSamples8));
  // null = the app default was left untouched, which is NOT the same as seeding
  // a number, so only a real number is forwarded.
  if (int(cfg.scrollbackLines)) args.push('--scrollback-lines', String(cfg.scrollbackLines));
  if (list(cfg.frameBudgetPanes)) args.push('--frame-budget-panes', list(cfg.frameBudgetPanes));
  if (list(cfg.hiddenFloodAgents)) args.push('--hidden-flood-agents', list(cfg.hiddenFloodAgents));
  if (cfg.hiddenRetention === true) args.push('--hidden-retention');
  return args;
}

/**
 * What a confirmation re-run has to measure: the legs behind the failing gates,
 * and the argv that measures exactly those.
 *
 * `unmappedGateKeys` is returned rather than thrown: a gate whose scenario
 * belongs to no leg cannot be confirmed, and the honest answer is to leave the
 * original red standing — perf-confirm refuses to clear a run that has any.
 *
 * This is built in-process by perf-confirm from the run's own files. It is
 * deliberately not written anywhere: a file describing which gates failed can
 * outlive the run it describes, and re-running the wrong gates could clear a
 * red that is still real.
 */
export function buildRetryPlan({ failedKeys, gates, meta }) {
  const byKey = new Map(gates.map((g) => [g.key, g]));
  const legs = new Set();
  const unmapped = [];
  for (const key of failedKeys) {
    const gate = byKey.get(key);
    const leg = gate ? legForGate(gate) : null;
    if (!leg) unmapped.push(key);
    else legs.add(leg);
  }
  const legList = LEGS.filter((l) => legs.has(l.key)).map((l) => l.key);
  return {
    failedGateKeys: [...failedKeys],
    unmappedGateKeys: unmapped,
    legs: legList,
    benchArgs: [...benchArgsForConfig(meta), ...benchArgsForLegs(legList)],
  };
}
