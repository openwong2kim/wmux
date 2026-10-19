// Weekly flaky-test rollup (scripts/lib/flaky-weekly.mjs, scripts/flaky-weekly.mjs).
//
// These pin what makes the weekly issue worth reading: a test is counted once
// per run however many shards of that run retried it, a run with no report
// artifact is skipped rather than failing the rollup, a week without a retry
// opens no issue, and a second run in the same week edits the open issue
// instead of opening another. `gh` is a fake that answers from canned data
// and writes report files where `gh run download` would.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  collectReports,
  issueTitle,
  listRuns,
  mergeWeek,
  publishIssue,
  renderWeekly,
  runsWithReports,
  runWeekly,
  weekWindow,
} from '../lib/flaky-weekly.mjs';

const NOW = new Date('2026-10-19T00:17:00Z'); // a Monday, when the schedule fires
const WINDOW = weekWindow(NOW, 7);

function report({ suite = 'unit', shard = null, platform = 'linux', tests }) {
  return { version: 1, suite, shard, platform, retry: 1, tests };
}

function flakyTest(name, file = 'src/a/__tests__/a.test.ts') {
  return { file, name, line: 3, state: 'passed', retryCount: 1 };
}

function run(id, createdAt, extra = {}) {
  return {
    databaseId: id,
    headBranch: 'main',
    event: 'push',
    conclusion: 'success',
    createdAt,
    url: `https://github.com/o/r/actions/runs/${id}`,
    ...extra,
  };
}

/**
 * A fake `gh`. `runs` maps a workflow file to its runs; `artifacts` maps a run
 * id to { artifact name: [report, ...] }; `downloadErrors` maps a run id to
 * the stderr of a failed download; `issues` is the open issue list.
 */
function fakeGh({ runs = {}, artifacts = {}, downloadErrors = {}, issues = [], failLabel = false } = {}) {
  const calls = [];
  const gh = (args) => {
    calls.push(args);
    const [cmd, sub] = args;
    if (cmd === 'run' && sub === 'list') {
      const workflow = args[args.indexOf('--workflow') + 1];
      const [day] = args[args.indexOf('--created') + 1].split('..');
      const list = (runs[workflow] ?? []).filter((r) => r.createdAt.startsWith(day));
      return { status: 0, stdout: JSON.stringify(list), stderr: '' };
    }
    if (cmd === 'api') {
      const all = Object.entries(artifacts).flatMap(([runId, byName]) =>
        Object.keys(byName).map((name) => ({
          name,
          expired: false,
          created_at: '2026-10-15T00:00:00Z',
          workflow_run: { id: Number(runId) },
        })),
      );
      return { status: 0, stdout: JSON.stringify({ artifacts: all }), stderr: '' };
    }
    if (cmd === 'run' && sub === 'download') {
      const id = args[2];
      if (downloadErrors[id]) return { status: 1, stdout: '', stderr: downloadErrors[id] };
      const dir = args[args.indexOf('-D') + 1];
      const byName = artifacts[id];
      if (!byName) return { status: 1, stdout: '', stderr: 'no artifact matches any of the names or patterns provided\n' };
      for (const [name, reports] of Object.entries(byName)) {
        fs.mkdirSync(path.join(dir, name), { recursive: true });
        reports.forEach((r, i) =>
          fs.writeFileSync(path.join(dir, name, `retries-${r.suite}${i ? `-${i}` : ''}.json`), JSON.stringify(r)),
        );
      }
      return { status: 0, stdout: '', stderr: '' };
    }
    if (cmd === 'issue' && sub === 'list') return { status: 0, stdout: JSON.stringify(issues), stderr: '' };
    if (cmd === 'issue' && sub === 'edit') return { status: 0, stdout: '', stderr: '' };
    if (cmd === 'issue' && sub === 'create') {
      if (failLabel && args.includes('--label')) return { status: 1, stdout: '', stderr: 'label not found' };
      return { status: 0, stdout: 'https://github.com/o/r/issues/9\n', stderr: '' };
    }
    if (cmd === 'label') return { status: 1, stdout: '', stderr: 'already exists' };
    throw new Error(`fake gh: unexpected ${args.join(' ')}`);
  };
  return { gh, calls };
}

