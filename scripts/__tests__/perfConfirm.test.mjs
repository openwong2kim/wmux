// Tests for the confirmation re-run's decision path (#570). The bench spawn and
// every file touch are injected for the unit cases, so this exercises the real
// orchestration without a packaged app; the path guards and the end-to-end gate
// run against a real filesystem, because that is where they can be defeated.
import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  UnconfirmableError,
  planFromResults,
  claimRetryTarget,
  judgeRetry,
  runConfirmation,
  confirmGate,
  renderConfirmationMarkdown,
} from '../perf-confirm.mjs';
import { evaluateRun } from '../perf-compare.mjs';
import { fileIdentity } from '../perf-paths.mjs';

const CURRENT = 'fixture/perf-current.json';
const BASELINE = 'fixture/baseline-ci.json';
const RETRY = 'fixture/perf-retry.json';

// Only the paths the gates under test read. `null` means the scenario is
// ABSENT from the result, which is what a leg that did not run looks like.
function result({
  frameBudgetN8 = 15.7,
  ram8 = 400 * 1024 * 1024,
  ime = { pass: true },
  commit = 'abc1234',
  schemaVersion = 1,
} = {}) {
  const scenarios = {};
  if (ime !== null) scenarios.ime = ime;
  if (frameBudgetN8 !== null) scenarios.frameBudget = { N8: { frameDeltaMs: { p95: frameBudgetN8 } } };
  if (ram8 !== null) scenarios.ram = { panes8: { workingSetBytes: ram8 } };
  return {
    schemaVersion,
    meta: { commit, mode: 'ci', config: { coldRuns: 3, inputSamples: 80, inputSamples8: 40, frameBudgetPanes: [4, 8, 16], hiddenFloodAgents: [4, 8] } },
    scenarios,
  };
}

/** The gate's own verdict for a pair of results — what perf-compare hands over. */
function verdictOf(current, baseline = result()) {
  return evaluateRun(current, baseline).results;
}

function depsFor({ files = {}, bytes = {}, benchStatus = 0, onBench, identify } = {}) {
  const store = { ...bytes };
  const logs = [];
  const releaseClaim = vi.fn();
  const deps = {
    readBytes: vi.fn((f) => (f in store ? store[f] : null)),
    writeBytes: vi.fn((f, b) => { store[f] = b; }),
    remove: vi.fn((f) => { delete store[f]; }),
    runBench: vi.fn((args) => {
      if (onBench) onBench({ args, store, files });
      return benchStatus;
    }),
    // The real claim runs against a real filesystem below; here it would only
    // create files for paths that do not exist.
    claimRetryTarget: vi.fn((retry) => ({
      identity: 'claimed-id',
      readBytes: vi.fn(() => {
        if (retry in files) return Buffer.from(JSON.stringify(files[retry]));
        if (retry in store) return store[retry];
        throw new Error(`could not read '${retry}'`);
      }),
      release: releaseClaim,
    })),
    identify: vi.fn(identify ?? (() => 'claimed-id')),
    log: (m) => logs.push(m),
  };
  return { deps, logs, store, releaseClaim };
}

describe('planFromResults', () => {
  const meta = result().meta;

  it('re-runs the legs behind the failing measurements', () => {
    const plan = planFromResults(verdictOf(result({ frameBudgetN8: 60 })), meta);
    expect(plan.failedGateKeys).toEqual(['frameBudgetP95Ms_N8']);
    expect(plan.legs).toEqual(['w2']);
  });

  it('refuses when nothing is failing', () => {
    expect(() => planFromResults(verdictOf(result()), meta)).toThrow(/no failing gate/);
  });

  it('refuses to confirm a correctness gate, so its red stands without a re-run', () => {
    // ime.pass / webglContextLoss.pass are a consistency check, not a
    // tail-prone measurement: "it worked the second time" is not a reason to
    // ship a broken one, and re-running would spend CI time for the same answer.
    expect(() => planFromResults(verdictOf(result({ ime: { pass: false } })), meta))
      .toThrow(/correctness check, not a measurement/);
  });

  it('refuses the whole red when a correctness gate fails alongside a measurement', () => {
    expect(() => planFromResults(verdictOf(result({ ime: { pass: false }, frameBudgetN8: 60 })), meta))
      .toThrow(/correctness check/);
  });

  it('collects every failing leg, not just the first', () => {
    const plan = planFromResults(verdictOf(result({ frameBudgetN8: 60, ram8: 4000 * 1024 * 1024 })), meta);
    expect(plan.legs).toEqual(['a1', 'w2']);
  });

  it('refuses a gate that belongs to no leg', () => {
    expect(() => planFromResults([{ key: 'futureGate', status: 'FAIL' }], meta)).toThrow(/belong to no bench leg/);
  });
});

