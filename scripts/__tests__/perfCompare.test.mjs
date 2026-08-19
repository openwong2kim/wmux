// Pure-logic tests for the A1 perf gate (scripts/perf-compare.mjs). No
// packaged app, no network, no pipes — collected by `npm test` via the vitest
// include pattern scripts/__tests__/**/*.test.mjs and safe on CI.
import { describe, it, expect } from 'vitest';
import {
  compareResults,
  getPath,
  detectThrottled,
  hasFailure,
  historyLine,
  tailRegressionNote,
  evaluateRun,
  BOOL_GATES,
  GATES,
  SCHEMA_VERSION,
} from '../perf-compare.mjs';

// Minimal but schema-shaped result builder. Pass overrides for the metrics we
// care about; everything else gets benign defaults so the gate has numbers.
function makeResult(overrides = {}) {
  const o = {
    coldFirstPtyDataMs: 500,
    // The gated estimator (#650). Defaults to the median so a test that only
    // moves `coldFirstPtyDataMs` still moves the number the gate reads.
    coldFirstPtyDataBestMs: undefined,
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
      coldStart: {
        median: { firstPtyDataMs: o.coldFirstPtyDataMs },
        best: {
          firstPtyDataMs:
            o.coldFirstPtyDataBestMs === undefined ? o.coldFirstPtyDataMs : o.coldFirstPtyDataBestMs,
        },
      },
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

describe('compareResults — frame-margin gate on the quantized W2 family (#940)', () => {
  // frameDeltaMs.p95 lands in clusters one frame interval apart. These are the
  // five distinct values the last 25 `main` records took, judged against the
  // blessed 1-frame baseline. The gate's interval is FRAME_INTERVAL_MS = 15.7,
  // the top of the one-frame cluster — see the cluster-width case below for
  // why it is not the 15.625 ms tick these numbers come from physically.
  const gateOf = (p95, basep95 = 15.7) =>
    verdictFor(
      compareResults(makeResult({ frameBudgetN16: p95 }), makeResult({ frameBudgetN16: basep95 })),
      'frameBudgetP95Ms_N16',
    );

  it('keeps every verdict the 25 real `main` records already had', () => {
    expect(gateOf(15.7).status).toBe('PASS');   // 1 frame  — 12 records
    expect(gateOf(31.2).status).toBe('PASS');   // 2 frames — 8 records
    expect(gateOf(31.3).status).toBe('PASS');   // 2 frames
    expect(gateOf(46.8).status).toBe('FAIL');   // 3 frames — 4 records
    expect(gateOf(78.1).status).toBe('FAIL');   // 5 frames — 1 record
  });

  it('still trips on the dropped-frame step the original calibration named', () => {
    // The pre-#940 comment on this gate was written around 33.3 ms tripping
    // `2.0x + 8ms`. It has to keep tripping, or this is a loosening, not a
    // reshaping. 37.1 is the value perfConfirm's fixtures use for the same job.
    expect(gateOf(33.3).status).toBe('FAIL');
    expect(gateOf(37.1).status).toBe('FAIL');
  });

  it('allows exactly one frame above the baseline, and no more', () => {
    expect(gateOf(15.7 + 15.7).status).toBe('PASS');         // exactly +1 frame
    expect(gateOf(15.7 + 15.71).status).toBe('FAIL');        // a hair past it
  });

  it('clears the whole width of the two-frame cluster', () => {
    // The quanta are clusters, not points: across all 216 bench-history
    // records the two-frame samples span 31.1-31.4 and the three-frame ones
    // 46.8-47.0. The threshold has to sit in the gap, so the top of the
    // two-frame cluster passes and the bottom of the three-frame one fails.
    // A frame interval of 15.625 (the Windows timer tick these numbers come
    // from) would put it at 31.325 and flip the two real 31.4 records.
    expect(gateOf(31.1).status).toBe('PASS');
    expect(gateOf(31.4).status).toBe('PASS');
    expect(gateOf(46.8).status).toBe('FAIL');
    expect(gateOf(47.0).status).toBe('FAIL');
  });

  it('drifts linearly with the baseline, where the ratio drifted multiplicatively', () => {
    // The behaviour change, stated as a before/after rather than asserted as
    // equivalent. Baseline blessed from a 2-frame run (31.3):
    //   old rule: FAIL needs cur > 31.3*2 (62.6) AND cur > 31.3+8 — so a
    //             4-frame sample at 62.5 PASSED, i.e. blessing a bad baseline
    //             doubled the allowance to 4 frames.
    //   new rule: FAIL needs cur > 31.3 + 15.7 (47.0) — 3 frames is the most
    //             it can reach, whatever the baseline is blessed at.
    const oldRuleWouldPass = 62.5 > 31.3 * 2.0 && 62.5 > 31.3 + 8;
    expect(oldRuleWouldPass).toBe(false);                    // the old gate let it through
    expect(gateOf(62.5, 31.3).status).toBe('FAIL');          // the new one does not
    expect(gateOf(46.8, 31.3).status).toBe('PASS');          // 3 frames still allowed
  });

  it('names the frame margin in the note, not a ratio', () => {
    const r = gateOf(78.1);
    expect(r.note).toContain('frame interval');
    expect(r.note).not.toContain('2x');
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
    cur.scenarios.coldStart.best.firstPtyDataMs = null; // no boot produced a number
    expect(verdictFor(compareResults(cur, base), 'coldFirstPtyDataBestMs').status).toBe('FAIL');
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

// The 2026-07-27 false red: a windows-latest runner degraded for the whole job
// (2.2s to spawn the daemon process, 2.0s to take a file lock) put the median at
// 2470ms against a 1207ms baseline on a commit that only widened web pairing
// codes. The confirmation re-run lands on the same runner, so it reproduced.
describe('compareResults — cold start gates the fastest boot (#650)', () => {
  it('PASSES a job-wide slow runner where the median alone would have failed', () => {
    // Real numbers from run 30254659860: boots 1442 / 9154 / 2470ms.
    const base = makeResult({ coldFirstPtyDataMs: 1207, coldFirstPtyDataBestMs: 1134 });
    const cur = makeResult({ coldFirstPtyDataMs: 2470, coldFirstPtyDataBestMs: 1442 });
    const r = verdictFor(compareResults(cur, base), 'coldFirstPtyDataBestMs');
    expect(r.status).toBe('PASS');
    expect(r.current).toBe(1442);
  });

  it('still FAILS a regression that slows every boot', () => {
    const base = makeResult({ coldFirstPtyDataMs: 1207, coldFirstPtyDataBestMs: 1134 });
    const cur = makeResult({ coldFirstPtyDataMs: 2600, coldFirstPtyDataBestMs: 2500 });
    expect(verdictFor(compareResults(cur, base), 'coldFirstPtyDataBestMs').status).toBe('FAIL');
  });

  it('reads the baseline median when the baseline predates best-of-N, rather than going NEW', () => {
    const base = makeResult({ coldFirstPtyDataMs: 1207 });
    delete base.scenarios.coldStart.best; // baseline blessed before the estimator moved
    const cur = makeResult({ coldFirstPtyDataMs: 2600, coldFirstPtyDataBestMs: 2500 });
    const r = verdictFor(compareResults(cur, base), 'coldFirstPtyDataBestMs');
    expect(r.status).toBe('FAIL'); // NEW here would mean the metric stopped being gated
    expect(r.baseline).toBe(1207);
    expect(r.baselineFallback).toBe(true);
    expect(r.note).toMatch(/fix the regression first/i); // never "re-bless" on a red
  });

  it('suppresses the improvement flag under fallback — best vs median is not an improvement', () => {
    // current best 950 < baseline median 1207 * 0.8: would flag improved on a
    // same-estimator comparison, but here the drop is the estimator change.
    const base = makeResult({ coldFirstPtyDataMs: 1207 });
    delete base.scenarios.coldStart.best;
    const cur = makeResult({ coldFirstPtyDataMs: 1000, coldFirstPtyDataBestMs: 950 });
    const r = verdictFor(compareResults(cur, base), 'coldFirstPtyDataBestMs');
    expect(r.status).toBe('PASS');
    expect(r.improved).toBe(false);
    expect(r.note).toMatch(/re-bless/i); // a green fallback does say re-bless
  });
});

describe('tailRegressionNote — what best-of-N stops failing on', () => {
  it('reports a median regression the gate let through', () => {
    const base = makeResult({ coldFirstPtyDataMs: 1207, coldFirstPtyDataBestMs: 1134 });
    const cur = makeResult({ coldFirstPtyDataMs: 2470, coldFirstPtyDataBestMs: 1442 });
    const note = tailRegressionNote(cur, base);
    expect(note).toMatch(/median regressed/);
    // Reported, not enforced — the gate result stays green.
    expect(hasFailure(compareResults(cur, base))).toBe(false);
  });

  it('says nothing when the median is within bounds', () => {
    const base = makeResult({ coldFirstPtyDataMs: 1207, coldFirstPtyDataBestMs: 1134 });
    const cur = makeResult({ coldFirstPtyDataMs: 1300, coldFirstPtyDataBestMs: 1200 });
    expect(tailRegressionNote(cur, base)).toBeNull();
  });

  it('says nothing when the gate itself went red — the FAIL already covers it', () => {
    const base = makeResult({ coldFirstPtyDataMs: 1207, coldFirstPtyDataBestMs: 1134 });
    const cur = makeResult({ coldFirstPtyDataMs: 2600, coldFirstPtyDataBestMs: 2500 });
    expect(tailRegressionNote(cur, base)).toBeNull();
  });

  it('says nothing without a baseline', () => {
    expect(tailRegressionNote(makeResult(), null)).toBeNull();
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

describe('historyLine — the trend record (#602)', () => {
  const meta = { commit: 'abc1234', mode: 'ci', appVersion: '3.33.0' };
  const record = (overrides) => JSON.parse(historyLine(makeResult(overrides), meta));

  // The invariant that keeps #602 from recurring. The hiddenFlood gates shipped
  // with no trend fields because the field list was a hand-copied second list;
  // now it is derived, and this fails the moment the two drift apart again.
  it('records a field for every gated metric', () => {
    const rec = record();
    for (const g of [...GATES, ...BOOL_GATES]) {
      expect(Object.hasOwn(rec, g.key), `no trend field for gate ${g.label}`).toBe(true);
    }
  });

  // Pins that the record IS the gate tables rather than a list that merely
  // happens to agree with them today — a hand-added field breaks this first.
  it('is the run identity followed by the two gate tables, in their order', () => {
    expect(Object.keys(record())).toEqual([
      'ts', 'commit', 'mode', 'appVersion',
      ...GATES.map((g) => g.key),
      ...BOOL_GATES.map((g) => g.key),
    ]);
  });

  // Field names are the series identity for lines already accumulated. Renaming
  // a gate key silently forks the series, so pin the pre-#602 names explicitly.
  //
  // One deliberate fork so far (#650): the cold-start gate moved from the
  // median to the fastest boot, and `coldFirstPtyDataMs` — a median series
  // since the trend began — must NOT continue under the new estimator. That
  // series ends; `coldFirstPtyDataBestMs` starts. Both directions are pinned
  // below: the ended name stays gone (reintroducing it would splice best-of-N
  // values into a median column) and the new name exists.
  it('keeps the field names the pre-#602 lines already use', () => {
    const rec = record();
    for (const name of [
      'echoP95Ms', 'frameP95Ms', 'frame8P95Ms',
      'ramIdleBytes', 'ram8Bytes',
      'frameBudgetP95Ms_N4', 'frameBudgetP95Ms_N8', 'frameBudgetP95Ms_N16',
      'imePass', 'webglContextLossPass',
    ]) {
      expect(Object.hasOwn(rec, name), `dropped legacy trend field ${name}`).toBe(true);
    }
  });

  it('the cold-start series fork (#650) is explicit: old name ended, new name live', () => {
    const rec = record();
    expect(Object.hasOwn(rec, 'coldFirstPtyDataMs'), 'coldFirstPtyDataMs ended at #650 — reusing it would mix estimators in one series').toBe(false);
    expect(Object.hasOwn(rec, 'coldFirstPtyDataBestMs')).toBe(true);
  });

  it('records the four hiddenFlood values that were missing entirely', () => {
    const rec = record({
      hiddenFloodEchoN4: 21.6, hiddenFloodFrameDeltaN4: 15.7,
      hiddenFloodEchoN8: 29.4, hiddenFloodFrameDeltaN8: 15.8,
    });
    expect(rec.hiddenFloodEchoP95Ms_N4).toBe(21.6);
    expect(rec.hiddenFloodFrameDeltaP95Ms_N4).toBe(15.7);
    expect(rec.hiddenFloodEchoP95Ms_N8).toBe(29.4);
    expect(rec.hiddenFloodFrameDeltaP95Ms_N8).toBe(15.8);
  });

  it('carries the run identity so a line can be traced back to its commit', () => {
    const rec = record();
    expect(rec.commit).toBe('abc1234');
    expect(rec.mode).toBe('ci');
    expect(rec.appVersion).toBe('3.33.0');
    expect(Number.isFinite(Date.parse(rec.ts))).toBe(true);
  });

  it('records a metric the run never produced as null, not as a missing field', () => {
    // A skipped scenario must still occupy its column — an absent key would read
    // as "this gate did not exist yet" to anyone plotting the series.
    const cur = makeResult();
    delete cur.scenarios.ram;
    const rec = JSON.parse(historyLine(cur, meta));
    expect(rec.ramIdleBytes).toBeNull();
    expect(rec.ram8Bytes).toBeNull();
  });

  it('records the boolean gates as pass / fail / skipped', () => {
    const withIme = (ime) => {
      const cur = makeResult();
      if (ime !== undefined) cur.scenarios.ime = ime;
      return JSON.parse(historyLine(cur, meta));
    };
    expect(withIme({ pass: true }).imePass).toBe(true);
    expect(withIme({ pass: false }).imePass).toBe(false);
    // makeResult() has no ime scenario at all — skipped, not failed.
    expect(withIme(undefined).imePass).toBeNull();
  });
});

// evaluateRun is the comparison half of the gate, exported so the confirmation
// re-run (#570) judges a retry with exactly the code that judged the run.
describe('evaluateRun', () => {
  const baseline = makeResult();

  it('produces the same verdict the gate exits on', () => {
    const green = evaluateRun(makeResult(), baseline);
    expect(green.recordOnly).toBe(false);
    expect(hasFailure(green.results)).toBe(false);
    const red = evaluateRun(makeResult({ ram8: 4000 * 1024 * 1024 }), baseline);
    expect(hasFailure(red.results)).toBe(true);
    expect(red.results.filter((r) => r.status === 'FAIL').map((r) => r.key)).toEqual(['ram8Bytes']);
  });

  it('drops to record-only on a schemaVersion mismatch, and compares against nothing', () => {
    const out = evaluateRun(makeResult({ schemaVersion: SCHEMA_VERSION + 1 }), baseline);
    expect(out.recordOnly).toBe(true);
    expect(out.baseline).toBeNull();
    expect(hasFailure(out.results)).toBe(false);
  });

  it('leaves "was a baseline supplied at all" to its caller', () => {
    // main() decides record-only for the IO cases (no --baseline, unreadable
    // file) and evaluateRun only for the schema mismatch. Moving that decision
    // in here would change what a baseline file containing `null` means — see
    // the next test.
    expect(evaluateRun(makeResult(), null).recordOnly).toBe(false);
  });

  it('still enforces the boolean gates when the baseline parses to null', () => {
    // A baseline file whose contents are literally `null` reads fine, so it is
    // NOT the record-only bootstrap path: the numeric gates have nothing to
    // compare against, but the baseline-independent correctness gates enforce
    // exactly as they always have. Pinned because this is the one behaviour a
    // careless refactor of the record-only rules silently flips to green.
    const cur = makeResult();
    cur.scenarios.ime = { pass: false };
    const out = evaluateRun(cur, null);
    expect(out.recordOnly).toBe(false);
    expect(hasFailure(out.results)).toBe(true);
    expect(out.results.filter((r) => r.status === 'FAIL').map((r) => r.key)).toEqual(['imePass']);
  });
});
