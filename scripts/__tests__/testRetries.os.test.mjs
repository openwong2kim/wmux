// Retry reports (scripts/lib/test-retries.mjs, scripts/flaky-report.mjs).
//
// CI retries a failed test once. These pin the part that keeps a flake from
// vanishing into a green job: a test that passed only on retry is listed as
// flaky, a test that failed every attempt is not, and a missing report is said
// out loud rather than read as "no flakes".
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildReport,
  collectRetriedTests,
  findReportFiles,
  mergeReports,
  readReport,
  renderAnnotations,
  renderSummary,
} from '../lib/test-retries.mjs';
import { collectDurations, readDurationsReport } from '../lib/test-durations.mjs';
import RetryReporter from '../vitest-retry-reporter.mjs';

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'flaky-report.mjs');

// The slice of vitest's reporter API (TestModule / TestCase) the collectors
// read. `project` is the TestProject.name: '' for a config without projects.
function fakeModule(relativeModuleId, tests, project = 'unit', { duration = 0, state = 'passed', diagnostic = {} } = {}) {
  return {
    relativeModuleId,
    project: { name: project },
    state: () => state,
    diagnostic: () => ({
      environmentSetupDuration: 0,
      prepareDuration: 0,
      collectDuration: 0,
      setupDuration: 0,
      duration,
      heap: undefined,
      ...diagnostic,
    }),
    children: {
      allTests: () =>
        tests.map((t) => ({
          fullName: t.name,
          location: t.line ? { line: t.line, column: 1 } : undefined,
          diagnostic: () => (t.pending ? undefined : { retryCount: t.retryCount ?? 0 }),
          result: () => ({ state: t.state }),
        })),
    },
  };
}

function report(tests, extra = {}) {
  return buildReport({ suite: 'unit', shard: { index: 1, count: 2 }, platform: 'win32', retry: 1, tests, ...extra });
}

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-retries-'));
}

describe('collectRetriedTests', () => {
  it('keeps only tests that were retried, with their outcome', () => {
    const byProject = collectRetriedTests([
      fakeModule('src\\a\\__tests__\\a.test.ts', [
        { name: 'a > flaky', state: 'passed', retryCount: 1, line: 7 },
        { name: 'a > steady', state: 'passed', retryCount: 0 },
        { name: 'a > broken', state: 'failed', retryCount: 1 },
        { name: 'a > skipped', state: 'skipped', retryCount: 0 },
        { name: 'a > never finished', state: 'pending', pending: true },
      ]),
    ]);
    expect([...byProject.keys()]).toEqual(['unit']);
    expect(byProject.get('unit')).toEqual([
      { file: 'src/a/__tests__/a.test.ts', name: 'a > broken', line: null, state: 'failed', retryCount: 1 },
      { file: 'src/a/__tests__/a.test.ts', name: 'a > flaky', line: 7, state: 'passed', retryCount: 1 },
    ]);
  });

  it('groups by project, a project with no retry included', () => {
    const byProject = collectRetriedTests([
      fakeModule('src/a.test.ts', [{ name: 'a > steady', state: 'passed', retryCount: 0 }], 'unit'),
      fakeModule('src/b.test.ts', [{ name: 'b > flaky', state: 'passed', retryCount: 1 }], 'integration'),
    ]);
    expect(byProject.get('unit')).toEqual([]);
    expect(byProject.get('integration').map((t) => t.name)).toEqual(['b > flaky']);
  });

  it('records the shard so two shards of one run stay apart', () => {
    expect(report([]).shard).toBe('1/2');
    expect(report([], { shard: undefined }).shard).toBeNull();
  });
});