let root;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'flaky-weekly-test-'));
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function rollup(fake) {
  const runs = listRuns(fake.gh, { window: WINDOW });
  const withReports = runsWithReports(fake.gh, { window: WINDOW });
  const { entries, coverage } = collectReports(fake.gh, { runs, withReports, root });
  return { runs, flaky: mergeWeek(entries), coverage };
}

describe('weekWindow', () => {
  it('names the week after the Monday on or before the window start', () => {
    expect(WINDOW.monday).toBe('2026-10-12');
    expect(WINDOW.days[0]).toBe('2026-10-12');
    expect(WINDOW.days.at(-1)).toBe('2026-10-19');
    expect(issueTitle(WINDOW.monday)).toBe('Flaky tests: week of 2026-10-12');
  });

  it('goes back to the previous Monday for a mid-week start', () => {
    expect(weekWindow(new Date('2026-10-18T12:00:00Z'), 2).monday).toBe('2026-10-12');
  });
});

describe('weekly rollup', () => {
  it('counts runs, not reports: two shards of one run are one run, two runs are two', () => {
    const t = flakyTest('suite > flaky');
    const fake = fakeGh({
      runs: {
        'ci.yml': [run(1, '2026-10-13T10:00:00Z'), run(2, '2026-10-15T10:00:00Z', { headBranch: 'feat/x', event: 'pull_request' })],
        'windows.yml': [run(3, '2026-10-16T10:00:00Z')],
      },
      artifacts: {
        1: {
          'test-report-retries-validate-1': [report({ shard: '1/2', tests: [t] })],
          'test-report-retries-validate-2': [report({ shard: '2/2', tests: [t] })],
        },
        2: { 'test-report-retries-validate-1': [report({ shard: '1/2', tests: [t] })] },
        3: { 'test-report-retries-windows-1': [report({ suite: 'integration', platform: 'darwin', tests: [t, flakyTest('other > once', 'b.test.ts')] })] },
      },
    });
    const { flaky, coverage } = rollup(fake);
    expect(coverage).toMatchObject({ listed: 3, candidates: 3, read: 3, failed: 0, stoppedReason: null });
    expect(flaky).toHaveLength(2);
    expect(flaky[0]).toMatchObject({
      name: 'suite > flaky',
      runs: 3,
      mainRuns: 2,
      lanes: ['integration, darwin', 'unit, linux'],
      firstSeen: '2026-10-13T10:00:00Z',
      lastSeen: '2026-10-16T10:00:00Z',
      url: 'https://github.com/o/r/actions/runs/3',
    });
    expect(flaky[1]).toMatchObject({ name: 'other > once', runs: 1 });

    const body = renderWeekly({ window: WINDOW, flaky, coverage });
    expect(body).toContain('| suite > flaky | `src/a/__tests__/a.test.ts:3` | 3 | 2 |');
    expect(body).toContain('read the retry reports of 3 of 3 runs');
  });

  it('downloads each run into its own folder', () => {
    const fake = fakeGh({
      runs: { 'ci.yml': [run(1, '2026-10-13T10:00:00Z'), run(2, '2026-10-14T10:00:00Z')] },
      artifacts: {
        1: { 'test-report-retries-validate-1': [report({ tests: [flakyTest('a')] })] },
        2: { 'test-report-retries-validate-1': [report({ tests: [flakyTest('a')] })] },
      },
    });
    rollup(fake);
    const dirs = fake.calls.filter((a) => a[1] === 'download').map((a) => a[a.indexOf('-D') + 1]);
    expect(dirs).toEqual([path.join(root, '1'), path.join(root, '2')]);
    expect(fs.existsSync(path.join(root, '1', 'test-report-retries-validate-1', 'retries-unit.json'))).toBe(true);
  });

  it('ignores a failed-every-attempt test and a passing report', () => {
    const fake = fakeGh({
      runs: { 'ci.yml': [run(1, '2026-10-13T10:00:00Z')] },
      artifacts: {
        1: {
          'test-report-retries-validate-1': [
            report({ tests: [{ file: 'f.test.ts', name: 'broken', line: 1, state: 'failed', retryCount: 1 }] }),
          ],
        },
      },
    });
    expect(rollup(fake).flaky).toEqual([]);
  });

  it('treats "no artifact matches" as an empty run, not a failure', () => {
    const fake = fakeGh({
      runs: { 'ci.yml': [run(1, '2026-10-13T10:00:00Z'), run(2, '2026-10-14T10:00:00Z')] },
      // Listed with a report artifact, but gone by the time of the download.
      artifacts: { 1: { 'test-report-retries-validate-1': [report({ tests: [flakyTest('a')] })] }, 2: { 'test-report-retries-validate-1': [] } },
      downloadErrors: { 2: 'no artifact matches any of the names or patterns provided\n' },
    });
    const { flaky, coverage } = rollup(fake);
    expect(coverage).toMatchObject({ candidates: 2, read: 2, failed: 0 });
    expect(flaky).toHaveLength(1);
  });

  it('skips runs without a report artifact without downloading them', () => {
    const fake = fakeGh({
      runs: { 'ci.yml': [run(1, '2026-10-13T10:00:00Z'), run(2, '2026-10-14T10:00:00Z', { conclusion: 'cancelled' })] },
      artifacts: { 1: { 'test-report-retries-validate-1': [report({ tests: [] })] } },
    });
    const { coverage } = rollup(fake);
    expect(coverage).toMatchObject({ listed: 2, candidates: 1, read: 1 });
    expect(fake.calls.filter((a) => a[1] === 'download').map((a) => a[2])).toEqual(['1']);
  });

  it('keeps going past a failed download and stops on the rate limit, saying so', () => {
    const fake = fakeGh({
      runs: { 'ci.yml': [run(1, '2026-10-13T10:00:00Z'), run(2, '2026-10-14T10:00:00Z'), run(3, '2026-10-15T10:00:00Z')] },
      artifacts: {
        1: { 'test-report-retries-validate-1': [report({ tests: [flakyTest('a')] })] },
        2: { 'test-report-retries-validate-1': [] },
        3: { 'test-report-retries-validate-1': [] },
      },
      downloadErrors: { 1: 'HTTP 500: server error', 2: 'HTTP 403: API rate limit exceeded' },
    });
    const { coverage } = rollup(fake);
    expect(coverage).toMatchObject({ candidates: 3, read: 0, failed: 1, stoppedReason: 'the GitHub API rate limit' });
    expect(fake.calls.filter((a) => a[1] === 'download').map((a) => a[2])).toEqual(['1', '2']);
    const body = renderWeekly({ window: WINDOW, flaky: [], coverage });
    expect(body).toContain('Stopped early on the GitHub API rate limit');
    // gh's error text stays out of the rendered markdown.
    expect(body).not.toContain('HTTP 403');
  });

  it('pages the artifact listing until a page has nothing inside the window', () => {
    const artifact = (id, runId, createdAt, name = 'test-report-retries-validate-1') => ({
      id,
      name,
      expired: false,
      created_at: createdAt,
      workflow_run: { id: runId },
    });
    const filler = (n, createdAt) => Array.from({ length: n }, (_, i) => artifact(1000 + i, 9000 + i, createdAt, 'build-output'));
    const pages = [
      // An older artifact among newer ones does not end the listing.
      [artifact(1, 1, '2026-10-18T00:00:00Z'), artifact(2, 2, '2026-10-01T00:00:00Z'), ...filler(98, '2026-10-17T00:00:00Z')],
      [
        artifact(3, 3, '2026-10-13T00:00:00Z'),
        artifact(4, 4, '2026-10-13T00:00:00Z', 'test-report-retries-x'),
        // Every run's whole test-results/ folder: not a sign of a retry.
        artifact(6, 6, '2026-10-13T00:00:00Z', 'test-report-validate-1'),
        ...filler(97, '2026-10-01T00:00:00Z'),
      ],
      filler(100, '2026-10-01T00:00:00Z'),
      [artifact(5, 5, '2026-10-18T00:00:00Z')], // never reached
    ];
    const calls = [];
    const gh = (args) => {
      calls.push(args);
      const page = Number(/[?&]page=(\d+)/.exec(args[1])[1]);
      return { status: 0, stdout: JSON.stringify({ artifacts: pages[page - 1] ?? [] }), stderr: '' };
    };
    expect([...runsWithReports(gh, { window: WINDOW })].sort()).toEqual(['1', '3', '4']);
    expect(calls).toHaveLength(3);
  });

  it('lists runs one day at a time and drops runs outside the window', () => {
    const fake = fakeGh({
      runs: { 'runtime.yml': [run(1, '2026-10-12T00:10:00Z'), run(2, '2026-10-12T00:20:00Z')] },
    });
    const runs = listRuns(fake.gh, { window: WINDOW, workflows: ['runtime.yml'] });
    expect(runs.map((r) => r.databaseId)).toEqual([2]);
    expect(runs[0].workflow).toBe('runtime.yml');
    expect(fake.calls.filter((a) => a[1] === 'list')).toHaveLength(WINDOW.days.length);
  });
});

