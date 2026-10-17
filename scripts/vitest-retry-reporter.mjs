// Vitest reporter: write every retried test to a small JSON report.
//
// Wired in vitest.config.ts and vitest.runtime.config.ts on CI only, next to
// the default reporters. Vitest's own json and junit reporters do not record
// retries (v5), so this reads them from the reporter API the same way vitest's
// github-actions reporter does: TestCase.diagnostic().retryCount.
//
// The file is written on every finished run, empty `tests` included, so a
// missing file means the run did not finish, never "no flakes". The format and
// the reader are in scripts/lib/test-retries.mjs; scripts/flaky-report.mjs
// prints it.

import fs from 'node:fs';
import path from 'node:path';
import { buildReport, collectRetriedTests } from './lib/test-retries.mjs';

export default class RetryReporter {
  constructor(options = {}) {
    this.suite = options.suite ?? 'tests';
    this.outputFile = options.outputFile ?? `test-results/retries-${this.suite}.json`;
  }

  onInit(ctx) {
    this.ctx = ctx;
  }

  onTestRunEnd(testModules) {
    const config = this.ctx.config;
    const retry = typeof config.retry === 'number' ? config.retry : (config.retry?.count ?? 0);
    const report = buildReport({
      suite: this.suite,
      shard: config.shard,
      platform: process.platform,
      retry,
      tests: collectRetriedTests(testModules),
    });
    const file = path.resolve(config.root, this.outputFile);
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`);
    } catch (error) {
      // A report that cannot be written must never fail the test run.
      this.ctx.logger.warn(`retry reporter: could not write ${file}: ${error.message}`);
    }
  }
}
