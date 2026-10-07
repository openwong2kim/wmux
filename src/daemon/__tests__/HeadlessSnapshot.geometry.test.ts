import { describe, it, expect } from 'vitest';
import { Terminal } from '@xterm/headless';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { generateSnapshot } from '../HeadlessSnapshot';
import { RingBuffer } from '../RingBuffer';

// A replay that parses the whole ring at the current width garbles history
// written at another width: an inline TUI's cursor-up redraw lands on the
// wrong row. With the ring's recorded sizes the snapshot must match a
// terminal that lived through the resize.

function makeTerminal(cols: number, rows: number): Terminal {
  const t = new Terminal({ cols, rows, scrollback: 5000, allowProposedApi: true });
  t.loadAddon(new Unicode11Addon());
  t.unicode.activeVersion = '11';
  return t;
}

function writeAsync(t: Terminal, data: string | Uint8Array): Promise<void> {
  return new Promise<void>((resolve) => t.write(data as string | Uint8Array, resolve));
}

function screenText(t: Terminal): string[] {
  const buf = t.buffer.normal;
  const lines: string[] = [];
  for (let i = 0; i < buf.length; i++) lines.push(buf.getLine(i)?.translateToString(true) ?? '');
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

// Written at 80 columns: a 70-column line, a prompt, then a redraw of the
// line above (cursor up one row, carriage return, overwrite).
const AT_80 = Buffer.from(`${'X'.repeat(70)}\r\nprompt\x1b[1A\r${'Y'.repeat(70)}\x1b[1B\r`);
// After the pane narrowed to 40 columns.
const AT_40 = Buffer.from('prompt> ok');

async function liveReference(): Promise<Terminal> {
  const t = makeTerminal(80, 10);
  await writeAsync(t, AT_80);
  t.resize(40, 10);
  await writeAsync(t, AT_40);
  return t;
}

describe('generateSnapshot with recorded sizes', () => {
  it('matches a terminal that lived through the resize', async () => {
    const ring = new RingBuffer(1024 * 1024);
    ring.noteGeometry(80, 10);
    ring.write(AT_80);
    ring.noteGeometry(40, 10);
    ring.write(AT_40);
    const { data, geometry } = ring.readAllWithGeometry();

    const outcome = await generateSnapshot({ cols: 40, rows: 10, initial: data, geometry });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const restored = makeTerminal(40, 10);
    await writeAsync(restored, outcome.payload);

    expect(screenText(restored)).toEqual(screenText(await liveReference()));
  });

  it('without the sizes the same history comes out garbled (the bug)', async () => {
    const outcome = await generateSnapshot({ cols: 40, rows: 10, initial: Buffer.concat([AT_80, AT_40]) });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const restored = makeTerminal(40, 10);
    await writeAsync(restored, outcome.payload);

    expect(screenText(restored)).not.toEqual(screenText(await liveReference()));
  });
});
