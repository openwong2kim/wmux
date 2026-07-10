// Pure-logic tests for the A1 perf gate (scripts/perf-compare.mjs). No
// packaged app, no network, no pipes — collected by `npm test` via the vitest
// include pattern scripts/__tests__/**/*.test.mjs and safe on CI.
import { describe, it, expect } from 'vitest';
import {
  compareResults,
  getPath,
  detectThrottled,
  hasFailure,
  GATES,
  SCHEMA_VERSION,
} from '../perf-compare.mjs';

// Minimal but schema-shaped result builder. Pass overrides for the metrics we
// care about; everything else gets benign defaults so the gate has numbers.
function makeResult(overrides = {}) {
  const o = {
    coldFirstPtyDataMs: 500,
    echoP95: 8,
    frameP95: 8,
    frame8P95: 12,
    ramIdle: 200 * 1024 * 1024,
    ram8: 400 * 1024 * 1024,
    // W2 frameBudget p95s (one per gated N) — present so the "equal baseline ==
    // all PASS" invariant holds now that GATES includes the frameBudget entries.
    frameBudgetN4: 20,
    frameBudgetN8: 28,
    frameBudgetN16: 40,
    // hiddenFlood (hidden-workspace agents + focused typing) — same invariant.
    hiddenFloodEchoN4: 15,
    hiddenFloodFrameDeltaN4: 20,
    hiddenFloodEchoN8: 25,
    hiddenFloodFrameDeltaN8: 30,
    schemaVersion: SCHEMA_VERSION,
    throttled: false,
    throttled8: false,
    ...overrides,
  };
  return {
    schemaVersion: o.schemaVersion,
    meta: { appVersion: '3.1.1', commit: 'abc1234', mode: 'ci', cpuModel: 'Test CPU' },
    scenarios: {
      coldStart: { median: { firstPtyDataMs: o.coldFirstPtyDataMs } },
      inputLatency: {
        throttled: o.throttled,
        echoMs: { p95: o.echoP95 },
        frameMs: { p95: o.frameP95 },
      },
      inputLatency8: {
        throttled: o.throttled8,
        echoMs: { p95: o.echoP95 },
        frameMs: { p95: o.frame8P95 },
      },
      ram: {
        idle1Pane: { workingSetBytes: o.ramIdle },
        panes8: { workingSetBytes: o.ram8 },
      },
      frameBudget: {
        N4: { frameDeltaMs: { p95: o.frameBudgetN4 } },
        N8: { frameDeltaMs: { p95: o.frameBudgetN8 } },
        N16: { frameDeltaMs: { p95: o.frameBudgetN16 } },
      },
      hiddenFlood: {
        N4: {
          echoMs: { p95: o.hiddenFloodEchoN4 },
          frameDeltaMs: { p95: o.hiddenFloodFrameDeltaN4 },
        },
        N8: {
          echoMs: { p95: o.hiddenFloodEchoN8 },
          frameDeltaMs: { p95: o.hiddenFloodFrameDeltaN8 },
        },
      },
    },
  };
}

function verdictFor(results, key) {
  const r = results.find((x) => x.key === key);
  if (!r) throw new Error(`no result for ${key}`);
  return r;
}

describe('getPath', () => {
  it('resolves nested paths and reports absence as undefined', () => {
    const obj = { a: { b: { c: 1 } } };
    expect(getPath(obj, 'a.b.c')).toBe(1);
    expect(getPath(obj, 'a.b.x')).toBeUndefined();
    expect(getPath(obj, 'a.x.c')).toBeUndefined();
    expect(getPath(null, 'a')).toBeUndefined();
  });

  it('returns null distinctly from undefined', () => {
    expect(getPath({ a: null }, 'a')).toBeNull();
  });
});

describe('compareResults — passing within bounds', () => {
  it('PASSES when current equals baseline', () => {
    const base = makeResult();
    const cur = makeResult();
    const results = compareResults(cur, base, GATES);
    expect(hasFailure(results)).toBe(false);
    for (const r of results) expect(r.status).toBe('PASS');
  });

  it('PASSES a modest regression that exceeds neither condition', () => {
    // echo: baseline 8 -> current 11. 11 < 8*1.5 (12) and 11 < 8+10 (18). PASS.
    const base = makeResult({ echoP95: 8 });
    const cur = makeResult({ echoP95: 11 });
    expect(verdictFor(compareResults(cur, base), 'echoP95Ms').status).toBe('PASS');
  });
});

describe('compareResults — double-condition gate (ratio AND abs)', () => {
  it('PASSES when only the ratio is exceeded but not the abs margin', () => {
    // echo baseline 4 -> current 9. 9 > 4*1.5 (6) ratio-fail, but 9 < 4+10 (14).
    // Only one condition tripped → PASS (small-baseline noise protection).
    const base = makeResult({ echoP95: 4 });
    const cur = makeResult({ echoP95: 9 });
    expect(verdictFor(compareResults(cur, base), 'echoP95Ms').status).toBe('PASS');
  });

  it('PASSES when only the abs margin is exceeded but not the ratio', () => {
    // ram idle baseline 1000MiB -> current 1110MiB. abs: +110MiB > 100MiB margin,
    // but ratio: 1110 < 1000*1.3 (1300). Only one condition → PASS.
    const base = makeResult({ ramIdle: 1000 * 1024 * 1024 });
    const cur = makeResult({ ramIdle: 1110 * 1024 * 1024 });
    expect(verdictFor(compareResults(cur, base), 'ramIdleBytes').status).toBe('PASS');
  });

  it('FAILS only when BOTH ratio and abs margin are exceeded', () => {
    // echo baseline 20 -> current 35. 35 > 20*1.5 (30) AND 35 > 20+10 (30). FAIL.
    const base = makeResult({ echoP95: 20 });
    const cur = makeResult({ echoP95: 35 });
    const results = compareResults(cur, base);
    expect(verdictFor(results, 'echoP95Ms').status).toBe('FAIL');
    expect(hasFailure(results)).toBe(true);
  });

  it('FAILS a large RAM regression past both thresholds', () => {
    // idle baseline 300MiB -> current 500MiB. abs +200MiB > 100MiB AND ratio
    // 500 > 300*1.3 (390). FAIL.
    const base = makeResult({ ramIdle: 300 * 1024 * 1024 });
    const cur = makeResult({ ramIdle: 500 * 1024 * 1024 });
    expect(verdictFor(compareResults(cur, base), 'ramIdleBytes').status).toBe('FAIL');
  });
});

