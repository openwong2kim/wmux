import { defineConfig } from 'vitest/config';

// E0 conformance harness lane (spec §5-1·§5-2). Fourth lane fully separate from the
// existing three (test:parallel · test:runtime · test:rig). include glob catches only
// core/harness/ `*.harness.test.ts`, so it never overlaps existing lanes
// (src/**/__tests__/**, rig/**/*.rig.test.ts).
//
// fileParallelism: false — workload recording spawns real node-pty PTYs (macOS forkpty);
// parallel files cause PTY resource contention (same policy as rig lane). The differential
// runner itself uses @xterm/headless in-memory and is fast, but we serialize conservatively
// because it shares the lane with recording tests.
export default defineConfig({
  test: {
    include: ['core/harness/**/*.harness.test.ts'],
    environment: 'node',
    fileParallelism: false,
    // PTY spawn + bulk feed can exceed the default 5s — set generously.
    testTimeout: 60000,
    hookTimeout: 60000,
  },
});