describe('claimRetryTarget', () => {
  function tmp(fn) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'perf-guard-'));
    try {
      const current = path.join(dir, 'perf-current.json');
      const baseline = path.join(dir, 'baseline-ci.json');
      fs.writeFileSync(current, '{"schemaVersion":1}');
      fs.writeFileSync(baseline, '{"schemaVersion":1}');
      return fn({ dir, current, baseline });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  it('creates a fresh target and returns its identity', () => {
    tmp(({ dir, current, baseline }) => {
      const retry = path.join(dir, 'perf-retry.json');
      const claim = claimRetryTarget(retry, current, baseline);
      try {
        expect(fs.existsSync(retry)).toBe(true);
        expect(typeof claim.identity).toBe('string');
        // perf-bench truncates the claimed path with writeFileSync. Keeping the
        // original handle open must not prevent that normal Windows write.
        fs.writeFileSync(retry, '{"measured":true}');
        expect(fs.readFileSync(retry, 'utf8')).toBe('{"measured":true}');
        expect(fileIdentity(retry)).toBe(claim.identity);
        const checkFd = fs.openSync(retry, 'r');
        try {
          const stats = fs.fstatSync(checkFd, { bigint: true });
          expect(claim.identity).toBe(`${stats.dev}:${stats.ino}`);
        } finally {
          fs.closeSync(checkFd);
        }
        expect(claim.readBytes().toString('utf8')).toBe('{"measured":true}');
      } finally {
        claim.release();
      }
    });
  });

  it('refuses the result file and the baseline by name', () => {
    tmp(({ current, baseline }) => {
      expect(() => claimRetryTarget(current, current, baseline)).toThrow(/would write over/);
      expect(() => claimRetryTarget(baseline, current, baseline)).toThrow(/would write over/);
    });
  });

  it.runIf(process.platform === 'win32')('refuses an extended-length path spelling of the same file', () => {
    // `\\?\C:\...` and `C:\...` are the same file and different strings, so a
    // resolve-and-compare guard alone lets it through.
    tmp(({ current, baseline }) => {
      expect(() => claimRetryTarget(`\\\\?\\${path.resolve(current)}`, current, baseline))
        .toThrow(UnconfirmableError);
    });
  });

  it('refuses a hard link to the original', () => {
    tmp(({ dir, current, baseline }) => {
      const link = path.join(dir, 'perf-retry.json');
      try {
        fs.linkSync(current, link);
      } catch {
        return; // filesystem without hard links — nothing to assert
      }
      expect(() => claimRetryTarget(link, current, baseline)).toThrow(/hard link/);
    });
  });

  it('refuses an existing target rather than deleting it', () => {
    // A path typo is the likely way this is ever wrong, and clearing whatever
    // sits there would turn a typo into data loss.
    tmp(({ dir, current, baseline }) => {
      const bystander = path.join(dir, 'notes.txt');
      fs.writeFileSync(bystander, 'do not delete me');
      expect(() => claimRetryTarget(bystander, current, baseline)).toThrow(/already exists/);
      expect(fs.readFileSync(bystander, 'utf8')).toBe('do not delete me');
    });
  });
});

