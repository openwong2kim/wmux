import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Source-level regression lock (#191 / #197). The WebGL teardown sites in
 * useTerminal run against a real GL context that jsdom can't provide, so we
 * assert on the SOURCE: every addon teardown that frees a context the pool's
 * budget is meant to bound must route through `teardownWebglAddon` (which calls
 * WEBGL_lose_context.loseContext) rather than a raw `dispose()`. A raw dispose
 * leaks the underlying WebGL2 context as a zombie, refilling the leak that
 * blanks live panes into X-boxes. The three guarded paths are the pool-evict
 * callback, the fonts.ready atlas rebuild, and the unmount cleanup.
 *
 * The onContextLoss handler is deliberately exempt: its context is already lost
 * when it runs, so a plain dispose there leaks nothing.
 */

const SRC = readFileSync(
  path.resolve(process.cwd(), 'src/renderer/hooks/useTerminal.ts'),
  'utf8',
);

describe('useTerminal WebGL teardown (source-level lock)', () => {
  it('imports the shared teardown helper', () => {
    expect(SRC).toMatch(
      /import\s*\{[^}]*\bteardownWebglAddon\b[^}]*\}\s*from\s*['"][^'"]*webglTeardown['"]/,
    );
  });

  it('routes the pool-evict, fonts.ready and unmount paths through teardownWebglAddon', () => {
    const calls = SRC.match(/teardownWebglAddon\(/g) ?? [];
    expect(calls.length).toBeGreaterThanOrEqual(3);
  });
});