describe('compareResults — strict > boundary (not >=)', () => {
  it('PASSES exactly at the ratio*abs boundary (equality is not a failure)', () => {
    // baseline 20 -> current exactly 30. 30 > 30 is false on both conditions.
    const base = makeResult({ echoP95: 20 });
    const cur = makeResult({ echoP95: 30 });
    expect(verdictFor(compareResults(cur, base), 'echoP95Ms').status).toBe('PASS');
  });

  it('FAILS one unit past the boundary', () => {
    const base = makeResult({ echoP95: 20 });
    const cur = makeResult({ echoP95: 30.001 });
    expect(verdictFor(compareResults(cur, base), 'echoP95Ms').status).toBe('FAIL');
  });
});

describe('compareResults — missing current metric', () => {
  it('FAILS when baseline has the metric but current dropped the whole scenario', () => {
    const base = makeResult();
    const cur = makeResult();
    delete cur.scenarios.inputLatency; // silently skipped scenario
    const results = compareResults(cur, base);
    expect(verdictFor(results, 'echoP95Ms').status).toBe('FAIL');
    expect(verdictFor(results, 'frameP95Ms').status).toBe('FAIL');
    expect(hasFailure(results)).toBe(true);
  });

  it('FAILS when current metric is explicitly null but baseline has a number', () => {
    const base = makeResult();
    const cur = makeResult();
    cur.scenarios.coldStart.median.firstPtyDataMs = null;
    expect(verdictFor(compareResults(cur, base), 'coldFirstPtyDataMs').status).toBe('FAIL');
  });

  it('SKIPS (does not FAIL) when the scenario is absent in BOTH baseline and current', () => {
    const base = makeResult();
    const cur = makeResult();
    delete base.scenarios.inputLatency8;
    delete cur.scenarios.inputLatency8;
    const results = compareResults(cur, base);
    expect(verdictFor(results, 'frame8P95Ms').status).toBe('SKIP');
    expect(hasFailure(results)).toBe(false);
  });
});

describe('compareResults — missing baseline metric is NEW not FAIL', () => {
  it('marks a metric present in current but absent in baseline as NEW', () => {
    const base = makeResult();
    const cur = makeResult();
    delete base.scenarios.inputLatency8; // baseline never measured 8-pane
    const results = compareResults(cur, base);
    const r = verdictFor(results, 'frame8P95Ms');
    expect(r.status).toBe('NEW');
    expect(hasFailure(results)).toBe(false);
  });

  it('treats an entirely null baseline (record-only) as all NEW/SKIP, never FAIL', () => {
    const cur = makeResult();
    const results = compareResults(cur, null);
    expect(hasFailure(results)).toBe(false);
    for (const r of results) expect(['NEW', 'SKIP']).toContain(r.status);
  });
});

describe('compareResults — improvement flag', () => {
  it('flags an improvement when current < baseline * 0.8', () => {
    // echo baseline 20 -> current 10 (= 0.5x). improved.
    const base = makeResult({ echoP95: 20 });
    const cur = makeResult({ echoP95: 10 });
    const r = verdictFor(compareResults(cur, base), 'echoP95Ms');
    expect(r.status).toBe('PASS');
    expect(r.improved).toBe(true);
    expect(r.note).toMatch(/refresh/i);
  });

  it('does not flag improvement at exactly the 0.8 boundary', () => {
    // 20 * 0.8 = 16, current 16 -> 16 < 16 is false.
    const base = makeResult({ echoP95: 20 });
    const cur = makeResult({ echoP95: 16 });
    const r = verdictFor(compareResults(cur, base), 'echoP95Ms');
    expect(r.improved).toBe(false);
  });
});

describe('schemaVersion handling', () => {
  it('exports schema version 1', () => {
    expect(SCHEMA_VERSION).toBe(1);
  });

  // The CLI converts a schema mismatch into a record-only run by passing a null
  // baseline to compareResults; verify the downstream behaviour here.
  it('with a null baseline (the record-only substitute) produces no failures', () => {
    const cur = makeResult({ schemaVersion: 2 });
    const results = compareResults(cur, null);
    expect(hasFailure(results)).toBe(false);
  });
});

describe('detectThrottled', () => {
  it('returns the scenarios that reported throttling', () => {
    const cur = makeResult({ throttled: true, throttled8: false });
    expect(detectThrottled(cur)).toEqual(['inputLatency']);
  });

  it('returns empty when nothing throttled', () => {
    expect(detectThrottled(makeResult())).toEqual([]);
  });

  it('does not affect gating — echo is still compared when throttled', () => {
    // throttled:true should not auto-fail; a clean echo still PASSES.
    const base = makeResult();
    const cur = makeResult({ throttled: true });
    const results = compareResults(cur, base);
    expect(verdictFor(results, 'echoP95Ms').status).toBe('PASS');
  });
});