describe('judgeRetry', () => {
  const baseline = result();

  it('clears the gate when the metric comes back within bounds', () => {
    const out = judgeRetry(result(), baseline, ['frameBudgetP95Ms_N8']);
    expect(out.reproduced).toBe(false);
    expect(out.verdicts.every((v) => v.status === 'PASS')).toBe(true);
  });

  it('keeps the gate red when the metric fails again', () => {
    const out = judgeRetry(result({ frameBudgetN8: 60 }), baseline, ['frameBudgetP95Ms_N8']);
    expect(out.reproduced).toBe(true);
    expect(out.unresolved.map((v) => v.key)).toEqual(['frameBudgetP95Ms_N8']);
  });

  it('keeps the red when the re-run breaks a correctness check that had passed', () => {
    // The w2 leg re-runs ime alongside frameBudget. A consistency check that
    // fails there is a failure whichever run surfaced it, so "the metric we
    // asked about came back fine" must not clear the job.
    const out = judgeRetry(result({ ime: { pass: false } }), baseline, ['frameBudgetP95Ms_N8']);
    expect(out.reproduced).toBe(true);
    expect(out.unresolved.map((v) => v.key)).toEqual(['imePass']);
  });

  it('refuses to clear when a sibling scenario measured on the first run disappears', () => {
    // The selected w2 leg measured ime on the first run. Its complete absence
    // from the retry is "could not measure it again", not permission to ignore
    // a correctness check and clear frameBudget's red.
    expect(() => judgeRetry(
      result({ ime: null }),
      baseline,
      ['frameBudgetP95Ms_N8'],
      { original: result(), plannedLegs: ['w2'] },
    )).toThrow(/did not measure/);
  });

  it('ignores gates the re-run did not measure', () => {
    // A w2-only retry has no ram scenario; comparing it would report every
    // skipped leg as a failure.
    const out = judgeRetry(result({ ram8: null }), baseline, ['frameBudgetP95Ms_N8']);
    expect(out.reproduced).toBe(false);
    expect(out.verdicts.map((v) => v.key)).not.toContain('ram8Bytes');
  });

  it('refuses when the re-run did not measure what went red', () => {
    // "We could not measure it again" is not "it was fine".
    expect(() => judgeRetry(result({ frameBudgetN8: null }), baseline, ['frameBudgetP95Ms_N8']))
      .toThrow(/did not measure/);
  });
});

