// Rendered parity of the Rust ANSI snapshot across resizes that reflow, the
// "unsupported-reflow" fallback reason. The Rust payload must replay like
// xterm's, or Rust must refuse where it still differs.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateSnapshotUnqueued } from '../HeadlessSnapshot';
import { getAnsiSnapshotBackendDiagnostics } from '../AnsiSnapshotBackend';
import { generateRustSnapshot } from '../RustSnapshot';
import { available, expectParity, expectRustAloneDiverges, liveDifference, modulePath, parity } from './_rustParity';
import { knownGaps, randomResizeCases, reflowCases } from './_reflowCases';

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

  // Seeded random resize sequences: whichever backend answers, the snapshot
  // replays like xterm's, and a refusal names its reason.
  it('replays seeded random resize sequences like xterm', async () => {
    let native = 0;
    const refused: Record<string, number> = {};
    // xterm's own payload does not restore the live terminal there, so it is
    // no reference (its serializer), and Rust is held to neither.
    const referenceOff: string[] = [];
    for (const c of randomResizeCases(3, 60)) {
      vi.stubEnv('WMUX_RUST_SNAPSHOT', 'off');
      const reference = await generateSnapshotUnqueued(c.req);
      vi.stubEnv('WMUX_RUST_SNAPSHOT', 'ansi');
      const selected = await generateSnapshotUnqueued(c.req);
      if (!reference.ok || !selected.ok) throw new Error(`${c.name}: snapshot failed`);
      if (getAnsiSnapshotBackendDiagnostics().last?.backend === 'rust') {
        const difference = await parity(c.req, selected.payload, reference.payload);
        if (difference === undefined) native++;
        else if (await liveDifference(c.req, reference.payload) !== undefined) referenceOff.push(c.name);
        else expect(difference, c.name).toBeUndefined();
      } else {
        const alone = await generateRustSnapshot(c.req, 'ansi');
        expect(alone.ok ? 'served' : alone.detail, c.name).toMatch(/^unsupported-/);
        const family = alone.ok ? 'served' : (alone.detail ?? '').split(':')[0];
        refused[family] = (refused[family] ?? 0) + 1;
      }
    }
    console.log(`random resize sequences: ${native}/60 native and in parity; refused: ${JSON.stringify(refused)}; xterm's payload off the live terminal: ${referenceOff.join(', ') || 'none'}`);
    // Most of them are served natively, in parity.
    expect(native).toBeGreaterThan(40);
  }, 120_000);

  it.each(knownGaps.map(c => [c.name, c] as const))('known gap, still diverges: %s', async (_name, c) => {
    await expectRustAloneDiverges(c);
  });
});