describe('mergeReports', () => {
  const flaky = { file: 'src/x.test.ts', name: 'x > races', line: null, state: 'passed', retryCount: 1 };
  const broken = { file: 'src/y.test.ts', name: 'y > broken', line: null, state: 'failed', retryCount: 1 };

  it('splits passed-on-retry (flaky) from failed-every-attempt (real)', () => {
    const merged = mergeReports([report([flaky, broken])]);
    expect(merged.flaky.map((t) => t.name)).toEqual(['x > races']);
    expect(merged.failed.map((t) => t.name)).toEqual(['y > broken']);
  });

  it('counts a test seen in several reports once, most frequent first', () => {
    const other = { ...flaky, name: 'x > once' };
    const merged = mergeReports([
      report([other, flaky]),
      report([flaky], { shard: { index: 2, count: 2 }, platform: 'linux' }),
    ]);
    expect(merged.flaky.map((t) => [t.name, t.seen])).toEqual([
      ['x > races', 2],
      ['x > once', 1],
    ]);
    expect(merged.flaky[0].where).toEqual(['unit, shard 1/2, win32', 'unit, shard 2/2, linux']);
  });
});

describe('renderSummary', () => {
  it('lists flaky tests under the heading', () => {
    const reports = [report([{ file: 'src/x.test.ts', name: 'x > a | b', line: 3, state: 'passed', retryCount: 1 }])];
    const md = renderSummary({ reports, ...mergeReports(reports) });
    expect(md).toMatch(/^### Flaky \(passed on retry\)/);
    expect(md).toContain('1 test failed at least once and then passed on retry (unit, shard 1/2, win32)');
    // A pipe in a test name must not split the table row.
    expect(md).toContain('| x > a \\| b | `src/x.test.ts:3` |');
    expect(md).not.toContain('Failed after retry');
  });

  it('says so when nothing needed a retry', () => {
    const reports = [report([])];
    expect(renderSummary({ reports, ...mergeReports(reports) })).toContain('None: no test needed the retry to pass (unit, shard 1/2, win32)');
  });

  it('does not read a missing report as "no flakes"', () => {
    const md = renderSummary({ reports: [], flaky: [], failed: [] });
    expect(md).toContain('No retry report was written');
    expect(md).not.toContain('None:');
  });
});

describe('renderAnnotations', () => {
  it('emits one escaped warning per flaky test', () => {
    expect(
      renderAnnotations([{ file: 'src/x.test.ts', name: 'x > 50% done, really', line: 9 }]),
    ).toEqual([
      '::warning file=src/x.test.ts,line=9,title=Flaky (passed on retry)::x > 50%25 done, really failed, then passed on retry',
    ]);
  });
});

describe('report files', () => {
  it('finds retries-*.json under a directory and rejects a foreign file', () => {
    const dir = tmpDir();
    fs.mkdirSync(path.join(dir, 'shard-1'));
    fs.writeFileSync(path.join(dir, 'shard-1', 'retries-unit.json'), JSON.stringify(report([])));
    fs.writeFileSync(path.join(dir, 'other.json'), '{}');
    fs.writeFileSync(path.join(dir, 'retries-bogus.json'), '{"version":0}');
    const files = findReportFiles([dir, path.join(dir, 'missing')]);
    expect(files.map((f) => path.relative(dir, f).replace(/\\/g, '/'))).toEqual([
      'retries-bogus.json',
      'shard-1/retries-unit.json',
    ]);
    expect(readReport(files[1]).suite).toBe('unit');
    expect(() => readReport(files[0])).toThrow(/not a version 1 retry report/);
  });
});

describe('vitest-retry-reporter.mjs', () => {
  // Drives the reporter as vitest does: onInit, then onTestRunEnd, and reads
  // what it wrote under the config root.
  function run(options, modules, shard) {
    const root = tmpDir();
    const warnings = [];
    const reporter = new RetryReporter(options);
    reporter.onInit({ config: { root, retry: 1, shard }, logger: { warn: (m) => warnings.push(m) } });
    reporter.onTestRunEnd(modules);
    const dir = path.join(root, 'test-results');
    const all = fs.existsSync(dir) ? fs.readdirSync(dir).sort() : [];
    return {
      root,
      files: all.filter((f) => f.startsWith('retries-')),
      durationFiles: all.filter((f) => f.startsWith('durations-')),
      warnings,
      read: (name) => readReport(path.join(dir, name)),
      readDurations: (name) => readDurationsReport(path.join(dir, name)),
    };
  }

  const flaky = { name: 'b > flaky', state: 'passed', retryCount: 1 };
  const steady = { name: 'a > steady', state: 'passed', retryCount: 0 };

  it('writes one report per project, named and labelled after it', () => {
    const out = run({}, [
      fakeModule('src/a.test.ts', [steady], 'unit'),
      fakeModule('src/b.test.ts', [flaky], 'integration'),
    ], { index: 2, count: 2 });
    expect(out.files).toEqual(['retries-integration.json', 'retries-unit.json']);
    const unit = out.read('retries-unit.json');
    const integration = out.read('retries-integration.json');
    expect([unit.suite, unit.shard, unit.tests]).toEqual(['unit', '2/2', []]);
    expect(integration.suite).toBe('integration');
    expect(integration.tests.map((t) => t.name)).toEqual(['b > flaky']);
    expect(out.warnings).toEqual([]);
  });

  it('falls back to the suite option for an unnamed project', () => {
    const out = run({ suite: 'runtime' }, [fakeModule('src/r.runtime.test.ts', [flaky], '')]);
    expect(out.files).toEqual(['retries-runtime.json']);
    expect(out.read('retries-runtime.json').suite).toBe('runtime');
  });

  it('still writes an empty report when no module ran', () => {
    const out = run({ suite: 'runtime' }, []);
    expect(out.files).toEqual(['retries-runtime.json']);
    expect(out.read('retries-runtime.json').tests).toEqual([]);
  });

  it('keeps an explicit outputFile to one report, every project in it', () => {
    const out = run({ suite: 'all', outputFile: 'out/retries.json' }, [
      fakeModule('src/b.test.ts', [flaky], 'integration'),
      fakeModule('src/a.test.ts', [{ ...flaky, name: 'a > flaky' }], 'unit'),
    ]);
    expect(out.files).toEqual([]);
    const merged = readReport(path.join(out.root, 'out', 'retries.json'));
    expect(merged.suite).toBe('all');
    expect(merged.tests.map((t) => t.name)).toEqual(['a > flaky', 'b > flaky']);
  });

  it('merges with a report written before projects were named', () => {
    const t = { file: 'src/x.test.ts', name: 'x > races', line: null, state: 'passed', retryCount: 1 };
    const old = report([t]);
    const fresh = run({}, [fakeModule('src/x.test.ts', [{ ...t }], 'integration')]).read('retries-integration.json');
    const merged = mergeReports([old, fresh]);
    expect(merged.flaky.map((r) => [r.name, r.seen])).toEqual([['x > races', 2]]);
    expect(merged.flaky[0].where).toEqual(['unit, shard 1/2, win32', `integration, ${process.platform}`]);
  });

  it('writes each project\'s file durations next to its retry report', () => {
    const out = run({}, [
      fakeModule('src\\b\\__tests__\\b.test.ts', [flaky], 'integration', { duration: 1234.5 }),
      fakeModule('src/a.test.ts', [steady], 'unit', { duration: 20 }),
      fakeModule('src/c.test.ts', [steady], 'unit', { duration: 300, state: 'failed' }),
    ], { index: 1, count: 2 });
    expect(out.durationFiles).toEqual(['durations-integration.json', 'durations-unit.json']);
    expect(out.readDurations('durations-integration.json')).toEqual({
      version: 1,
      project: 'integration',
      shard: '1/2',
      platform: process.platform,
      files: { 'src/b/__tests__/b.test.ts': 1234.5 },
    });
    expect(out.readDurations('durations-unit.json').files).toEqual({ 'src/a.test.ts': 20, 'src/c.test.ts': 300 });
    expect(out.warnings).toEqual([]);
  });

  it('labels an unnamed project\'s durations with the suite option, outputFile or not', () => {
    const modules = [fakeModule('src/r.runtime.test.ts', [steady], '', { duration: 5 })];
    const plain = run({ suite: 'runtime' }, modules);
    expect(plain.durationFiles).toEqual(['durations-runtime.json']);
    expect(plain.readDurations('durations-runtime.json').project).toBe('runtime');
    const explicit = run({ suite: 'runtime', outputFile: 'out/retries.json' }, modules);
    expect(explicit.durationFiles).toEqual(['durations-runtime.json']);
  });
});

describe('collectDurations', () => {
  it('records a file\'s full cost: environment, prepare, import, setup files, tests', () => {
    const byProject = collectDurations([
      fakeModule('src/a.test.ts', [], 'unit', {
        duration: 30,
        diagnostic: { environmentSetupDuration: 400, prepareDuration: 20, collectDuration: 1_500, setupDuration: 50 },
      }),
      // A field vitest left out counts as 0; a broken one drops the file.
      fakeModule('src/b.test.ts', [], 'unit', { duration: 10, diagnostic: { prepareDuration: undefined } }),
      fakeModule('src/c.test.ts', [], 'unit', { duration: 10, diagnostic: { collectDuration: Number.NaN } }),
    ]);
    expect(byProject.get('unit')).toEqual({ 'src/a.test.ts': 2_000, 'src/b.test.ts': 10 });
  });

  it('records finished modules only, every project that ran included', () => {
    const byProject = collectDurations([
      fakeModule('src/a.test.ts', [], 'unit', { duration: 10 }),
      fakeModule('src/skipped.test.ts', [], 'unit', { duration: 0, state: 'skipped' }),
      fakeModule('src/queued.test.ts', [], 'integration', { duration: 0, state: 'queued' }),
    ]);
    expect(Object.fromEntries(byProject)).toEqual({ unit: { 'src/a.test.ts': 10 }, integration: {} });
  });
});

describe('flaky-report.mjs', () => {
  it('appends the summary to $GITHUB_STEP_SUMMARY, annotates, and exits 0', () => {
    const dir = tmpDir();
    fs.writeFileSync(
      path.join(dir, 'retries-unit.json'),
      JSON.stringify(report([{ file: 'src/x.test.ts', name: 'x > races', line: null, state: 'passed', retryCount: 1 }])),
    );
    const summary = path.join(dir, 'summary.md');
    fs.writeFileSync(summary, '## Earlier step\n');
    const run = spawnSync(process.execPath, [SCRIPT, dir], {
      encoding: 'utf8',
      env: { ...process.env, GITHUB_ACTIONS: 'true', GITHUB_STEP_SUMMARY: summary, GITHUB_OUTPUT: '' },
    });
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('::warning file=src/x.test.ts,title=Flaky (passed on retry)::x > races');
    const written = fs.readFileSync(summary, 'utf8');
    expect(written.startsWith('## Earlier step\n')).toBe(true);
    expect(written).toContain('### Flaky (passed on retry)');
    expect(written).toContain('| x > races | `src/x.test.ts` |');
  });

  it('sets the `retried` step output only when a report lists a retried test', () => {
    const runWith = (tests) => {
      const dir = tmpDir();
      fs.writeFileSync(path.join(dir, 'retries-unit.json'), JSON.stringify(report(tests)));
      const output = path.join(dir, 'output.txt');
      fs.writeFileSync(output, 'earlier=1\n');
      const run = spawnSync(process.execPath, [SCRIPT, dir], {
        encoding: 'utf8',
        env: { ...process.env, GITHUB_ACTIONS: '', GITHUB_STEP_SUMMARY: '', GITHUB_OUTPUT: output },
      });
      expect(run.status).toBe(0);
      return fs.readFileSync(output, 'utf8');
    };
    expect(runWith([])).toBe('earlier=1\nretried=false\n');
    expect(runWith([{ file: 'a.test.ts', name: 'a', line: 1, state: 'passed', retryCount: 1 }])).toBe(
      'earlier=1\nretried=true\n',
    );
    // Failed every attempt is still a retried test, and still worth keeping.
    expect(runWith([{ file: 'a.test.ts', name: 'a', line: 1, state: 'failed', retryCount: 1 }])).toBe(
      'earlier=1\nretried=true\n',
    );
  });

  it('exits 0 with no report at all', () => {
    const run = spawnSync(process.execPath, [SCRIPT, path.join(tmpDir(), 'none')], {
      encoding: 'utf8',
      env: { ...process.env, GITHUB_ACTIONS: '', GITHUB_STEP_SUMMARY: '', GITHUB_OUTPUT: '' },
    });
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('No retry report was written');
  });
});