describe('runConfirmation', () => {
  const ORIGINAL = Buffer.from(JSON.stringify(result({ frameBudgetN8: 37.1 })));
  const BASE_BYTES = Buffer.from(JSON.stringify(result()));
  const setup = ({ retryP95 = 15.7, ime = { pass: true }, ...rest } = {}) => depsFor({
    files: { [RETRY]: result({ frameBudgetN8: retryP95, ime }) },
    bytes: { [CURRENT]: ORIGINAL, [BASELINE]: BASE_BYTES, [RETRY]: Buffer.from('{}') },
    ...rest,
  });
  const run = (ctx, current = result({ frameBudgetN8: 37.1 })) => runConfirmation({
    current,
    baseline: result(),
    results: verdictOf(current),
    currentJson: CURRENT,
    currentBytes: ORIGINAL,
    baselineJson: BASELINE,
    baselineBytes: BASE_BYTES,
    retryJson: RETRY,
    deps: ctx.deps,
  });

  it('re-runs the planned legs into their own file and clears a non-reproducing red', () => {
    const ctx = setup();
    const out = run(ctx);
    expect(out.reproduced).toBe(false);
    expect(ctx.deps.claimRetryTarget).toHaveBeenCalledWith(RETRY, CURRENT, BASELINE);
    expect(ctx.releaseClaim).toHaveBeenCalledOnce();
    const args = ctx.deps.runBench.mock.calls[0][0];
    expect(args).toContain('--skip-cold');
    expect(args.slice(-2)).toEqual(['--json', RETRY]);
  });

  it('keeps the red when the failure reproduces', () => {
    expect(run(setup({ retryP95: 60 })).reproduced).toBe(true);
  });

  it('keeps the red when the re-run itself breaks a correctness check', () => {
    expect(run(setup({ ime: { pass: false } })).reproduced).toBe(true);
  });

  it('fails closed when the re-run exits nonzero', () => {
    expect(() => run(setup({ benchStatus: 2 }))).toThrow(/exited 2/);
  });

  it('fails closed when the re-run produced no readable result', () => {
    const ctx = depsFor({ files: {}, bytes: { [CURRENT]: ORIGINAL, [BASELINE]: BASE_BYTES, [RETRY]: Buffer.from('{}') } });
    expect(() => run(ctx)).toThrow(UnconfirmableError);
  });

  it('restores the original sample if the re-run touched it, and still refuses', () => {
    const ctx = setup({ onBench: ({ store }) => { store[CURRENT] = Buffer.from('{"clobbered":true}'); } });
    expect(() => run(ctx)).toThrow(/wrote to/);
    expect(ctx.store[CURRENT].equals(ORIGINAL)).toBe(true);
    expect(ctx.logs.join('')).toMatch(/restored from memory/i);
  });

  it('restores the baseline too — the verdict rests on it just as much', () => {
    const ctx = setup({ onBench: ({ store }) => { store[BASELINE] = Buffer.from('{"gone":true}'); } });
    expect(() => run(ctx)).toThrow(/wrote to/);
    expect(ctx.store[BASELINE].equals(BASE_BYTES)).toBe(true);
  });

  it('checks the protected files even when the re-run crashed', () => {
    // The integrity check lives in a finally: a bench that clobbers a file and
    // THEN exits nonzero must not skip it, or the artifact is lost while the
    // verdict looks correct.
    const ctx = setup({
      benchStatus: 3,
      onBench: ({ store }) => { store[CURRENT] = Buffer.from('{"clobbered":true}'); },
    });
    expect(() => run(ctx)).toThrow(UnconfirmableError);
    expect(ctx.store[CURRENT].equals(ORIGINAL)).toBe(true);
  });

  it('refuses when the retry target is no longer the file it claimed', () => {
    // The window between claiming the name and the bench writing it is minutes
    // long; a name swapped for a link to something else in between would have
    // sent the measurement's bytes there.
    const ctx = setup({ identify: () => 'someone-elses-id' });
    expect(() => run(ctx)).toThrow(/wrote to/);
    expect(ctx.logs.join('')).toMatch(/no longer the file this run created/);
  });

  it('judges bytes from the claimed handle, not a later lookup of its name', () => {
    // Model a filesystem identity that lies: the claimed file contains a
    // reproduced failure while reopening the path would show a passing result.
    // The verdict must stay red by reading the still-open original handle.
    const ctx = setup({ retryP95: 60 });
    ctx.store[RETRY] = Buffer.from(JSON.stringify(result()));
    expect(run(ctx).reproduced).toBe(true);
  });

  it('takes back an empty target so the next run is not refused a name nothing used', () => {
    // A bench that exits 0 without writing leaves the empty file this process
    // claimed. There is nothing to judge — and nothing to keep.
    const ctx = depsFor({
      files: {},
      bytes: { [CURRENT]: ORIGINAL, [BASELINE]: BASE_BYTES, [RETRY]: Buffer.alloc(0) },
    });
    expect(() => run(ctx)).toThrow(UnconfirmableError);
    expect(ctx.deps.remove).toHaveBeenCalledWith(RETRY);
  });

  it('fails closed when the re-run measured a different commit', () => {
    const ctx = depsFor({
      files: { [RETRY]: result({ commit: 'deadbee' }) },
      bytes: { [CURRENT]: ORIGINAL, [BASELINE]: BASE_BYTES, [RETRY]: Buffer.from('{}') },
    });
    expect(() => run(ctx)).toThrow(/measured commit/);
  });

  it('fails closed on a schemaVersion the baseline cannot be compared against', () => {
    const ctx = depsFor({
      files: { [RETRY]: result({ schemaVersion: 2 }) },
      bytes: { [CURRENT]: ORIGINAL, [BASELINE]: BASE_BYTES, [RETRY]: Buffer.from('{}') },
    });
    expect(() => run(ctx)).toThrow(/schemaVersion/);
  });

  it('fails closed when no original bytes were captured', () => {
    const ctx = setup();
    expect(() => runConfirmation({
      current: result({ frameBudgetN8: 37.1 }),
      baseline: result(),
      results: verdictOf(result({ frameBudgetN8: 37.1 })),
      currentJson: CURRENT,
      currentBytes: null,
      baselineJson: BASELINE,
      baselineBytes: BASE_BYTES,
      retryJson: RETRY,
      deps: ctx.deps,
    })).toThrow(/no original bytes/);
    expect(ctx.deps.runBench).not.toHaveBeenCalled();
  });
});

