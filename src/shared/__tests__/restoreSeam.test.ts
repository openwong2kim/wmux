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

  it('leaves the alternate screen however the dead program entered it, so the next program starts on a fresh one', async () => {
    // Claude Code 2.1 runs in the alternate screen. A recovered pane restores
    // the dead instance's frame, then `claude --resume` enters the alternate
    // screen again and diff-renders. Nothing of the dead frame may survive.
    // This also passes with the old `?1049l`-only seam: xterm's 47, 1047 and
    // 1049 exits all end in activateNormalBuffer. The real guard for the
    // three exits is the daemon tracker test in DaemonSessionManager.os.test.ts
    // ("keeps none of the dead program's screen modes").
    for (const entry of ['\x1b[?1049h', '\x1b[?1047h', '\x1b[?47h']) {
      const term = new Terminal({ cols: 80, rows: 24, scrollback: 100, allowProposedApi: true });
      await write(term, 'normal content\r\n' + entry);
      for (let i = 1; i <= 24; i++) await write(term, `\x1b[${i};1Hstale frame row ${i}`);

      await write(term, restoreSeam(term.rows));
      expect(term.buffer.active.type).toBe('normal');

      await write(term, 'PS C:\\> claude --resume x\r\n');
      await write(term, '\x1b[?1049h\x1b[22;1Hstatus line'); // a partial first frame, no erase
      expect(term.buffer.active.type).toBe('alternate');
      const rows = viewportText(term);
      expect(rows.filter((row) => row.includes('stale frame'))).toEqual([]);
      expect(rows[21]).toBe('status line');
    }
  });

  it('releases a scroll region the dead program left, so every restored row reaches scrollback', async () => {
    const term = new Terminal({ cols: 80, rows: 24, scrollback: 1000, allowProposedApi: true });
    for (let i = 1; i <= 24; i++) await write(term, `\x1b[${i};1Hstale row ${i}`);
    await write(term, '\x1b[1;10r\x1b[?6h'); // DECSTBM + DECOM, never released

    await write(term, restoreSeam(term.rows));

    expect(viewportText(term).every((row) => row === '')).toBe(true);
    const b = term.buffer.active;
    expect(b.cursorX).toBe(0);
    expect(b.cursorY).toBe(0);
    const scrollback: string[] = [];
    for (let y = 0; y < b.baseY; y++) scrollback.push(b.getLine(y)?.translateToString(true) ?? '');
    expect(scrollback.join('\n')).toContain('stale row 1');
    expect(scrollback.join('\n')).toContain('stale row 24');
    expect(term.modes.originMode).toBe(false);
  });

  it('returns the input and cursor modes the dead program armed to their power-on values', async () => {
    const term = new Terminal({ cols: 80, rows: 24, scrollback: 100, allowProposedApi: true });
    await write(term, '\x1b[?1h\x1b[?7l\x1b[?25l\x1b[?1000h\x1b[?1002h\x1b[?1003h\x1b[?1006h\x1b[?1004h\x1b[?2004h');

    await write(term, restoreSeam(term.rows));

    expect(term.modes.mouseTrackingMode).toBe('none');
    expect(term.modes.sendFocusMode).toBe(false);
    expect(term.modes.bracketedPasteMode).toBe(false);
    expect(term.modes.applicationCursorKeysMode).toBe(false);
    expect(term.modes.wraparoundMode).toBe(true);
    expect(term.modes.showCursor).toBe(true);
  });

  it('drops the kitty flags and application keypad a dead Claude Code left, on both screens', async () => {
    // A recovered macOS/Linux pane whose new shell emits no OSC 133 prompt
    // mark, so the renderer's prompt-mark kitty reset never fires.
    const term = new Terminal({ cols: 80, rows: 24, scrollback: 100, allowProposedApi: true, vtExtensions: { kittyKeyboard: true } });
    const flags = async (): Promise<string> => {
      const replies: string[] = [];
      const sub = term.onData((d) => replies.push(d));
      await write(term, '\x1b[?u'); // kitty flags query, answered through onData
      sub.dispose();
      return replies.join('');
    };
    // Claude Code pushes on the main screen, enters the alternate one and
    // pushes again there; the process dies without popping either.
    await write(term, '$ claude\r\n\x1b[>1u\x1b=\x1b[?1049h\x1b[>7ustale frame');
    expect(await flags()).toBe('\x1b[?7u');
    expect(term.modes.applicationKeypadMode).toBe(true);

    await write(term, restoreSeam(term.rows));

    expect(term.buffer.active.type).toBe('normal');
    expect(await flags()).toBe('\x1b[?0u');
    expect(term.modes.applicationKeypadMode).toBe(false);
    // A later alt-screen program (vim, a resumed Claude Code before its own
    // push) does not inherit the dead program's flags either.
    await write(term, '\x1b[?1049h');
    expect(await flags()).toBe('\x1b[?0u');
    await write(term, '\x1b[?1049l');
    expect(await flags()).toBe('\x1b[?0u');
    // What the fresh process negotiates after the seam stands.
    await write(term, '\x1b[>1u');
    expect(await flags()).toBe('\x1b[?1u');
  });

  it('resets SGR and leaves every alternate screen before the kitty round trip, and finishes it before parking the cursor', () => {
    const seam = restoreSeam(24);
    const at = (s: string) => seam.indexOf(s);
    expect(at('\x1b[?47l')).toBeLessThan(at('\x1b[0m'));
    expect(at('\x1b[0m')).toBeLessThan(at('\x1b[<99u\x1b[?47h\x1b[<99u\x1b[?47l'));
    expect(seam.lastIndexOf('\x1b[?47l')).toBeLessThan(at('\x1b[24;1H'));
  });

  it('clamps hostile row counts', () => {
    expect(restoreSeam(0)).toBe(restoreSeam(1));
    expect(restoreSeam(-5)).toBe(restoreSeam(1));
    expect(restoreSeam(Number.NaN)).toBe(restoreSeam(1));
    // 512 line feeds at most, plus the fixed mode resets.
    expect(restoreSeam(1e9).length).toBeLessThan(700);
  });
});
