import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: [
      'src/**/__tests__/**/*.runtime.test.{ts,tsx}',
      'scripts/__tests__/**/*.runtime.test.mjs',
      'integrations/**/__tests__/**/*.runtime.test.{ts,tsx}',
    ],
    environment: 'node',
    fileParallelism: false,
    // Same temp HOME + data suffix as the parallel lane: runtime tests spawn real
    // sessions whose shell integration writes under the wmux data dir.
    setupFiles: ['./src/test-utils/isolateDataDir.ts'],
    // CI only: retry a failed test once, so one flake no longer costs a full
    // rerun. Vitest's github-actions reporter (on by default in Actions) lists
    // every test that passed only on retry in the job summary.
    retry: process.env.CI ? 1 : 0,
    // CI only: also write every retried test to test-results/retries-runtime.json
    // (scripts/vitest-retry-reporter.mjs), which the workflow lists with
    // scripts/flaky-report.mjs and uploads, so a flake that passed on retry is
    // recorded rather than lost in a green job. Naming any reporter replaces
    // vitest's defaults, so `default` and `github-actions` are listed again.
    ...(process.env.CI
      ? {
          reporters: [
            'default',
            ...(process.env.GITHUB_ACTIONS === 'true' ? ['github-actions'] : []),
            ['./scripts/vitest-retry-reporter.mjs', { suite: 'runtime' }],
          ],
        }
      : {}),
  },
});
