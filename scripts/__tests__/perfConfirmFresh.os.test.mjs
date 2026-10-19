// Tests for the fresh-runner confirmation (#940). parseEscalation is pure and
// unit-tested; the verdict path runs end to end through the CLI against a real
// filesystem and a fake bench, because the exit code is what CI reads and the
// commit binding is what makes the cross-job handshake honest.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { UnconfirmableError } from '../perf-confirm.mjs';
import { parseEscalation } from '../perf-confirm-fresh.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FRESH = path.join(HERE, '..', 'perf-confirm-fresh.mjs');
// The CLI binds the escalation to the checkout it runs in — the same
// `git rev-parse --short HEAD` perf-bench uses to stamp meta.commit.
const HEAD = execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
  cwd: path.join(HERE, '..', '..'),
  encoding: 'utf8',
}).trim();

function result({ frameBudgetN8 = 15.7, ime = { pass: true }, commit = HEAD } = {}) {
  const scenarios = {};
  if (ime !== null) scenarios.ime = ime;
  if (frameBudgetN8 !== null) scenarios.frameBudget = { N8: { frameDeltaMs: { p95: frameBudgetN8 } } };
  scenarios.ram = { panes8: { workingSetBytes: 400 * 1024 * 1024 } };
  return {
    schemaVersion: 1,
    meta: { commit, mode: 'ci', config: { coldRuns: 3, inputSamples: 80, inputSamples8: 40, frameBudgetPanes: [4, 8, 16], hiddenFloodAgents: [4, 8] } },
    scenarios,
  };
}

function escalationFor({ commit = HEAD } = {}) {
  return {
    schemaVersion: 1,
    commit,
    resultSchemaVersion: 1,
    failedGateKeys: ['frameBudgetP95Ms_N8'],
    legs: ['w2'],
    benchArgs: ['--mode', 'ci', '--skip-cold', '--skip-ram', '--skip-input', '--skip-hidden-flood'],
  };
}

describe('parseEscalation', () => {
  it('accepts what perf-compare writes', () => {
    expect(parseEscalation(escalationFor())).toMatchObject({ commit: HEAD, legs: ['w2'] });
  });

  it.each([
    ['an unknown schemaVersion', { ...escalationFor(), schemaVersion: 2 }, /schemaVersion/],
    ['a missing commit', { ...escalationFor(), commit: null }, /names no commit/],
    ['an unknown gate key', { ...escalationFor(), failedGateKeys: ['nope'] }, /unknown gates/],
    ['an empty gate list', { ...escalationFor(), failedGateKeys: [] }, /unknown gates|empty/],
    ['an unknown leg', { ...escalationFor(), legs: ['zeppelin'] }, /unknown bench legs/],
    ['non-string bench args', { ...escalationFor(), benchArgs: [1] }, /not a list of strings/],
  ])('fails closed on %s', (_what, payload, expected) => {
    expect(() => parseEscalation(payload)).toThrow(UnconfirmableError);
    expect(() => parseEscalation(payload)).toThrow(expected);
  });
});