describe('confirmGate', () => {
  const current = result({ frameBudgetN8: 37.1 });
  const bytes = Buffer.from(JSON.stringify(current));
  const baseBytes = Buffer.from(JSON.stringify(result()));
  const base = (ctx, summaryPath) => confirmGate({
    current,
    baseline: result(),
    results: verdictOf(current),
    currentJson: CURRENT,
    currentBytes: bytes,
    baselineJson: BASELINE,
    baselineBytes: baseBytes,
    retryJson: RETRY,
    summaryPath,
    deps: ctx.deps,
  });
  const ctxFor = (retry) => depsFor({
    files: { [RETRY]: retry },
    bytes: { [CURRENT]: bytes, [BASELINE]: baseBytes, [RETRY]: Buffer.from('{}') },
  });

  it('clears the gate and says so as a warning, not silently', () => {
    const ctx = ctxFor(result());
    const out = base(ctx);
    expect(out.cleared).toBe(true);
    // #940: a cleared blip is settled here — there is nothing to escalate.
    expect(out.escalation).toBeNull();
    expect(ctx.logs.join('')).toContain('::warning::');
  });

  it('does not clear a reproduced failure, and hands its plan up for escalation', () => {
    const ctx = ctxFor(result({ frameBudgetN8: 60 }));
    const out = base(ctx);
    expect(out.cleared).toBe(false);
    // #940: the reproduced red is the ONE case a same-runner measurement
    // cannot settle — the plan travels up so perf-compare can escalate it to
    // a fresh-runner job.
    expect(out.escalation).toEqual({
      failedGateKeys: ['frameBudgetP95Ms_N8'],
      legs: ['w2'],
      benchArgs: expect.arrayContaining(['--skip-cold']),
    });
    expect(ctx.logs.join('')).toContain('::error::');
  });

  it('turns every unconfirmable case into a red rather than an exception', () => {
    const ctx = depsFor({ files: {}, bytes: { [CURRENT]: bytes, [BASELINE]: baseBytes } });
    const out = base(ctx);
    expect(out.cleared).toBe(false);
    // #940: "could not measure it again" fails closed HERE — an infrastructure
    // failure must never ride to another machine as a measurement question.
    expect(out.escalation).toBeNull();
    expect(ctx.logs.join('')).toContain('The gate stays red');
  });

  // #650: a clear earned through the re-run must not report LESS than a plain
  // green. The retry's fastest boot recovered (so the gate clears) while its
  // median stayed regressed — the tail note fires on the retry's numbers.
  it('prints the tail note when the retry clears on its fastest boot with the median still red', () => {
    const cold = (medianMs, bestMs) => ({
      schemaVersion: 1,
      meta: { commit: 'abc1234', mode: 'ci', config: { coldRuns: 3, inputSamples: 80, inputSamples8: 40, frameBudgetPanes: [4, 8, 16], hiddenFloodAgents: [4, 8] } },
      scenarios: { coldStart: { median: { firstPtyDataMs: medianMs }, best: { firstPtyDataMs: bestMs } } },
    });
    const coldBaseline = cold(1207, 1134);
    const coldCurrent = cold(2470, 2470); // best red on the first run
    const coldRetry = cold(2282, 1442); // best recovers; median still trips both thresholds
    const curBytes = Buffer.from(JSON.stringify(coldCurrent));
    const basBytes = Buffer.from(JSON.stringify(coldBaseline));
    const ctx = depsFor({
      files: { [RETRY]: coldRetry },
      bytes: { [CURRENT]: curBytes, [BASELINE]: basBytes, [RETRY]: Buffer.from('{}') },
    });
    const out = confirmGate({
      current: coldCurrent,
      baseline: coldBaseline,
      results: verdictOf(coldCurrent, coldBaseline),
      currentJson: CURRENT,
      currentBytes: curBytes,
      baselineJson: BASELINE,
      baselineBytes: basBytes,
      retryJson: RETRY,
      deps: ctx.deps,
    });
    expect(out.cleared).toBe(true);
    expect(ctx.logs.join('')).toContain('median regressed');
  });
});

