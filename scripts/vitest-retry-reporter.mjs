// Vitest reporter: write every retried test to a small JSON report.
//
// Wired in vitest.config.ts and vitest.runtime.config.ts on CI only, next to
// the default reporters. Vitest's own json and junit reporters do not record
// retries (v5), so this reads them from the reporter API the same way vitest's
// github-actions reporter does: TestCase.diagnostic().retryCount.
//
// Reporters are root-only in vitest 5, so one instance sees every project of a
// run. It writes one report per project that ran,
// test-results/retries-<name>.json with `suite: <name>`, so the integration
// lane is not filed under unit. A config without `projects` has a blank project
// name and uses the `suite` option instead (vitest.runtime.config.ts: runtime).
//
// A report is written on every finished run, empty `tests` included, so a
// missing file means the run did not finish, never "no flakes". The format and
// the reader are in scripts/lib/test-retries.mjs; scripts/flaky-report.mjs
// prints it.
//
// It also writes test-results/durations-<name>.json per project: each test
// file's duration, which `node scripts/test-durations.mjs --write` turns into
// the checked-in vitest.durations.json the shard sequencer reads
// (scripts/lib/test-durations.mjs has the format). These always go under
// test-results/, an explicit `outputFile` included.

import fs from 'node:fs';
import path from 'node:path';
import { buildDurationsReport, collectDurations } from './lib/test-durations.mjs';
import { buildReport, collectRetriedTests, sortTests } from './lib/test-retries.mjs';

export default class RetryReporter {
  constructor(options = {}) {
    this.suite = options.suite ?? 'tests';
    // An explicit file gets one report labelled `suite`, every project's tests
    // in it: a second project must not overwrite the first one's file.
    this.outputFile = options.outputFile;
  }

  onInit(ctx) {
    this.ctx = ctx;
  }

  onTestRunEnd(testModules) {
    const config = this.ctx.config;
    const retry = typeof config.retry === 'number' ? config.retry : (config.retry?.count ?? 0);
    const writeJson = (outputFile, report) => {
      const file = path.resolve(config.root, outputFile);
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`);
      } catch (error) {
        // A report that cannot be written must never fail the test run.
        this.ctx.logger.warn(`retry reporter: could not write ${file}: ${error.message}`);
      }
    };
    const write = (suite, tests, outputFile) =>
      writeJson(outputFile, buildReport({ suite, shard: config.shard, platform: process.platform, retry, tests }));

    for (const [name, files] of collectDurations(testModules)) {
      const project = name || this.suite;
      writeJson(
        `test-results/durations-${fileSafe(project)}.json`,
        buildDurationsReport({ project, shard: config.shard, platform: process.platform, files }),
      );
    }

    const byProject = collectRetriedTests(testModules);
    if (this.outputFile) {
      write(this.suite, sortTests([...byProject.values()].flat()), this.outputFile);
      return;
    }
    // No module at all still finished the run: one empty report says so.
    if (byProject.size === 0) byProject.set('', []);
    for (const [project, tests] of byProject) {
      const suite = project || this.suite;
      write(suite, tests, `test-results/retries-${fileSafe(suite)}.json`);
    }
  }
}

// A project name is free text; keep it to one plain path segment.
function fileSafe(name) {
  return name.replace(/[^\w.-]+/g, '-');
}
