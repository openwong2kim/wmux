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

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'flaky-report.mjs');

// The slice of vitest's reporter API (TestModule / TestCase) the collector reads.
function fakeModule(relativeModuleId, tests) {
  return {
    relativeModuleId,
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
    const tests = collectRetriedTests([
      fakeModule('src\\a\\__tests__\\a.test.ts', [
        { name: 'a > flaky', state: 'passed', retryCount: 1, line: 7 },
        { name: 'a > steady', state: 'passed', retryCount: 0 },
        { name: 'a > broken', state: 'failed', retryCount: 1 },
        { name: 'a > skipped', state: 'skipped', retryCount: 0 },
        { name: 'a > never finished', state: 'pending', pending: true },
      ]),
    ]);
    expect(tests).toEqual([
      { file: 'src/a/__tests__/a.test.ts', name: 'a > broken', line: null, state: 'failed', retryCount: 1 },
      { file: 'src/a/__tests__/a.test.ts', name: 'a > flaky', line: 7, state: 'passed', retryCount: 1 },
    ]);
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
      env: { ...process.env, GITHUB_ACTIONS: 'true', GITHUB_STEP_SUMMARY: summary },
    });
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('::warning file=src/x.test.ts,title=Flaky (passed on retry)::x > races');
    const written = fs.readFileSync(summary, 'utf8');
    expect(written.startsWith('## Earlier step\n')).toBe(true);
    expect(written).toContain('### Flaky (passed on retry)');
    expect(written).toContain('| x > races | `src/x.test.ts` |');
  });

  it('exits 0 with no report at all', () => {
    const run = spawnSync(process.execPath, [SCRIPT, path.join(tmpDir(), 'none')], {
      encoding: 'utf8',
      env: { ...process.env, GITHUB_ACTIONS: '', GITHUB_STEP_SUMMARY: '' },
    });
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('No retry report was written');
  });
});
