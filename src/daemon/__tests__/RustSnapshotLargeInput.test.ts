/**
 * R2 (b) prep — a ring above the old 8 MiB cap, and a pane whose history
 * passes the old 1M-cell text cap, are snapshotted by the real native core
 * instead of being skipped to xterm for their size (nativeSnapshotLimits.ts).
 */
import { describe, expect, it } from 'vitest';
import { getAnsiSnapshotBackendDiagnostics, selectAnsiSnapshot } from '../AnsiSnapshotBackend';
import { getTextSnapshotBackendDiagnostics, selectTextSnapshot } from '../TextSnapshotBackend';
import { generateTextSnapshotUnqueued, type SnapshotRequest } from '../HeadlessSnapshot';
import { available } from './_rustParity';

/** Coloured lines of `cols - 8` characters, `bytes` long in all. */
function output(bytes: number, cols: number): Buffer {
  const lines: Buffer[] = [];
  let total = 0;
  for (let i = 0; total < bytes; i++) {
    const line = Buffer.from(`\x1b[3${i % 8}m${`row ${i} `.padEnd(cols - 8, 'abcdefghij')}\x1b[0m\r\n`);
    lines.push(line);
    total += line.length;
  }
  return Buffer.concat(lines).subarray(0, bytes);
}

const noFallback = async (): Promise<never> => { throw new Error('the request was not taken natively'); };

describe.skipIf(!available)('native snapshots past the old size caps', { timeout: 120_000 }, () => {
  // 16 MiB: twice the old cap, the size (b)'s tests name.
  const ring = output(16 * 1024 * 1024, 200);
  // 200 columns × (30 + 5000) rows = 1,006,000 cells, past the old 1M text cap.
  const req: SnapshotRequest = { cols: 200, rows: 30, scrollback: 5000, initial: ring, budgetMs: 60_000 };

  it('reads the text of a 16 MiB ring on a 200-column pane natively, as xterm does', async () => {
    const before = getTextSnapshotBackendDiagnostics().native;
    const native = await selectTextSnapshot(req, noFallback);
    expect(getTextSnapshotBackendDiagnostics().native).toBe(before + 1);
    const xterm = await generateTextSnapshotUnqueued(req);
    if (!native.ok || !xterm.ok) throw new Error(`snapshot failed: ${JSON.stringify({ native: !native.ok && native, xterm: !xterm.ok && xterm })}`);
    expect(native.rows).toHaveLength(5030);
    expect(native.rows.map(row => row.text)).toEqual(xterm.rows.map(row => row.text));
  });

  it('restores the ANSI screen of a 16 MiB ring natively', async () => {
    const before = getAnsiSnapshotBackendDiagnostics().native;
    const native = await selectAnsiSnapshot(req, noFallback);
    expect(native.ok).toBe(true);
    expect(getAnsiSnapshotBackendDiagnostics().native).toBe(before + 1);
  });
});