describe('perf-confirm-fresh (end to end)', () => {
  const FAKE_BENCH = [
    "import fs from 'node:fs';",
    'const argv = process.argv.slice(2);',
    "const out = argv[argv.indexOf('--json') + 1];",
    'fs.writeFileSync(out, process.env.FAKE_RESULT, "utf8");',
    'if (process.env.FAKE_CLOBBER) fs.writeFileSync(process.env.FAKE_CLOBBER, "{\\"clobbered\\":true}", "utf8");',
    'process.exit(Number(process.env.FAKE_STATUS ?? 0));',
  ].join('\n');

  function inTmp(fn) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'perf-fresh-'));
    try {
      return fn(dir);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  function run(dir, {
    escalation = escalationFor(),
    currentP95 = 60,
    freshResult = result(),
    fakeStatus = 0,
    clobber = null,
  } = {}) {
    const escalationPath = path.join(dir, 'perf-escalation.json');
    const current = path.join(dir, 'perf-current.json');
    const baseline = path.join(dir, 'baseline-ci.json');
    const out = path.join(dir, 'perf-fresh.json');
    const summary = path.join(dir, 'summary.md');
    const bench = path.join(dir, 'fake-bench.mjs');
    fs.writeFileSync(escalationPath, JSON.stringify(escalation));
    fs.writeFileSync(current, JSON.stringify(result({ frameBudgetN8: currentP95 })));
    fs.writeFileSync(baseline, JSON.stringify(result()));
    fs.writeFileSync(bench, FAKE_BENCH);
    const res = spawnSync(process.execPath, [
      FRESH,
      '--escalation', escalationPath, '--current', current, '--baseline', baseline,
      '--json', out, '--summary', summary, '--bench', bench,
    ], {
      encoding: 'utf8',
      env: {
        ...process.env,
        FAKE_RESULT: JSON.stringify(freshResult),
        FAKE_STATUS: String(fakeStatus),
        ...(clobber ? { FAKE_CLOBBER: path.join(dir, clobber) } : {}),
      },
    });
    return { res, current, baseline, out, summary };
  }

  const p95Of = (file) => JSON.parse(fs.readFileSync(file, 'utf8')).scenarios.frameBudget.N8.frameDeltaMs.p95;

  it('exits 0 when the escalated red does not reproduce on this machine', () => {
    inTmp((dir) => {
      const { res, summary, current } = run(dir);
      expect(res.status).toBe(0);
      expect(res.stdout).toContain('::warning::');
      expect(res.stdout).toContain('runner-health noise');
      const md = fs.readFileSync(summary, 'utf8');
      expect(md).toContain('fresh-runner confirmation');
      expect(md).toContain('did not reproduce');
      // The first machine's sample is untouched — it is the published one.
      expect(p95Of(current)).toBe(60);
    });
  });

  it('exits 1 when the failure reproduces on a second machine', () => {
    inTmp((dir) => {
      const { res, summary } = run(dir, { freshResult: result({ frameBudgetN8: 60 }) });
      expect(res.status).toBe(1);
      expect(res.stdout).toContain('reproduced on a second machine');
      expect(fs.readFileSync(summary, 'utf8')).toContain('still FAIL');
    });
  });

  it('exits 1 when this run breaks a correctness check that had passed', () => {
    inTmp((dir) => {
      const { res } = run(dir, { freshResult: result({ ime: { pass: false } }) });
      expect(res.status).toBe(1);
    });
  });

  it('fails closed when the escalation names a different commit than this checkout', () => {
    inTmp((dir) => {
      const stale = { ...escalationFor({ commit: 'deadbee' }) };
      const { res } = run(dir, {
        escalation: stale,
        // the first-run result has to agree with its own escalation to reach
        // the checkout comparison — that is the check under test.
        currentP95: 60,
      });
      // current.meta.commit (HEAD) !== escalation.commit → refused before any bench runs.
      expect(res.status).toBe(1);
      expect(res.stdout + res.stderr).toMatch(/escalation is for commit|refusing to confirm/);
    });
  });

  it('fails closed when the bench exits nonzero', () => {
    inTmp((dir) => {
      const { res } = run(dir, { fakeStatus: 3 });
      expect(res.status).toBe(1);
      expect(res.stdout).toContain('Failing closed');
    });
  });

  it('fails closed when this run measured a different commit', () => {
    inTmp((dir) => {
      const { res } = run(dir, { freshResult: result({ commit: '0ddba11' }) });
      expect(res.status).toBe(1);
      expect(res.stdout).toContain('measured commit');
    });
  });

  it('restores the first-run sample if the bench overwrites it, and still refuses', () => {
    inTmp((dir) => {
      const { res, current } = run(dir, { clobber: 'perf-current.json' });
      expect(res.status).toBe(1);
      expect(p95Of(current)).toBe(60);
    });
  });

  it('exits 2 when a required flag is missing', () => {
    inTmp((dir) => {
      const res = spawnSync(process.execPath, [FRESH, '--escalation', path.join(dir, 'x.json')], { encoding: 'utf8' });
      expect(res.status).toBe(2);
      expect(res.stderr).toContain('is required');
    });
  });
});
