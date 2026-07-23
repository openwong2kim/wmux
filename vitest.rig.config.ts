import { defineConfig } from 'vitest/config';

// Verification rig lane (design §1 / G3). Third lane fully separate from the existing
// two vitest lanes (test:parallel · test:runtime). include glob catches only top-level
// `rig/` `*.rig.test.ts`, so it never hits the existing lanes (src/**/__tests__/**).
//
// fileParallelism: false — each scenario spawns a real daemon process + isolated home;
// parallel files cause resource contention and port collisions (same policy as runtime lane).
export default defineConfig({
  test: {
    include: ['rig/**/*.rig.test.ts'],
    environment: 'node',
    fileParallelism: false,
    // Daemon spawn + ready polling makes the default 5s timeout tight. Individual hooks/tests
    // also declare their own timeouts, but the lane default is set generously.
    testTimeout: 60000,
    hookTimeout: 60000,
  },
});
