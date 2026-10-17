import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    setupFiles: ['./src/test-utils/isolateDataDir.ts'],
    include: [
      'src/**/__tests__/**/*.test.{ts,tsx}',
      // Operational scripts (migration tooling) keep their tests
      // alongside the source so the algorithm and the test fixture stay
      // in lockstep. Pure ESM (no TS / no Vite transform required).
      'scripts/__tests__/**/*.test.mjs',
      // Plugin integrations (Phase 1 wmux × Claude Code) live outside
      // src/ so they can be packaged as Claude Code marketplace plugins
      // without dragging the rest of the repo. Tests for the
      // shared/signal-types boundary live next to the source.
      'integrations/**/__tests__/**/*.test.{ts,tsx}',
      // The APNs push relay is a separate Cloudflare Worker deployment (see
      // relay/README.md) but its tests run with the rest of the suite so a
      // change to the shared push envelope cannot break it unnoticed.
      'relay/__tests__/**/*.test.ts',
    ],
    environment: 'node',
    // CI only: retry a failed test once, so one flake no longer costs a full
    // rerun. Vitest's github-actions reporter (on by default in Actions) lists
    // every test that passed only on retry in the job summary.
    retry: process.env.CI ? 1 : 0,
    // CI only: also write every retried test to test-results/retries-unit.json
    // (scripts/vitest-retry-reporter.mjs), which the workflow lists with
    // scripts/flaky-report.mjs and uploads, so a flake that passed on retry is
    // recorded rather than lost in a green job. Naming any reporter replaces
    // vitest's defaults, so `default` and `github-actions` are listed again.
    ...(process.env.CI
      ? {
          reporters: [
            'default',
            ...(process.env.GITHUB_ACTIONS === 'true' ? ['github-actions'] : []),
            ['./scripts/vitest-retry-reporter.mjs', { suite: 'unit' }],
          ],
        }
      : {}),
  },
});
