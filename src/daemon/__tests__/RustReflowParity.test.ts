// Rendered parity of the Rust ANSI snapshot across resizes that reflow, the
// "unsupported-reflow" fallback reason. The Rust payload must replay like
// xterm's, or Rust must refuse where it still differs.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateSnapshotUnqueued, type SnapshotRequest } from '../HeadlessSnapshot';
import { getAnsiSnapshotBackendDiagnostics } from '../AnsiSnapshotBackend';
import { generateRustSnapshot } from '../RustSnapshot';
import { available, expectParity, expectRustAloneDiverges, liveDifference, liveDifferenceExcept, modulePath, parity } from './_rustParity';
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
    // xterm's own payload does not restore the live terminal there (its
    // serializer misplaces the cursor column), so Rust is held to the live
    // terminal instead: in full, or, for a known gap, in full but that field.
    const referenceOff: string[] = [];
    const knownGaps: Record<string, (req: SnapshotRequest, payload: Buffer) => Promise<string | undefined>> = {
      // The row the history cap cut a paragraph at: a continuation on the
      // live terminal, which no payload can begin with. The rest matches.
      'random-3-50': (req, payload) => liveDifferenceExcept(req, payload, (state) => { if (state.rows[0]) state.rows[0].wrapped = false; }),
    };
    for (const c of randomResizeCases(3, 60)) {
      vi.stubEnv('WMUX_RUST_SNAPSHOT', 'off');
      const reference = await generateSnapshotUnqueued(c.req);
      vi.stubEnv('WMUX_RUST_SNAPSHOT', 'ansi');
      const selected = await generateSnapshotUnqueued(c.req);
      if (!reference.ok || !selected.ok) throw new Error(`${c.name}: snapshot failed`);
      if (getAnsiSnapshotBackendDiagnostics().last?.backend === 'rust') {
        const difference = await parity(c.req, selected.payload, reference.payload);
        if (difference === undefined) native++;
        else if (await liveDifference(c.req, reference.payload) !== undefined) {
          referenceOff.push(c.name);
          const gap = knownGaps[c.name];
          expect(gap ? await gap(c.req, selected.payload) : await liveDifference(c.req, selected.payload), c.name).toBeUndefined();
        } else expect(difference, c.name).toBeUndefined();
      } else {
        const alone = await generateRustSnapshot(c.req, 'ansi');
        expect(alone.ok ? 'served' : alone.detail, c.name).toMatch(/^unsupported-/);
        const family = alone.ok ? 'served' : (alone.detail ?? '').split(':')[0];
        refused[family] = (refused[family] ?? 0) + 1;
      }
    }
    console.log(`random resize sequences: ${native}/60 native and in parity with xterm; refused: ${JSON.stringify(refused)}; xterm's payload off the live terminal, Rust checked against it instead: ${referenceOff.join(', ') || 'none'}`);
    // Most of them are served natively, in parity.
    expect(native).toBeGreaterThan(40);
  }, 120_000);

  // xterm moves a cursor never saved with the rows a narrowing adds above it.
  // xterm's own payload loses that row as well, so parity with it cannot see
  // the loss: Rust is held to the live terminal, whose probe ?1049l restores
  // that row (#3518).
  it('restores a default saved row a narrowing moved, as the live terminal does', async () => {
    const initial = Buffer.from('aaaaaaaaaaaaaaa\r\nb');
    const req: SnapshotRequest = { cols: 10, rows: 4, scrollback: 100, initial,
      geometry: { start: { cols: 20, rows: 4 }, changes: [{ offset: initial.length, cols: 10, rows: 4 }] } };
    const rust = await generateRustSnapshot(req, 'ansi');
    if (!rust.ok) throw new Error(`refused: ${rust.detail}`);
    expect(await liveDifference(req, rust.payload)).toBeUndefined();
    vi.stubEnv('WMUX_RUST_SNAPSHOT', 'off');
    const reference = await generateSnapshotUnqueued(req);
    if (!reference.ok) throw new Error('reference failed');
    expect(await liveDifference(req, reference.payload)).toBeDefined();
  });

  it.each(knownGaps.map(c => [c.name, c] as const))('known gap, still diverges: %s', async (_name, c) => {
    await expectRustAloneDiverges(c);
  });
});
