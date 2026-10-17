// Retry reports: which tests needed vitest's CI retry, and what came of it.
//
// CI retries a failed test once (vitest.config.ts, `retry` on CI only). A test
// that then passes no longer fails the job, which is the point, but it is still
// flaky, and a green job hides that. scripts/vitest-retry-reporter.mjs writes
// every retried test to test-results/retries-<suite>.json; this module holds the
// pure parts (collect, merge, render) so they can be tested without a vitest run,
// and scripts/flaky-report.mjs is the command line that prints them.
//
// Report format (version 1):
//   {
//     "version": 1,
//     "suite": "unit",               // which config wrote it
//     "shard": "1/2",                // null when not sharded
//     "platform": "win32",
//     "retry": 1,                    // the configured retry count
//     "tests": [
//       { "file": "src/x/__tests__/a.test.ts", "name": "suite > test",
//         "line": 12, "state": "passed", "retryCount": 1 }
//     ]
//   }
// `state: "passed"` with retryCount > 0 is a flaky test. `state: "failed"` with
// retryCount > 0 failed every attempt: a real failure, not a flake.

import fs from 'node:fs';
import path from 'node:path';

export const REPORT_VERSION = 1;
export const REPORT_PREFIX = 'retries-';

/**
 * Every test that was retried at least once, from vitest's reported test
 * modules (the `onTestRunEnd` argument). Duck-typed on the public reporter API:
 * TestModule.relativeModuleId / children.allTests(), TestCase.fullName /
 * diagnostic() / result() / location.
 */
export function collectRetriedTests(testModules) {
  const tests = [];
  for (const module of testModules) {
    for (const test of module.children.allTests()) {
      const retryCount = test.diagnostic()?.retryCount ?? 0;
      if (retryCount === 0) continue;
      const state = test.result().state;
      if (state !== 'passed' && state !== 'failed') continue;
      tests.push({
        file: toPosix(module.relativeModuleId),
        name: test.fullName,
        line: test.location?.line ?? null,
        state,
        retryCount,
      });
    }
  }
  tests.sort((a, b) => a.file.localeCompare(b.file) || a.name.localeCompare(b.name));
  return tests;
}

export function buildReport({ suite, shard, platform, retry, tests }) {
  return {
    version: REPORT_VERSION,
    suite,
    shard: shard ? `${shard.index}/${shard.count}` : null,
    platform,
    retry,
    tests,
  };
}

/** Report files under each path: a file is taken as is, a directory is searched. */
export function findReportFiles(paths) {
  const found = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.startsWith(REPORT_PREFIX) && entry.name.endsWith('.json')) found.push(full);
    }
  };
  for (const p of paths) {
    if (!fs.existsSync(p)) continue;
    if (fs.statSync(p).isDirectory()) walk(p);
    else found.push(p);
  }
  return found.sort();
}

export function readReport(file) {
  const report = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (report?.version !== REPORT_VERSION || !Array.isArray(report.tests)) {
    throw new Error(`${file}: not a version ${REPORT_VERSION} retry report`);
  }
  return report;
}

/**
 * Merge reports into one list per outcome. The same test seen in several
 * reports (several shards, or several runs' artifacts downloaded together) is
 * one row, with `seen` counting the reports that listed it.
 */
export function mergeReports(reports) {
  const flaky = new Map();
  const failed = new Map();
  for (const report of reports) {
    const where = describeReport(report);
    for (const t of report.tests) {
      const bucket = t.state === 'passed' ? flaky : t.state === 'failed' ? failed : null;
      if (!bucket) continue;
      const key = `${t.file}\0${t.name}`;
      const row = bucket.get(key) ?? { file: t.file, name: t.name, line: t.line, seen: 0, where: [] };
      row.seen += 1;
      if (!row.where.includes(where)) row.where.push(where);
      bucket.set(key, row);
    }
  }
  const order = (a, b) => b.seen - a.seen || a.file.localeCompare(b.file) || a.name.localeCompare(b.name);
  return { flaky: [...flaky.values()].sort(order), failed: [...failed.values()].sort(order) };
}

export function describeReport(report) {
  return [report.suite, report.shard && `shard ${report.shard}`, report.platform].filter(Boolean).join(', ');
}

/** Markdown for $GITHUB_STEP_SUMMARY. */
export function renderSummary({ reports, flaky, failed }) {
  const lines = ['### Flaky (passed on retry)', ''];
  if (reports.length === 0) {
    lines.push(
      'No retry report was written: the test step did not get far enough to finish a run, so nothing is known about flakiness here.',
      '',
    );
    return lines.join('\n');
  }
  const scope = reports.map(describeReport).join('; ');
  const many = reports.length > 1;
  if (flaky.length === 0) {
    lines.push(`None: no test needed the retry to pass (${scope}).`, '');
  } else {
    lines.push(
      `${flaky.length} ${flaky.length === 1 ? 'test' : 'tests'} failed at least once and then passed on retry (${scope}). ` +
        'The retry kept them from failing the run, but they are flaky.',
      '',
      many ? '| Test | File | Seen in |' : '| Test | File |',
      many ? '| --- | --- | --- |' : '| --- | --- |',
      ...flaky.map((t) => tableRow(t, many)),
      '',
    );
  }
  if (failed.length > 0) {
    lines.push(
      `**Failed after retry** (${failed.length}): these failed every attempt, so they are real failures, not flakes.`,
      '',
      many ? '| Test | File | Seen in |' : '| Test | File |',
      many ? '| --- | --- | --- |' : '| --- | --- |',
      ...failed.map((t) => tableRow(t, many)),
      '',
    );
  }
  return lines.join('\n');
}

/** GitHub workflow commands, one warning annotation per flaky test. */
export function renderAnnotations(flaky) {
  return flaky.map((t) => {
    const props = [`file=${escapeProperty(t.file)}`];
    if (t.line) props.push(`line=${t.line}`);
    props.push(`title=${escapeProperty('Flaky (passed on retry)')}`);
    return `::warning ${props.join(',')}::${escapeData(`${t.name} failed, then passed on retry`)}`;
  });
}

function tableRow(t, many) {
  const file = t.line ? `${t.file}:${t.line}` : t.file;
  const cells = [cell(t.name), `\`${file}\``];
  if (many) cells.push(cell(`${t.seen}× (${t.where.join('; ')})`));
  return `| ${cells.join(' | ')} |`;
}

function cell(text) {
  return String(text).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

function toPosix(p) {
  return String(p).replace(/\\/g, '/');
}

function escapeData(s) {
  return s.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
}

function escapeProperty(s) {
  return escapeData(s).replace(/:/g, '%3A').replace(/,/g, '%2C');
}
