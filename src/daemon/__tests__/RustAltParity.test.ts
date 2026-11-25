// Rendered parity of the Rust snapshot across alternate-screen width changes,
// once the "unsupported-reflow" fallback for them: a soft-wrapped row there
// stays wrapped in xterm across any width change, and now in the vendored
// grid too. Both the ANSI payload and the text rows.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getAnsiSnapshotBackendDiagnostics } from '../AnsiSnapshotBackend';
import { getTextSnapshotBackendDiagnostics } from '../TextSnapshotBackend';
import { generateSnapshotUnqueued, generateTextSnapshotUnqueued } from '../HeadlessSnapshot';
import { generateRustSnapshot } from '../RustSnapshot';
import { available, expectParity, liveDifference, liveDifferenceExcept, modulePath, parity } from './_rustParity';
import { altCases, randomAltCases } from './_altCases';

describe.skipIf(!available)('Rust snapshot parity across alternate-screen width changes', { timeout: 30_000 }, () => {
  beforeEach(() => vi.stubEnv('WMUX_RUST_SNAPSHOT_MODULE', modulePath));
  afterEach(() => vi.unstubAllEnvs());

  it.each(altCases.map(c => [c.name, c] as const))('ANSI %s', async (_name, c) => {
    await expectParity(c);
  });

  it.each(altCases.map(c => [c.name, c] as const))('text %s', async (_name, c) => {
    vi.stubEnv('WMUX_RUST_SNAPSHOT', 'off');
    const reference = await generateTextSnapshotUnqueued(c.req);
    vi.stubEnv('WMUX_RUST_SNAPSHOT', 'text');
    const before = getTextSnapshotBackendDiagnostics().native;
    const native = await generateTextSnapshotUnqueued(c.req);
    expect(getTextSnapshotBackendDiagnostics().native).toBe(before + 1);
    if (!reference.ok || !native.ok) throw new Error(`${c.name}: text snapshot failed`);
    expect(native.bufferType).toBe(reference.bufferType);
    const shape = (rows: Array<{ wrapped: boolean; text: string }>) => rows.map(row => [row.wrapped, row.text.trimEnd()]);
    expect(shape(native.rows)).toEqual(shape(reference.rows));
  });

  // Seeded random sequences: whichever backend answers, the snapshot replays
  // like xterm's, and a refusal names its reason.
  it('replays seeded random alternate-screen sequences like xterm', async () => {
    let native = 0;
    const refused: Record<string, number> = {};
    // xterm's own payload does not restore the live terminal there (its
    // serializer), so it is no reference. Rust is held to the live terminal
    // instead, all but the cells kept past the width, which no payload
    // carries: a row's text reads them, so the text is left out and the
    // visible cells are compared.
    const referenceOff: string[] = [];
    const visibleOnly = (state: { rows: Array<{ text: string }> }) => state.rows.forEach(row => { row.text = ''; });
    for (const c of randomAltCases(5, 60)) {
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
          expect(await liveDifferenceExcept(c.req, selected.payload, visibleOnly), c.name).toBeUndefined();
        } else expect(difference, c.name).toBeUndefined();
      } else {
        const alone = await generateRustSnapshot(c.req, 'ansi');
        expect(alone.ok ? 'served' : alone.detail, c.name).toMatch(/^unsupported-/);
        const family = alone.ok ? 'served' : (alone.detail ?? '').split(':')[0];
        refused[family] = (refused[family] ?? 0) + 1;
      }
    }
    console.log(`random alternate-screen sequences: ${native}/60 native and in parity; refused: ${JSON.stringify(refused)}; xterm's payload off the live terminal, Rust held to its visible cells instead: ${referenceOff.join(', ') || 'none'}`);
    // Most of them are served natively, in parity.
    expect(native).toBeGreaterThan(40);
  }, 120_000);
});
