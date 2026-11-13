// @wmux-lane unit
// The recorded Windows PTY chunk fixtures (src/daemon/__fixtures__/pty-chunks)
// stay as recorded: each file is gzip'd JSON Lines with a wmux-pty-chunks/1
// header, then chunks, resizes and input notes in time order, with the chunk
// counts and byte totals the README lists.
import { describe, expect, it } from 'vitest';
import { loadPtyChunkFixture, ptyChunkFixtureNames } from '../__fixtures__/pty-chunks/load';

// Chunks and decoded bytes per file, as recorded (README.md table). A scrub
// that changed a length, or a truncated or replaced file, changes these.
const RECORDED: Record<string, { chunks: number; bytes: number }> = {
  'nodepty-claude-burst.jsonl.gz': { chunks: 404, bytes: 30_283 },
  'nodepty-claude-permission.jsonl.gz': { chunks: 252, bytes: 24_689 },
  'rustpty-claude-burst.jsonl.gz': { chunks: 504, bytes: 37_750 },
  'rustpty-claude-permission.jsonl.gz': { chunks: 360, bytes: 29_119 },
};

describe('recorded PTY chunk fixtures', () => {
  it('has the four recordings', () => {
    expect(ptyChunkFixtureNames()).toEqual(Object.keys(RECORDED).sort());
  });

  it.each(Object.keys(RECORDED))('%s: a header, then the recorded chunks in time order', (name) => {
    const { header, rows, chunks } = loadPtyChunkFixture(name);
    expect(header.format).toBe('wmux-pty-chunks/1');
    expect(header.backend).toBe(name.startsWith('rustpty-') ? 'rustpty' : 'node-pty');
    expect(header.agent).toBe('claude');
    expect(header.cols).toBeGreaterThan(0);
    expect(header.rows).toBeGreaterThan(0);

    // Every chunk's base64 is canonical: Node's decoder skips characters it
    // does not know, so a damaged string would still decode to something.
    for (const row of rows) if ('b64' in row) expect(Buffer.from(row.b64, 'base64').toString('base64')).toBe(row.b64);
    expect({ chunks: chunks.length, bytes: chunks.reduce((sum, c) => sum + c.bytes.length, 0) }).toEqual(RECORDED[name]);
    expect(chunks.every((c) => c.bytes.length > 0)).toBe(true);

    expect(rows.every((row) => 'b64' in row || 'resize' in row || 'input' in row)).toBe(true);
    expect(rows.every((row, i) => i === 0 || row.t >= rows[i - 1].t)).toBe(true);
    expect(rows.some((row) => 'input' in row && row.input.startsWith('submit prompt'))).toBe(true);
  });
});
