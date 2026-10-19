// Weekly flaky-test rollup: every retry report CI wrote over the last week,
// merged per test and counted per run.
//
// scripts/flaky-report.mjs reads the reports of one run. A flake that shows up
// once a day in a different PR never looks like much there; across a week it
// is the same test, in eight runs, on two operating systems. This module finds
// the week's runs, downloads their `test-report-retries-*` artifacts (one
// folder per run, since every run's artifacts have the same names), and merges the
// reports so each test is one row with the number of runs it needed the retry
// in. scripts/flaky-weekly.mjs is the command line and opens or updates the
// weekly issue.
//
// The `gh` command is injected (`gh(args) -> { status, stdout, stderr }`) so
// the tests drive a fake. Only report JSON reaches the rendered markdown: gh's
// error text is for the console, never for the issue body.
//
// Two GitHub limits shape the code:
// - Listing workflow runs with a `created` filter returns at most 1,000 runs,
//   and ci.yml alone has more than that in a week, so runs are listed one day
//   at a time.
// - The workflow's token has 1,000 API calls an hour. `gh run download` costs
//   one call to list a run's artifacts and one per artifact. The workflows
//   upload the retry reports as `test-report-retries-*` only when one lists a
//   retried test (scripts/flaky-report.mjs sets the step output), so most runs
//   have none, and the repository's artifact listing (100 per call) says which
//   runs do: only those are downloaded. If the limit is hit anyway,
//   downloading stops and the rendered coverage line says so.

import fs from 'node:fs';
import path from 'node:path';
import { describeReport, findReportFiles, readReport } from './test-retries.mjs';

export const WORKFLOWS = ['ci.yml', 'ci-cross-platform-baseline.yml', 'runtime.yml', 'windows.yml'];
// Uploaded only by a run with a retried test. Every run also uploads its whole
// test-results/ folder as `test-report-*`; that one is not read here.
export const ARTIFACT_PREFIX = 'test-report-retries-';
export const ISSUE_LABEL = 'flaky';

const DAY_MS = 24 * 60 * 60 * 1000;
const RUN_FIELDS = 'databaseId,headBranch,event,conclusion,createdAt,url';
const ignore = () => undefined;

/** YYYY-MM-DD in UTC. */
export function utcDay(date) {
  return date.toISOString().slice(0, 10);
}

/**
 * The window that ends at `now` and starts `days` days earlier, the UTC days
 * it touches, and the Monday (UTC) on or before its start, which names the
 * week. The schedule runs early on Monday, so the default window is the week
 * that just ended and its Monday is the one before.
 */
export function weekWindow(now, days) {
  const since = new Date(now.getTime() - days * DAY_MS);
  const dayList = [];
  for (let d = Date.UTC(since.getUTCFullYear(), since.getUTCMonth(), since.getUTCDate()); d <= now.getTime(); d += DAY_MS) {
    dayList.push(utcDay(new Date(d)));
  }
  const back = (since.getUTCDay() + 6) % 7; // days since Monday
  const monday = utcDay(new Date(Date.UTC(since.getUTCFullYear(), since.getUTCMonth(), since.getUTCDate() - back)));
  return { since, until: now, days: dayList, monday };
}

export function issueTitle(monday) {
  return `Flaky tests: week of ${monday}`;
}

function repoArgs(repo) {
  return repo ? ['-R', repo] : [];
}

function ghJson(gh, args, what) {
  const result = gh(args);
  if (result.status !== 0) {
    throw new Error(`${what} failed: ${(result.stderr || '').trim() || `exit ${result.status}`}`);
  }
  return JSON.parse(result.stdout || 'null');
}

/**
 * Completed runs of the given workflows created inside the window, one
 * `gh run list` per workflow per day. Each run carries its workflow file.
 */
