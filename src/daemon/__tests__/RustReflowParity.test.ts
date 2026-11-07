// Rendered parity of the Rust ANSI snapshot across resizes that reflow, the
// "unsupported-reflow" fallback reason. The Rust payload must replay like
// xterm's, or Rust must refuse where it still differs.
import { afterEach, beforeEach, describe, it, vi } from 'vitest';
import { available, expectParity, modulePath } from './_rustParity';
import { reflowCases } from './_reflowCases';

describe.skipIf(!available)('Rust ANSI snapshot parity across reflowing resizes', { timeout: 30_000 }, () => {
  beforeEach(() => vi.stubEnv('WMUX_RUST_SNAPSHOT_MODULE', modulePath));
  afterEach(() => vi.unstubAllEnvs());

  it.each(reflowCases.map(c => [c.name, c] as const))('%s', async (_name, c) => {
    await expectParity(c);
  });
});