describe('publishIssue', () => {
  const title = issueTitle('2026-10-12');

  it('edits the open issue with the same title instead of opening another', () => {
    const fake = fakeGh({
      issues: [
        { number: 4, title: 'Flaky tests: week of 2026-10-05' },
        { number: 7, title },
      ],
    });
    const result = publishIssue(fake.gh, { title, body: 'body', bodyDir: root });
    expect(result).toEqual({ action: 'edited', number: 7 });
    const edit = fake.calls.find((a) => a[0] === 'issue' && a[1] === 'edit');
    expect(edit.slice(0, 3)).toEqual(['issue', 'edit', '7']);
    expect(fake.calls.some((a) => a[1] === 'create')).toBe(false);
    expect(fs.readFileSync(edit[edit.indexOf('--body-file') + 1], 'utf8')).toBe('body');
  });

  it('opens a labelled issue when none is open, whatever `gh label create` says', () => {
    const fake = fakeGh({ issues: [] });
    const result = publishIssue(fake.gh, { title, body: 'body', bodyDir: root });
    expect(result).toEqual({ action: 'created', url: 'https://github.com/o/r/issues/9' });
    const create = fake.calls.find((a) => a[0] === 'issue' && a[1] === 'create');
    expect(create).toEqual(expect.arrayContaining(['--title', title, '--label', 'flaky']));
  });

  it('opens the issue without the label when the label cannot be used', () => {
    const fake = fakeGh({ issues: [], failLabel: true });
    expect(publishIssue(fake.gh, { title, body: 'body', bodyDir: root }).action).toBe('created');
    const creates = fake.calls.filter((a) => a[0] === 'issue' && a[1] === 'create');
    expect(creates).toHaveLength(2);
    expect(creates[1]).not.toContain('--label');
  });
});

