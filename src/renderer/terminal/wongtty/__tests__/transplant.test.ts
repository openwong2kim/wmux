// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { Terminal } from '@xterm/xterm';
import { SerializeAddon } from '@xterm/addon-serialize';
import { serializeForTransplant } from '../transplant';

const isWongtty = vi.hoisted(() => ({ value: false }));
vi.mock('../load', () => ({ isWongttyTerminal: () => isWongtty.value }));

const write = (terminal: Terminal, data: string) => new Promise<void>((resolve) => terminal.write(data, resolve));

/** `out` replayed into a fresh terminal, as the new engine takes it. */
async function replayed(out: string, size: { cols?: number; rows?: number } = {}): Promise<Terminal> {
  const fresh = new Terminal({ allowProposedApi: true, ...size });
  await write(fresh, out);
  return fresh;
}

type DecPrivateModes = { cursorStyle?: string; cursorBlink?: boolean };
const row = (terminal: Terminal, y: number) => terminal.buffer.active.getLine(y)!.translateToString(true);
const decPrivateModes = (terminal: Terminal) => (terminal as unknown as { _core: { coreService: { decPrivateModes: DecPrivateModes } } })._core.coreService.decPrivateModes;

describe('serializeForTransplant (xterm.js)', () => {
  it('carries the SGR mouse encoding a TUI asked for, which SerializeAddon leaves out', async () => {
    const terminal = new Terminal({ allowProposedApi: true });
    await write(terminal, '\x1b[?1000h\x1b[?1006hTUI');
    const out = serializeForTransplant(terminal, 100) ?? '';
    expect(out).toContain('\x1b[?1000h');
    expect(out).toContain('\x1b[?1006h');

    // Replayed into a fresh terminal, the encoding is back.
    const fresh = new Terminal({ allowProposedApi: true });
    await write(fresh, out);
    expect((fresh as unknown as { _core: { mouseStateService: { activeEncoding: string } } })._core.mouseStateService.activeEncoding).toBe('SGR');
    terminal.dispose();
    fresh.dispose();
  });

  it('adds nothing for the default encoding', async () => {
    const terminal = new Terminal({ allowProposedApi: true });
    await write(terminal, '\x1b[?1000hplain');
    const out = serializeForTransplant(terminal, 100) ?? '';
    expect(out).not.toContain('\x1b[?1006h');
    expect(out).not.toContain('\x1b[?1016h');
    terminal.dispose();
  });

  it('puts the cursor back after the scroll margins, which home it', async () => {
    const terminal = new Terminal({ allowProposedApi: true });
    await write(terminal, 'line1\r\nline2\r\n\x1b[1;9r\x1b[5;7Hcursor-here');
    const fresh = await replayed(serializeForTransplant(terminal, 100) ?? '');
    expect([fresh.buffer.active.cursorX, fresh.buffer.active.cursorY]).toEqual([17, 4]);
    terminal.dispose();
    fresh.dispose();
  });

  it('puts the cursor back after margins that start below the top, without origin mode', async () => {
    const terminal = new Terminal({ allowProposedApi: true });
    await write(terminal, '\x1b[3;8r\x1b[5;7Hcursor');
    const fresh = await replayed(serializeForTransplant(terminal, 100) ?? '');
    expect([fresh.buffer.active.cursorX, fresh.buffer.active.cursorY]).toEqual([12, 4]);
    terminal.dispose();
    fresh.dispose();
  });

  it('puts the cursor back under origin mode with the full screen as margins', async () => {
    const terminal = new Terminal({ allowProposedApi: true });
    await write(terminal, '\x1b[?6h\x1b[5;7Hcursor');
    const fresh = await replayed(serializeForTransplant(terminal, 100) ?? '');
    expect(fresh.modes.originMode).toBe(true);
    expect([fresh.buffer.active.cursorX, fresh.buffer.active.cursorY]).toEqual([12, 4]);
    terminal.dispose();
    fresh.dispose();
  });

  it('keeps a wrap pending at the right edge under margins or origin mode, and the pen', async () => {
    for (const setup of ['\x1b[2;5r\x1b[3;1H', '\x1b[?6h\x1b[3;1H', '\x1b[2;5r\x1b[?6h\x1b[2;1H']) {
      const terminal = new Terminal({ allowProposedApi: true, cols: 20, rows: 6 });
      await write(terminal, `${setup}\x1b[31m${'A'.repeat(19)}\x1b[1;44mZ\x1b[0;32m`);
      expect(terminal.buffer.active.cursorX).toBe(20);
      const fresh = await replayed(serializeForTransplant(terminal, 100) ?? '', { cols: 20, rows: 6 });
      await write(fresh, 'BC');
      expect([row(fresh, 2), row(fresh, 3)]).toEqual([`${'A'.repeat(19)}Z`, 'BC']);
      const last = fresh.buffer.active.getLine(2)!.getCell(19)!;
      expect([last.getFgColor(), last.getBgColor(), !!last.isBold()]).toEqual([1, 4, true]);
      // Written with the pen the program left (green), not the re-written cell's.
      expect(fresh.buffer.active.getLine(3)!.getCell(0)!.getFgColor()).toBe(2);
      terminal.dispose();
      fresh.dispose();
    }
  });

  it('puts the cursor back relative to the margins under origin mode', async () => {
    const terminal = new Terminal({ allowProposedApi: true });
    await write(terminal, '\x1b[3;8r\x1b[?6h\x1b[2;4Horigin');
    const fresh = await replayed(serializeForTransplant(terminal, 100) ?? '');
    expect(fresh.modes.originMode).toBe(true);
    expect([fresh.buffer.active.cursorX, fresh.buffer.active.cursorY]).toEqual([9, 3]);
    terminal.dispose();
    fresh.dispose();
  });

  it('carries the cursor shape a program set (DECSCUSR), which SerializeAddon leaves out', async () => {
    for (const [seq, style, blink] of [['\x1b[5 q', 'bar', true], ['\x1b[4 q', 'underline', false], ['\x1b[2 q', 'block', false]] as const) {
      const terminal = new Terminal({ allowProposedApi: true });
      await write(terminal, `${seq}TUI`);
      const fresh = await replayed(serializeForTransplant(terminal, 100) ?? '');
      expect(decPrivateModes(fresh)).toMatchObject({ cursorStyle: style, cursorBlink: blink });
      terminal.dispose();
      fresh.dispose();
    }
  });
});

