import { describe, expect, it } from 'vitest';
import { loadNativeTerminalCore } from '../../shared/nativeTerminalCore';

// The built module's live screen (live-screen-v1), wired to nothing yet. Runs
// in the rust engine lane (vitest.rust-engine.config.ts), where the module is
// built; the Rust tests in core/wmux-term cover the rules.

interface ReplayTerminal {
  feedXterm(bytes: Uint8Array, requestedScrollback: number): boolean;
  resize(cols: number, rows: number): void;
  textSnapshot(undimmed: boolean): { rows: Array<{ text: string; wrapped: boolean }> };
  dispose(): void;
}

const HISTORY = 300;

function liveCore() {
  const core = loadNativeTerminalCore('live-screen-v1');
  const { NativeLiveScreen } = core;
  if (!NativeLiveScreen) throw new Error('live-screen-v1 without NativeLiveScreen');
  return { core, NativeLiveScreen };
}

/** A TUI-ish stream: a prompt, scrolling output, a full-screen app drawn in synchronized updates. */
function stream(): string[] {
  const chunks: string[] = ['$ build\r\n'];
  for (let i = 0; i < 60; i++) chunks.push(`\x1b[32mok\x1b[0m step ${i} 한글 ${'x'.repeat(i % 17)}\r\n`);
  chunks.push('\x1b[?1049h\x1b[?25l');
  for (let frame = 0; frame < 20; frame++) {
    chunks.push(`\x1b[?2026h\x1b[H\x1b[2J\x1b[1;1H\x1b[7m picker ${frame} \x1b[0m`);
    for (let row = 2; row <= 6; row++) chunks.push(`\x1b[${row};3H${row === 2 + (frame % 5) ? '>' : ' '} option ${row}`);
    chunks.push('\x1b[?2026l');
  }
  chunks.push('\x1b[?1049l\x1b[?25h$ done\r\n');
  return chunks;
}

describe.skipIf(process.env.WMUX_TERMINAL_CORE !== 'rust')('native live screen', () => {
  it('is in the module and reads like a replay of the same ring', () => {
    const { core, NativeLiveScreen } = liveCore();
    const NativeTerminal = (core as unknown as { NativeTerminal: new (c: number, r: number, s: number) => ReplayTerminal }).NativeTerminal;
    const ring = new core.NativeRing(1 << 20);
    ring.noteGeometry(40, 10);
    const live = new NativeLiveScreen(40, 10, HISTORY);
    expect(live.seed(ring)).toMatchObject({ status: 'ok' });

    const chunks = stream();
    chunks.forEach((chunk, i) => {
      const bytes = Buffer.from(chunk);
      // Cut inside the chunk too: a read can land mid-sequence.
      ring.write(bytes.subarray(0, 3));
      if (i % 7 === 0) expect(live.read(ring)).toMatchObject({ status: 'ok' });
      ring.write(bytes.subarray(3));
      if (i === 30) ring.noteGeometry(50, 12);
    });
    expect(live.read(ring)).toMatchObject({ status: 'ok' });
    expect(live.fedTo).toBe(ring.totalBytesWritten);
    expect(live.syncPending).toBe(false);
    expect(live.taint ?? null).toBeNull();
    expect(live.size).toEqual({ cols: 50, rows: 12 });

    const replay = new NativeTerminal(40, 10, HISTORY);
    const { data, geometry } = ring.readAllWithGeometry();
    let from = 0;
    for (const change of geometry?.changes ?? []) {
      replay.feedXterm(data.subarray(from, change.offset), HISTORY);
      replay.resize(change.cols, change.rows);
      from = change.offset;
    }
    replay.feedXterm(data.subarray(from), HISTORY);
    const expected = replay.textSnapshot(false).rows;
    const text = live.text(HISTORY, false);
    expect(text.rows.map((r) => r.text)).toEqual(expected.map((r) => r.text));
    expect(text.rows.map((r) => r.wrapped)).toEqual(expected.map((r) => r.wrapped));
    expect(text.rows.at(-1)?.text).toBe('$ done');
    replay.dispose();
    live.dispose();
    ring.dispose();
  });

  it('asks for a rebuild when the ring was cleared, and reads ranges from a lifetime offset', () => {
    const { core, NativeLiveScreen } = liveCore();
    const ring = new core.NativeRing(1 << 16);
    ring.noteGeometry(20, 4);
    ring.write(Buffer.from('abc'));
    const live = new NativeLiveScreen(20, 4);
    live.seed(ring);
    const readRange = ring.readRange?.bind(ring);
    if (!readRange) throw new Error('live-screen-v1 without readRange');
    const range = readRange(1);
    expect(range.data.toString()).toBe('bc');
    expect(range).toMatchObject({ end: 3, size: { cols: 20, rows: 4 }, clears: 0 });
    ring.clear();
    expect(live.read(ring)).toEqual(expect.objectContaining({ status: 'rebuild', reason: 'cleared' }));
    expect(() => readRange(1.5)).toThrow();
    live.dispose();
    ring.dispose();
  });
});