// End to end through the shipped gate: perf-compare decides, confirms, and
// returns the exit code CI reads. The bench is a stand-in script, so this runs
// without a packaged app.
describe('perf-compare with a confirmation re-run (end to end)', () => {
  const COMPARE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'perf-compare.mjs');
  const FAKE_BENCH = [
    "import fs from 'node:fs';",
    'const argv = process.argv.slice(2);',
    "const out = argv[argv.indexOf('--json') + 1];",
    'fs.writeFileSync(out, process.env.FAKE_RESULT, "utf8");',
    'if (process.env.FAKE_CLOBBER) fs.writeFileSync(process.env.FAKE_CLOBBER, "{\\"clobbered\\":true}", "utf8");',
    'process.exit(Number(process.env.FAKE_STATUS ?? 0));',
  ].join('\n');

  function inTmp(fn) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'perf-gate-'));
    try {
      return fn(dir);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  function gate(dir, {
    currentP95 = 60, retryP95 = 15.7, retryIme = { pass: true }, clobber = null, ime = { pass: true }, extraArgs = [],
  } = {}) {
    const current = path.join(dir, 'perf-current.json');
    const baseline = path.join(dir, 'baseline-ci.json');
    const retry = path.join(dir, 'perf-retry.json');
    const summary = path.join(dir, 'summary.md');
    const bench = path.join(dir, 'fake-bench.mjs');
    fs.writeFileSync(current, JSON.stringify(result({ frameBudgetN8: currentP95, ime })));
    fs.writeFileSync(baseline, JSON.stringify(result()));
    fs.writeFileSync(bench, FAKE_BENCH);
    const res = spawnSync(process.execPath, [
      COMPARE,
      '--current', current, '--baseline', baseline, '--summary', summary,
      '--confirm-retry', retry, '--confirm-bench', bench,
      ...extraArgs,
    ], {
      encoding: 'utf8',
      env: {
        ...process.env,
        FAKE_RESULT: JSON.stringify(result({ frameBudgetN8: retryP95, ime: retryIme })),
        ...(clobber ? { FAKE_CLOBBER: path.join(dir, clobber) } : {}),
      },
    });
    return { res, current, baseline, retry, summary };
  }

  const p95Of = (file) => JSON.parse(fs.readFileSync(file, 'utf8')).scenarios.frameBudget.N8.frameDeltaMs.p95;

  it('exits 0 on a red that does not reproduce, and keeps both samples', () => {
    inTmp((dir) => {
      const { res, current, retry, summary } = gate(dir);
      expect(res.status).toBe(0);
      expect(res.stdout).toContain('::warning::');
      expect(fs.existsSync(retry)).toBe(true);
      expect(p95Of(current)).toBe(60); // the published sample is the FIRST one
      const md = fs.readFileSync(summary, 'utf8');
      expect(md).toContain('confirmation re-run');
      expect(md).toContain('did not reproduce');
    });
  });

  it('exits 1 when the failure reproduces', () => {
    inTmp((dir) => {
      const { res, summary } = gate(dir, { retryP95: 60 });
      expect(res.status).toBe(1);
      expect(fs.readFileSync(summary, 'utf8')).toContain('the gate stands red');
    });
  });

  it('exits 1 when the re-run breaks a correctness check that passed the first time', () => {
    inTmp((dir) => {
      const { res } = gate(dir, { retryIme: { pass: false } });
      expect(res.status).toBe(1);
      expect(res.stdout).toContain('::error::');
    });
  });

  it('exits 1 when the re-run drops a correctness scenario measured on the first run', () => {
    inTmp((dir) => {
      const { res } = gate(dir, { retryIme: null });
      expect(res.status).toBe(1);
      expect(res.stdout).toContain('did not measure');
    });
  });

  it('exits 1 and restores the sample when the re-run overwrites it', () => {
    inTmp((dir) => {
      const { res, current } = gate(dir, { clobber: 'perf-current.json' });
      expect(res.status).toBe(1);
      expect(p95Of(current)).toBe(60);
    });
  });

  it('exits 1 and restores the baseline when the re-run overwrites that', () => {
    inTmp((dir) => {
      const { res, baseline } = gate(dir, { clobber: 'baseline-ci.json' });
      expect(res.status).toBe(1);
      expect(p95Of(baseline)).toBe(15.7);
    });
  });

  it('exits 1 without re-running when a correctness gate is what failed', () => {
    inTmp((dir) => {
      const { res, retry } = gate(dir, { currentP95: 15.7, ime: { pass: false } });
      expect(res.status).toBe(1);
      expect(fs.existsSync(retry)).toBe(false); // no CI time spent
      expect(res.stdout).toContain('correctness check');
    });
  });

  it('leaves a green run untouched', () => {
    inTmp((dir) => {
      const { res, retry } = gate(dir, { currentP95: 15.7 });
      expect(res.status).toBe(0);
      expect(fs.existsSync(retry)).toBe(false);
      expect(res.stdout).not.toContain('confirming it with a re-run');
    });
  });

  it('refuses to write an output over an input, instead of corrupting it', () => {
    // --summary over --current used to leave the result file as markdown and
    // still exit with the gate's verdict; the confirmation would then have
    // "restored" that markdown as the original sample.
    inTmp((dir) => {
      const current = path.join(dir, 'perf-current.json');
      const baseline = path.join(dir, 'baseline-ci.json');
      fs.writeFileSync(current, JSON.stringify(result()));
      fs.writeFileSync(baseline, JSON.stringify(result()));
      for (const argv of [
        ['--summary', current],
        ['--append-history', current],
        ['--confirm-retry', baseline],
      ]) {
        const res = spawnSync(process.execPath, [
          COMPARE, '--current', current, '--baseline', baseline, ...argv,
        ], { encoding: 'utf8' });
        expect(res.status).toBe(2);
        expect(res.stderr).toMatch(/would write over/);
      }
      expect(() => JSON.parse(fs.readFileSync(current, 'utf8'))).not.toThrow();
    });
  });

  it('refuses a current file that is valid JSON but not a result object', () => {
    // It would otherwise read as every gate SKIP — a corrupt file passing green.
    inTmp((dir) => {
      const current = path.join(dir, 'perf-current.json');
      const baseline = path.join(dir, 'baseline-ci.json');
      fs.writeFileSync(baseline, JSON.stringify(result()));
      for (const body of ['null', '"a string"', '[1,2]']) {
        fs.writeFileSync(current, body);
        const res = spawnSync(process.execPath, [
          COMPARE, '--current', current, '--baseline', baseline,
        ], { encoding: 'utf8' });
        expect(res.status).toBe(2);
        expect(res.stderr).toMatch(/not a result object/);
      }
    });
  });

  it('still fails a correctness gate when the baseline file contains null', () => {
    // A baseline that parses to `null` is readable, so it is not the
    // record-only bootstrap path: the numeric gates have nothing to compare
    // against but the correctness gates enforce. Pinned end to end because it
    // is the exit code, not a function's return value, that CI acts on.
    inTmp((dir) => {
      const current = path.join(dir, 'perf-current.json');
      const baseline = path.join(dir, 'baseline-ci.json');
      fs.writeFileSync(current, JSON.stringify(result({ ime: { pass: false } })));
      fs.writeFileSync(baseline, 'null');
      const res = spawnSync(process.execPath, [
        COMPARE, '--current', current, '--baseline', baseline,
      ], { encoding: 'utf8' });
      expect(res.status).toBe(1);
    });
  });
});