describe('serializeForTransplant (wongtty fallbacks)', () => {
  // ansiSnapshot refuses the whole terminal (scroll margins: 'margins', with
  // the modes left out it paints) or any of it ('refuse').
  class Snapshotting extends Terminal {
    constructor(private readonly mode: 'margins' | 'refuse', size: { cols?: number; rows?: number } = {}) { super({ allowProposedApi: true, ...size }); }
    ansiSnapshot(options: { scrollback: number; excludeModes: boolean }) {
      if (this.mode === 'refuse' || !options.excludeModes) return { ok: false as const, reason: this.mode };
      const addon = new SerializeAddon();
      this.loadAddon(addon);
      const text = addon.serialize({ scrollback: options.scrollback, excludeModes: true });
      addon.dispose();
      return { ok: true as const, payload: new TextEncoder().encode(text) };
    }
  }

  it('keeps the colours only when wongtty paints the screen, and the modes either way', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    isWongtty.value = true;
    try {
      for (const mode of ['margins', 'refuse'] as const) {
        const terminal = new Snapshotting(mode);
        await write(terminal, '\x1b[?2004h\x1b[?1000h\x1b[?1h\x1b[31mRED\x1b[0m\r\nnext');
        const fresh = await replayed(serializeForTransplant(terminal, 100) ?? '');
        expect(fresh.buffer.active.getLine(0)!.translateToString(true)).toBe('RED');
        expect(fresh.buffer.active.getLine(0)!.getCell(0)!.isFgDefault()).toBe(mode === 'refuse');
        expect(fresh.modes).toMatchObject({ bracketedPasteMode: true, mouseTrackingMode: 'vt200', applicationCursorKeysMode: true });
        expect([fresh.buffer.active.cursorX, fresh.buffer.active.cursorY]).toEqual([4, 1]);
        terminal.dispose();
        fresh.dispose();
      }
    } finally {
      isWongtty.value = false;
      vi.mocked(console.warn).mockRestore();
    }
  });

  it('carries the other public modes, and origin mode with the cursor it placed', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    isWongtty.value = true;
    try {
      for (const mode of ['margins', 'refuse'] as const) {
        const terminal = new Snapshotting(mode);
        await write(terminal, '\x1b[?25l\x1b[?66h\x1b[4h\x1b[?1004h\x1b[?7l\x1b[?1002h\x1b[3;8r\x1b[?6h\x1b[2;4Hab');
        const fresh = await replayed(serializeForTransplant(terminal, 100) ?? '');
        expect(fresh.modes).toMatchObject({
          showCursor: false, applicationKeypadMode: true, insertMode: true, sendFocusMode: true,
          wraparoundMode: false, mouseTrackingMode: 'drag', originMode: true,
        });
        // The margins stay behind, so the origin is the screen's top.
        expect([fresh.buffer.active.cursorX, fresh.buffer.active.cursorY]).toEqual([5, 3]);
        terminal.dispose();
        fresh.dispose();
      }
      for (const [seq, tracking] of [['\x1b[?1003h', 'any'], ['\x1b[?9h', 'x10']] as const) {
        const terminal = new Snapshotting('refuse');
        await write(terminal, seq);
        const fresh = await replayed(serializeForTransplant(terminal, 100) ?? '');
        expect(fresh.modes.mouseTrackingMode).toBe(tracking);
        terminal.dispose();
        fresh.dispose();
      }
    } finally {
      isWongtty.value = false;
      vi.mocked(console.warn).mockRestore();
    }
  });

  it('keeps a wrap pending at the right edge that the painted screen left, under origin mode', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    isWongtty.value = true;
    try {
      const terminal = new Snapshotting('margins', { cols: 20, rows: 6 });
      await write(terminal, `\x1b[2;5r\x1b[?6h\x1b[2;1H${'A'.repeat(20)}`);
      const fresh = await replayed(serializeForTransplant(terminal, 100) ?? '', { cols: 20, rows: 6 });
      await write(fresh, 'BC');
      expect([row(fresh, 2), row(fresh, 3)]).toEqual(['A'.repeat(20), 'BC']);
      expect(fresh.modes.originMode).toBe(true);
      terminal.dispose();
      fresh.dispose();
    } finally {
      isWongtty.value = false;
      vi.mocked(console.warn).mockRestore();
    }
  });
});
