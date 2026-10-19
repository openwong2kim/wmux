#!/usr/bin/env node
// List the tests that failed at least once but passed on vitest's CI retry.
//
//   node scripts/flaky-report.mjs [path ...]     default path: test-results
//
// Reads the retries-*.json reports scripts/vitest-retry-reporter.mjs writes
// (files, or directories searched recursively). Prints the list; inside GitHub
// Actions it also appends it to the job summary ($GITHUB_STEP_SUMMARY) under
// "Flaky (passed on retry)" and puts a warning annotation on each flaky test,
// so a green job still shows what needed the retry.
//
// It also works across runs: download several runs' `test-report-retries-*`
// artifacts into one directory
// (`gh run download <run-id> -p 'test-report-retries-*' -D dir`) and point
// this at it; a test seen in several reports is one row with a count. (Every
// run's `test-report-*` artifact holds the same reports, so do not download
// both patterns.)
//
// Inside a step with an id it also sets the step output `retried` to `true`
// when any report lists a retried test (flaky or failed after retry), else
// `false`. The workflows upload the retry reports on their own, as
// `test-report-retries-*`, only when it is `true`, so the weekly rollup
// (scripts/flaky-weekly.mjs) downloads the runs that had a retry and no other.
//
// Always exits 0. It reports; it never gates a merge.

import fs from 'node:fs';
import {
  findReportFiles,
  mergeReports,
  readReport,
  renderAnnotations,
  renderSummary,
} from './lib/test-retries.mjs';

function main() {
  const args = process.argv.slice(2);
  const paths = args.length > 0 ? args : ['test-results'];

  const reports = [];
  for (const file of findReportFiles(paths)) {
    try {
      reports.push(readReport(file));
    } catch (error) {
      console.warn(`flaky-report: skipping ${file}: ${error.message}`);
    }
  }
  const { flaky, failed } = mergeReports(reports);
  const summary = renderSummary({ reports, flaky, failed });

  console.log(summary);
  if (process.env.GITHUB_ACTIONS === 'true') {
    for (const line of renderAnnotations(flaky)) console.log(line);
  }
  const outputFile = process.env.GITHUB_OUTPUT;
  if (outputFile) {
    try {
      fs.appendFileSync(outputFile, `retried=${flaky.length + failed.length > 0}\n`);
    } catch (error) {
      console.warn(`flaky-report: could not write the step output: ${error.message}`);
    }
  }
  const summaryFile = process.env.GITHUB_STEP_SUMMARY;
  if (summaryFile) {
    try {
      fs.appendFileSync(summaryFile, `${summary}\n`);
    } catch (error) {
      console.warn(`flaky-report: could not write the job summary: ${error.message}`);
    }
  }
}

main();
