import { describe, it, expect } from 'vitest';
import { Terminal } from '@xterm/headless';
import { restoreSeam } from '../restoreSeam';

const write = (term: Terminal, data: string) =>
  new Promise<void>((resolve) => term.write(data, resolve));

const viewportText = (term: Terminal): string[] => {
  const b = term.buffer.active;
  const rows: string[] = [];
  for (let y = 0; y < term.rows; y++) {
    rows.push(b.getLine(b.baseY + y)?.translateToString(true) ?? '');
  }
  return rows;
};

describe('restoreSeam', () => {
  it('scrolls the restored screen into scrollback and homes the cursor', async () => {
    const term = new Terminal({ cols: 80, rows: 24, scrollback: 1000, allowProposedApi: true });
    for (let i = 1; i <= 30; i++) await write(term, `history line ${i}\r\n`);
    await write(term, 'PS C:\\> '); // dead prompt, no trailing newline

    await write(term, restoreSeam(term.rows));

    const b = term.buffer.active;
    // Cursor is home on an empty viewport…
    expect(b.cursorX).toBe(0);
    expect(b.cursorY).toBe(0);
    expect(viewportText(term).every((row) => row === '')).toBe(true);
    // …and every restored row survives in scrollback.
    const scrollback: string[] = [];
    for (let y = 0; y < b.baseY; y++) {
      scrollback.push(b.getLine(y)?.translateToString(true) ?? '');
    }
    expect(scrollback.join('\n')).toContain('history line 1');
    expect(scrollback.join('\n')).toContain('history line 30');
    expect(scrollback.join('\n')).toContain('PS C:\\>');
  });

  it("aligns a fresh process's absolute repaints with its appended plain text", async () => {
    // The #952 failure shape: after restore, plain-text output appended at the
    // cursor and absolute-CUP repaints (PSReadLine) disagreed about where the
    // prompt is. After the seam both land on viewport row 1.
    const term = new Terminal({ cols: 80, rows: 24, scrollback: 1000, allowProposedApi: true });
    for (let i = 1; i <= 30; i++) await write(term, `history line ${i}\r\n`);

    await write(term, restoreSeam(term.rows));
    await write(term, 'PS C:\\> ');            // fresh prompt, plain text
    await write(term, '\x1b[1;9Hqweqwewqe');   // PSReadLine-style absolute repaint

    const b = term.buffer.active;
    const promptRow = b.getLine(b.baseY)?.translateToString(true) ?? '';
    expect(promptRow).toBe('PS C:\\> qweqwewqe');
    // No restored row was overdrawn (trailing scrollback rows are the old
    // viewport's blank tail; the content sits just above them).
    const tail: string[] = [];
    for (let y = Math.max(0, b.baseY - term.rows); y < b.baseY; y++) {
      tail.push(b.getLine(y)?.translateToString(true) ?? '');
    }
    expect(tail.join('\n')).toContain('history line 30');
  });

  it('exits the alternate screen in case the dump ended inside one', async () => {
    const term = new Terminal({ cols: 80, rows: 24, scrollback: 100, allowProposedApi: true });
    await write(term, 'normal content\r\n');
    await write(term, '\x1b[?1049h'); // dump ended mid-vim
    expect(term.buffer.active.type).toBe('alternate');

    await write(term, restoreSeam(term.rows));
    expect(term.buffer.active.type).toBe('normal');
  });

  it('clamps hostile row counts', () => {
    expect(restoreSeam(0)).toBe(restoreSeam(1));
    expect(restoreSeam(-5)).toBe(restoreSeam(1));
    expect(restoreSeam(Number.NaN)).toBe(restoreSeam(1));
    expect(restoreSeam(1e9).length).toBeLessThan(600);
  });
});