export function listRuns(gh, { workflows = WORKFLOWS, window, repo, warn = ignore }) {
  const runs = [];
  for (const workflow of workflows) {
    for (const day of window.days) {
      const list = ghJson(
        gh,
        [
          'run', 'list', ...repoArgs(repo),
          '--workflow', workflow,
          '--created', `${day}..${day}`,
          '--status', 'completed',
          '--json', RUN_FIELDS,
          '--limit', '1000',
        ],
        `gh run list (${workflow}, ${day})`,
      );
      if (list.length >= 1000) warn(`${workflow} on ${day}: 1000 runs listed, the API maximum; some runs may be missing`);
      for (const run of list) {
        const created = new Date(run.createdAt);
        if (created < window.since || created > window.until) continue;
        runs.push({ ...run, workflow });
      }
    }
  }
  return runs.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/**
 * Run ids that have an unexpired `<prefix>*` artifact created inside the
 * window, from the repository's artifact listing (newest first, so paging
 * stops once a page has nothing inside the window).
 */
export function runsWithReports(gh, { window, repo, prefix = ARTIFACT_PREFIX }) {
  const base = repo ? `repos/${repo}` : 'repos/{owner}/{repo}';
  const ids = new Set();
  for (let page = 1; ; page++) {
    const body = ghJson(
      gh,
      ['api', `${base}/actions/artifacts?per_page=100&page=${page}`],
      'listing artifacts',
    );
    const artifacts = body?.artifacts ?? [];
    let inWindow = 0;
    for (const a of artifacts) {
      if (new Date(a.created_at) < window.since) continue;
      inWindow += 1;
      if (a.expired || !a.name?.startsWith(prefix)) continue;
      const runId = a.workflow_run?.id;
      if (runId != null) ids.add(String(runId));
    }
    // The listing is newest id first, and created_at only roughly follows the
    // id, so stop at the first page with nothing inside the window rather
    // than at the first artifact outside it.
    if (inWindow === 0 || artifacts.length < 100) return ids;
  }
}

const NOTHING_TO_DOWNLOAD = /no artifact matches|no valid artifacts|artifact[^\n]*expired/i;
const RATE_LIMITED = /rate limit|HTTP 403|HTTP 429/i;

/**
 * `gh run download` of one run's reports into `dir`. A run with no matching
 * (or only expired) artifacts is empty, not a failure.
 * Returns { ok: true } | { ok: true, empty: true } | { ok: false, rateLimited, error }.
 */
export function downloadRun(gh, { runId, dir, repo, prefix = ARTIFACT_PREFIX }) {
  const result = gh(['run', 'download', String(runId), ...repoArgs(repo), '-p', `${prefix}*`, '-D', dir]);
  if (result.status === 0) return { ok: true };
  const stderr = (result.stderr || '').trim();
  if (NOTHING_TO_DOWNLOAD.test(stderr)) return { ok: true, empty: true };
  return { ok: false, rateLimited: RATE_LIMITED.test(stderr), error: stderr || `exit ${result.status}` };
}

/**
 * Download every listed run that has reports into `root/<run id>/` and read
 * the reports back. Stops at the first rate-limit failure; any other failure
 * leaves that run unread and moves on.
 */
export function collectReports(gh, { runs, withReports, root, repo, prefix = ARTIFACT_PREFIX, warn = ignore }) {
  const candidates = runs.filter((r) => withReports.has(String(r.databaseId)));
  const entries = [];
  let read = 0;
  let failed = 0;
  let stoppedReason = null;
  for (const run of candidates) {
    const dir = path.join(root, String(run.databaseId));
    const result = downloadRun(gh, { runId: run.databaseId, dir, repo, prefix });
    if (!result.ok) {
      warn(`run ${run.databaseId}: download failed: ${result.error}`);
      if (result.rateLimited) {
        stoppedReason = 'the GitHub API rate limit';
        break;
      }
      failed += 1;
      continue;
    }
    read += 1;
    for (const file of findReportFiles([dir])) {
      try {
        entries.push({ run, report: readReport(file) });
      } catch (error) {
        warn(`skipping ${file}: ${error.message}`);
      }
    }
  }
  return {
    entries,
    coverage: { listed: runs.length, candidates: candidates.length, read, failed, stoppedReason },
  };
}

/**
 * One row per test that passed only on retry, counting the runs (not the
 * reports: two shards of one run are one run) it did that in.
 */
export function mergeWeek(entries) {
  const rows = new Map();
  for (const { run, report } of entries) {
    const lane = describeReport({ ...report, shard: null });
    for (const t of report.tests) {
      if (t.state !== 'passed' || !(t.retryCount > 0)) continue;
      const key = `${t.file}\0${t.name}`;
      let row = rows.get(key);
      if (!row) {
        row = { file: t.file, name: t.name, line: t.line ?? null, runIds: new Set(), lanes: new Set(), mainRuns: new Set(), first: run, last: run };
        rows.set(key, row);
      }
      const id = String(run.databaseId);
      row.runIds.add(id);
      row.lanes.add(lane);
      if (run.headBranch === 'main') row.mainRuns.add(id);
      if (run.createdAt < row.first.createdAt) row.first = run;
      if (run.createdAt > row.last.createdAt) row.last = run;
    }
  }
  return [...rows.values()]
    .map((r) => ({
      file: r.file,
      name: r.name,
      line: r.line,
      runs: r.runIds.size,
      mainRuns: r.mainRuns.size,
      lanes: [...r.lanes].sort(),
      firstSeen: r.first.createdAt,
      lastSeen: r.last.createdAt,
      url: r.last.url,
    }))
    .sort((a, b) => b.runs - a.runs || a.file.localeCompare(b.file) || a.name.localeCompare(b.name));
}

/** The issue body / printed report. */
export function renderWeekly({ window, flaky, coverage, prefix = ARTIFACT_PREFIX }) {
  const lines = [
    `Tests that failed at least once and then passed on vitest's CI retry, in completed runs of ${WORKFLOWS.join(', ')} ` +
      `created between ${window.since.toISOString().slice(0, 16)}Z and ${window.until.toISOString().slice(0, 16)}Z. ` +
      `Generated by scripts/flaky-weekly.mjs from the runs' \`${prefix}*\` artifacts.`,
    '',
    `Coverage: read the retry reports of ${coverage.read} of ${coverage.candidates} runs that uploaded one ` +
      `(${coverage.listed} completed runs in the window).` +
      (coverage.failed ? ` ${coverage.failed} could not be downloaded.` : '') +
      (coverage.stoppedReason ? ` Stopped early on ${coverage.stoppedReason}; the counts below are a lower bound.` : ''),
    '',
  ];
  if (flaky.length === 0) {
    lines.push('No test needed the retry to pass.', '');
    return lines.join('\n');
  }
  lines.push(
    `${flaky.length} ${flaky.length === 1 ? 'test' : 'tests'} passed only on retry. "Runs" counts runs, not shards; "on main" is how many of them were on main.`,
    '',
    '| Test | File | Runs | On main | Lanes | First seen | Last seen | Run |',
    '| --- | --- | --- | --- | --- | --- | --- | --- |',
    ...flaky.map((t) => {
      const file = t.line ? `${t.file}:${t.line}` : t.file;
      return `| ${[
        cell(t.name),
        `\`${cell(file)}\``,
        String(t.runs),
        String(t.mainRuns),
        cell(t.lanes.join('; ')),
        t.firstSeen.slice(0, 10),
        t.lastSeen.slice(0, 10),
        t.url ? `[last](${t.url})` : '',
      ].join(' | ')} |`;
    }),
    '',
  );
  return lines.join('\n');
}

function cell(text) {
  return String(text).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

/**
 * The whole rollup: list, download into `root`, merge, render, and with
 * `issue` publish. A week where no test needed the retry publishes nothing.
 * Returns { title, body, flaky, coverage, published } where `published` is
 * publishIssue's result, or null when nothing was published.
 */
export function runWeekly(
  gh,
  { now = new Date(), days = 7, issue = false, root, repo, prefix = ARTIFACT_PREFIX, warn = ignore },
) {
  const window = weekWindow(now, days);
  const runs = listRuns(gh, { window, repo, warn });
  const withReports = runsWithReports(gh, { window, repo, prefix });
  const { entries, coverage } = collectReports(gh, { runs, withReports, root, repo, prefix, warn });
  const flaky = mergeWeek(entries);
  const title = issueTitle(window.monday);
  const body = renderWeekly({ window, flaky, coverage, prefix });
  const published = issue && flaky.length > 0 ? publishIssue(gh, { title, body, bodyDir: root, repo }) : null;
  return { title, body, flaky, coverage, published };
}

/**
 * Open the week's issue, or edit its body when one with the same title is
 * already open. Returns { action: 'created' | 'edited', number? }.
 */
export function publishIssue(gh, { title, body, bodyDir, repo }) {
  const bodyFile = path.join(bodyDir, 'flaky-weekly-body.md');
  fs.writeFileSync(bodyFile, body);
  const open = ghJson(
    gh,
    ['issue', 'list', ...repoArgs(repo), '--state', 'open', '--search', `"${title}" in:title`, '--json', 'number,title', '--limit', '50'],
    'gh issue list',
  );
  const existing = (open ?? []).find((i) => i.title === title);
  if (existing) {
    const result = gh(['issue', 'edit', String(existing.number), ...repoArgs(repo), '--body-file', bodyFile]);
    if (result.status !== 0) throw new Error(`gh issue edit failed: ${(result.stderr || '').trim()}`);
    return { action: 'edited', number: existing.number };
  }
  // The label may already exist, or the token may not be allowed to create
  // one; either way the create below decides.
  gh(['label', 'create', ISSUE_LABEL, ...repoArgs(repo), '--color', 'FBCA04', '--description', 'A test that passed only on CI retry']);
  const create = (label) =>
    gh(['issue', 'create', ...repoArgs(repo), '--title', title, ...(label ? ['--label', ISSUE_LABEL] : []), '--body-file', bodyFile]);
  let result = create(true);
  // Without the label rather than without the issue.
  if (result.status !== 0) result = create(false);
  if (result.status !== 0) throw new Error(`gh issue create failed: ${(result.stderr || '').trim()}`);
  return { action: 'created', url: (result.stdout || '').trim() };
}
