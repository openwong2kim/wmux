// Rendered parity of the Rust ANSI snapshot across resizes that reflow, the
// "unsupported-reflow" fallback reason. The Rust payload must replay like
// xterm's, or Rust must refuse where it still differs.
import { afterEach, beforeEach, describe, it, vi } from 'vitest';
import { available, expectParity, expectRustAloneDiverges, modulePath } from './_rustParity';
import { reflowCases } from './_reflowCases';

describe.skipIf(!available)('Rust ANSI snapshot parity across reflowing resizes', { timeout: 30_000 }, () => {
  beforeEach(() => vi.stubEnv('WMUX_RUST_SNAPSHOT_MODULE', modulePath));
  afterEach(() => vi.unstubAllEnvs());

  it.each(reflowCases.map(c => [c.name, c] as const))('%s', async (_name, c) => {
    await expectParity(c);
  });

  // Each refusal is earned: Rust alone refuses, or differs from xterm.
  it.each(reflowCases.filter(c => c.backend === 'xterm').map(c => [c.name, c] as const))('%s: Rust alone diverges', async (_name, c) => {
    await expectRustAloneDiverges(c);
  });
});