describe('renderConfirmationMarkdown', () => {
  const plan = { legs: ['w2'], failedGateKeys: ['frameBudgetP95Ms_N8'] };

  it('shows the tail sample beside the re-run so the flake is visible', () => {
    const original = result({ frameBudgetN8: 37.1 });
    const { verdicts, reproduced } = judgeRetry(result(), result(), ['frameBudgetP95Ms_N8']);
    const md = renderConfirmationMarkdown({ plan, verdicts, original, reproduced });
    expect(md).toContain('37.1 ms'); // the measurement that went red
    expect(md).toContain('15.7 ms'); // the re-run
    expect(md).toContain('**frameBudget.N8.frameDeltaMs.p95**'); // marked as the one that went red
    expect(md).toContain('did not reproduce');
    expect(md).toContain('the gate is cleared');
  });

  it('says plainly when the failure reproduced', () => {
    const original = result({ frameBudgetN8: 60 });
    const { verdicts, reproduced } = judgeRetry(result({ frameBudgetN8: 60 }), result(), ['frameBudgetP95Ms_N8']);
    const md = renderConfirmationMarkdown({ plan, verdicts, original, reproduced });
    expect(md).toContain('the gate stands red');
    expect(md).toContain('still FAIL');
  });

  it('says the re-run shared the runner, and does not call it independent (#940)', () => {
    // The re-run measures on the machine that produced the first sample, so it
    // can separate a transient tail spike from a repeatable one but cannot
    // refute a runner that was degraded for its whole lifetime. Claiming an
    // "independent measurement" invited reading every red as a regression.
    const original = result({ frameBudgetN8: 60 });
    const { verdicts, reproduced } = judgeRetry(result({ frameBudgetN8: 60 }), result(), ['frameBudgetP95Ms_N8']);
    const md = renderConfirmationMarkdown({ plan, verdicts, original, reproduced });
    expect(md).toContain('same runner');
    expect(md).not.toContain('independent measurement');
  });
});