describe('runWeekly', () => {
  it('opens no issue in a week without a retry', () => {
    const fake = fakeGh({
      runs: { 'ci.yml': [run(1, '2026-10-13T10:00:00Z')] },
      artifacts: { 1: { 'test-report-retries-validate-1': [report({ tests: [] })] } },
    });
    const result = runWeekly(fake.gh, { now: NOW, issue: true, root });
    expect(result.flaky).toEqual([]);
    expect(result.published).toBeNull();
    expect(result.body).toContain('No test needed the retry to pass.');
    expect(fake.calls.some((a) => a[0] === 'issue' || a[0] === 'label')).toBe(false);
  });

  it('edits the week\'s open issue when there is one', () => {
    const fake = fakeGh({
      runs: { 'ci.yml': [run(1, '2026-10-13T10:00:00Z')] },
      artifacts: { 1: { 'test-report-retries-validate-1': [report({ tests: [flakyTest('a')] })] } },
      issues: [{ number: 11, title: 'Flaky tests: week of 2026-10-12' }],
    });
    const result = runWeekly(fake.gh, { now: NOW, issue: true, root });
    expect(result.published).toEqual({ action: 'edited', number: 11 });
    expect(fake.calls.some((a) => a[0] === 'issue' && a[1] === 'create')).toBe(false);
  });

  it('publishes nothing without --issue', () => {
    const fake = fakeGh({
      runs: { 'ci.yml': [run(1, '2026-10-13T10:00:00Z')] },
      artifacts: { 1: { 'test-report-retries-validate-1': [report({ tests: [flakyTest('a')] })] } },
    });
    const result = runWeekly(fake.gh, { now: NOW, root });
    expect(result.flaky).toHaveLength(1);
    expect(result.published).toBeNull();
    expect(fake.calls.some((a) => a[0] === 'issue')).toBe(false);
  });
});
