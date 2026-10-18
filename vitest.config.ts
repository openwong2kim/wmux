import { configDefaults, defineConfig } from 'vitest/config';
import lanes from './vitest.lanes.json';

const include = [
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
];

// The runtime suites have their own config (vitest.runtime.config.ts). They
// are excluded here, not only by the `--exclude` flags in package.json and
// scripts/verify.sh: vitest applies a CLI `--exclude` to the root config, and
// with `projects` the root runs no files, so those flags no longer reach them.
const runtimeSuites = ['**/*.runtime.test.ts', '**/*.runtime.test.tsx', '**/*.runtime.test.mjs'];

export default defineConfig({
  test: {
    setupFiles: ['./src/test-utils/isolateDataDir.ts', './src/test-utils/jsdomEnv.ts'],
    environment: 'node',
    // Two lanes (scripts/lib/test-lanes.mjs has the rule, vitest.lanes.json the
    // result): `integration` holds the files that spawn processes, open
    // sockets or pipes, or run OS-touching code in a real temp dir; `unit` is
    // the rest. `npm run test:parallel` runs both; CI runs them as separate
    // jobs (test:unit, test:integration). Both keep per-file isolation:
    // isolateDataDir.ts gives every file a fresh temp HOME, and modules that
    // read HOME when they load see it only because each file imports them
    // anew, so turning `isolate` off is a decision of its own. Each project
    // inherits everything else in this config.
    projects: [
      {
        extends: true,
        test: { name: 'unit', include, exclude: [...configDefaults.exclude, ...runtimeSuites, ...lanes.integration] },
      },
      {
        extends: true,
        test: {
          name: 'integration',
          include: lanes.integration,
          // Half the cores: on CI's 4-vCPU windows-latest that is 2 test files
          // at a time, leaving the other 2 cores to the git, node and
          // PowerShell processes those files start. Every flake of the week
          // before this lane was a spawn or a write timing out on a runner
          // shared by one worker per core.
          maxWorkers: '50%',
          testTimeout: 30_000,
          hookTimeout: 30_000,
          // Required by vitest when two projects differ in maxWorkers. It also
          // means a combined run finishes the unit files first.
          sequence: { groupOrder: 1 },
        },
      },
    ],
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
