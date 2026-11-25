// The delivery frame is the ring replayed into a headless terminal. Claude's
// fullscreen renderer repaints by cell diff, so once the ring has dropped the
// bytes that last drew a row, that row comes back blank: the composer then
// reads as no composer ('unknown'), never as an empty one.
import { describe, expect, it } from 'vitest';
import { readComposer } from '../deliveryComposer';
import { RingBuffer } from '../RingBuffer';
import { OutputModeTracker } from '../util/outputModeTracker';
import { generateTextSnapshotUnqueued } from '../HeadlessSnapshot';
import { readSessionTextReplay } from '../sessionTextReplay';

const RULE = '─'.repeat(80);
const at = (row: number, col: number, text: string): string => `\x1b[${row};${col}H${text}`;

async function replay(capacity: number, draft: string): Promise<string[]> {
  const ring = new RingBuffer(capacity, 'node');
  const modes = new OutputModeTracker();
  const feed = (text: string): void => {
    ring.write(Buffer.from(text));
    modes.feed(text, ring.totalBytesWritten);
  };
  feed('\x1b[?1049h\x1b[2J');
  feed(at(3, 1, RULE) + at(4, 1, `❯\u00a0${draft}`) + at(5, 1, RULE) + at(6, 1, '  Opus · acct · ctx 9% · 7d 68%') + at(7, 1, '  ⏵⏵ bypass permissions on (shift+tab to cycle)'));
  // Output that repaints only the transcript row and the status line's number.
  for (let i = 0; i < 400; i++) feed(at(1, 1, `⏺ line ${i}`.padEnd(40)) + at(6, 23, `${10 + (i % 80)}%`));
  // The notice arrives; the top rule and the prompt glyph are redrawn, the cells that did not change are not.
  feed(at(2, 41, '✔ Update installed · /restart to apply') + at(3, 1, RULE) + at(4, 1, '❯'));
  const out = await generateTextSnapshotUnqueued({ cols: 80, rows: 10, scrollback: 0, initial: readSessionTextReplay(ring, modes) });
  if (!out.ok) throw new Error('snapshot failed');
  return out.rows.map((row) => row.text);
}

const read = (rows: string[]) => readComposer({ rows: Object.assign([...rows], { undimmed: rows }), cursorRow: 3 }, 'claude', 'paste').verdict;

describe('a delivery frame replayed from a wrapped ring', () => {
  it('a ring that still holds the whole frame reads the empty composer as plain', async () => {
    expect(read(await replay(1 << 20, ''))).toBe('plain');
  });

  it('a wrapped ring loses the closing rule and reads unknown, as the affected panes did', async () => {
    const rows = await replay(4096, '');
    expect(rows[3]).toBe('❯');
    expect(rows[4]).toBe('');
    expect(read(rows)).toBe('unknown');
  });

  it('a draft drawn before the ring\'s oldest byte is lost the same way: a blank cell is no proof of an empty prompt', async () => {
    const rows = await replay(4096, 'my draft');
    expect(rows[3]).toBe('❯');
    expect(read(rows)).not.toBe('plain');
  });
});