// #940 end to end: --escalate hands the reproduced red to a fresh-runner job.
// Same fake-bench rig as the confirmation suite above — the only difference is
// the flag, so each case here is a delta against the behavior pinned there.
describe('perf-compare with --escalate (end to end, #940)', () => {
  const COMPARE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'perf-compare.mjs');
  const FAKE_BENCH = [
    "import fs from 'node:fs';",
    'const argv = process.argv.slice(2);',
    "const out = argv[argv.indexOf('--json') + 1];",
    'fs.writeFileSync(out, process.env.FAKE_RESULT, "utf8");',
    'process.exit(Number(process.env.FAKE_STATUS ?? 0));',
  ].join('\n');

  function inTmp(fn) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'perf-esc-'));
    try {
      return fn(dir);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  function gate(dir, { currentP95 = 60, retryP95 = 60, ime = { pass: true } } = {}) {
    const current = path.join(dir, 'perf-current.json');
    const baseline = path.join(dir, 'baseline-ci.json');
    const retry = path.join(dir, 'perf-retry.json');
    const escalation = path.join(dir, 'perf-escalation.json');
    const summary = path.join(dir, 'summary.md');
    const bench = path.join(dir, 'fake-bench.mjs');
    fs.writeFileSync(current, JSON.stringify(result({ frameBudgetN8: currentP95, ime })));
    fs.writeFileSync(baseline, JSON.stringify(result()));
    fs.writeFileSync(bench, FAKE_BENCH);
    const res = spawnSync(process.execPath, [
      COMPARE,
      '--current', current, '--baseline', baseline, '--summary', summary,
      '--confirm-retry', retry, '--confirm-bench', bench,
      '--escalate', escalation,
    ], {
      encoding: 'utf8',
      env: { ...process.env, FAKE_RESULT: JSON.stringify(result({ frameBudgetN8: retryP95 })) },
    });
    return { res, current, escalation, summary };
  }

  it('exits 0 on a reproduced red and writes the plan for the fresh-runner job', () => {
    inTmp((dir) => {
      const { res, escalation, summary } = gate(dir);
      expect(res.status).toBe(0);
      const payload = JSON.parse(fs.readFileSync(escalation, 'utf8'));
      expect(payload).toMatchObject({
        schemaVersion: 1,
        commit: 'abc1234',
        failedGateKeys: ['frameBudgetP95Ms_N8'],
        legs: ['w2'],
      });
      expect(payload.benchArgs).toContain('--skip-cold');
      expect(res.stdout).toContain('escalated to a fresh-runner confirmation job');
      expect(fs.readFileSync(summary, 'utf8')).toContain('its verdict is the gate');
    });
  });

  it('exits 0 on a red that did not reproduce, and does NOT write an escalation', () => {
    inTmp((dir) => {
      const { res, escalation } = gate(dir, { retryP95: 15.7 });
      expect(res.status).toBe(0);
      expect(fs.existsSync(escalation)).toBe(false);
    });
  });

  it('exits 1 on a correctness-gate red without escalating — that red is not a measurement question', () => {
    inTmp((dir) => {
      const { res, escalation } = gate(dir, { currentP95: 15.7, ime: { pass: false } });
      expect(res.status).toBe(1);
      expect(fs.existsSync(escalation)).toBe(false);
    });
  });

  it('leaves a green run untouched', () => {
    inTmp((dir) => {
      const { res, escalation } = gate(dir, { currentP95: 15.7, retryP95: 15.7 });
      expect(res.status).toBe(0);
      expect(fs.existsSync(escalation)).toBe(false);
    });
  });
});
