// @vitest-environment jsdom
//
// What main's replay reset gate does to a real xterm 6.1 when a session's
// ring is flushed to the renderer a second time: the second replay must
// replace what the pane shows (scrollback included) and leave alone what the
// terminal negotiated with the app: kitty keyboard flags, bracketed paste, and
// a DEC 2026 hold the renderer opened in front of the replay. Replays are the
// daemon's real ones: the raw ring, or a HeadlessSnapshot of it.

import { describe, expect, it } from 'vitest';
import { Terminal } from '@xterm/xterm';
import { generateSnapshotUnqueued } from '../../../daemon/HeadlessSnapshot';
import { createReplayResetGate } from '../../../main/ipc/handlers/replayResetGate';
import { xtermKittyFlags } from '../kittyKeyboard';
import { WarmFrameSwap } from '../coldFrame';

const COLS = 40;
const ROWS = 10;
const write = (t: Terminal, data: string) => new Promise<void>((resolve) => t.write(data, resolve));
const terminal = () => new Terminal({
  cols: COLS, rows: ROWS, scrollback: 1000, allowProposedApi: true, vtExtensions: { kittyKeyboard: true },
} as never);
function lines(t: Terminal, which: 'normal' | 'alternate'): string[] {
  const buf = which === 'normal' ? t.buffer.normal : t.buffer.alternate;
  const out: string[] = [];
  for (let i = 0; i < buf.length; i++) out.push((buf.getLine(i)?.translateToString(true) ?? '').trimEnd());
  while (out.length > 0 && out[out.length - 1] === '') out.pop();
  return out;
}
async function snapshotOf(ring: string): Promise<string> {
  const out = await generateSnapshotUnqueued({ cols: COLS, rows: ROWS, initial: Buffer.from(ring), scrollback: 1000 } as never);
  if (!out.ok) throw new Error(`snapshot failed: ${JSON.stringify(out)}`);
  return (out as unknown as { payload: Buffer }).payload.toString('utf8');
}
/**
 * The pane got `ring` as its first flush; now the same session flushes
 * `second` (all of it through the gate, as pty.handler forwards it).
 */
async function secondFlush(ring: string, second: string): Promise<Terminal> {
  const gate = createReplayResetGate(() => undefined);
  const t = terminal();
  await write(t, gate.outgoing('p', ring, true));
  gate.flushed('p');
  await write(t, gate.outgoing('p', second, true));
  return t;
}
const kitty = (t: Terminal) => (t as unknown as { _core: { coreService: { kittyKeyboard: { flags: number; mainFlags: number; altFlags: number; mainStack: number[]; altStack: number[] } } } })._core.coreService.kittyKeyboard;
/** What a pane that only ever got `replay` shows. */
async function shownBy(replay: string): Promise<Terminal> {
  const t = terminal();
  await write(t, replay);
  return t;
}

// An inline app (Claude Code, Codex) on the main screen: kitty flags pushed,
// bracketed paste on, three viewports of history.
const INLINE = 'shell$ claude\r\n\x1b[?2004h\x1b[>1u' + Array.from({ length: 30 }, (_, i) => `row-${i}\r\n`).join('') + '> prompt';
// A full-screen app on the alternate screen, with kitty flags pushed there.
const FULLSCREEN = Array.from({ length: 20 }, (_, i) => `sh-${i}\r\n`).join('')
  + 'shell$ vim\r\n\x1b[?1049h\x1b[>1u\x1b[H\x1b[2Jvim-line-1\r\nvim-line-2';
// The same app with mouse tracking on.
const FULLSCREEN_MOUSE = FULLSCREEN.replace('\x1b[>1u', '\x1b[>1u\x1b[?1000h');

describe('a second replay through the reset gate', { timeout: 60_000 }, () => {
  for (const kind of ['snapshot', 'raw'] as const) {
    it(`replaces history taller than the pane, scrollback included (${kind})`, async () => {
      const second = kind === 'snapshot' ? await snapshotOf(INLINE) : INLINE;
      const t = await secondFlush(INLINE, second);
      const truth = await shownBy(second);
      expect(lines(t, 'normal').filter((l) => l === 'row-0')).toHaveLength(1);
      expect(lines(t, 'normal')).toEqual(lines(truth, 'normal'));
    });

    it(`keeps an inline app's kitty flags and bracketed paste (${kind})`, async () => {
      const second = kind === 'snapshot' ? await snapshotOf(INLINE) : INLINE;
      const t = await secondFlush(INLINE, second);
      expect(xtermKittyFlags(t)).toBe(1);
      expect(t.modes.bracketedPasteMode).toBe(true);
    });

    it(`repaints a pane on the alternate screen without doubling the main one (${kind})`, async () => {
      const second = kind === 'snapshot' ? await snapshotOf(FULLSCREEN) : FULLSCREEN;
      const t = await secondFlush(FULLSCREEN, second);
      const truth = await shownBy(second);
      expect(t.buffer.active.type).toBe('alternate');
      expect(lines(t, 'alternate')).toEqual(lines(truth, 'alternate'));
      expect(lines(t, 'normal').filter((l) => l === 'sh-5')).toHaveLength(1);
      // The app's flags on its screen, and none for the shell once it quits.
      expect(xtermKittyFlags(t)).toBe(1);
      await write(t, '\x1b[<u\x1b[?1049l');
      expect(xtermKittyFlags(t)).toBe(0);
    });
  }

  it('keeps the DEC 2026 hold a cold-frame swap opened in front of the replay', async () => {
    const gate = createReplayResetGate(() => undefined);
    const t = terminal();
    await write(t, gate.outgoing('p', INLINE, true));
    gate.flushed('p');
    // The pane was cold-parked; its fresh mount painted the cached frame.
    const swap = new WarmFrameSwap();
    swap.painted();
    await write(t, swap.onData(gate.outgoing('p', 'PS> first chunk\r\n', true)));
    expect(t.modes.synchronizedOutputMode).toBe(true);
  });

  it('brings a pane left on the alternate screen back when the app quit while it was away', async () => {
    // The pane got vim; vim quit during a pipe gap, and the shell printed more.
    const gap = '\x1b[<u\x1b[?1000l\x1b[?1049lshell$ after\r\nshell$ ';
    const second = await snapshotOf(FULLSCREEN_MOUSE + gap);
    const t = await secondFlush(FULLSCREEN_MOUSE, second);
    const truth = await shownBy(second);
    expect(t.buffer.active.type).toBe('normal');
    expect(lines(t, 'normal')).toEqual(lines(truth, 'normal'));
    expect(xtermKittyFlags(t)).toBe(0);
    // The next full-screen app starts with no flags of vim's.
    await write(t, '\x1b[?1049h');
    expect(xtermKittyFlags(t)).toBe(0);
  });

  it("keeps an inline app's flags when the pane missed the session entering the alternate screen", async () => {
    const t = await secondFlush(INLINE, await snapshotOf(`${INLINE}\x1b[?1049h\x1b[Halt view`));
    // As a pane that saw it live: no flags on the alternate screen, the app's back on main.
    expect(t.buffer.active.type).toBe('alternate');
    expect(xtermKittyFlags(t)).toBe(0);
    await write(t, '\x1b[?1049l');
    expect(xtermKittyFlags(t)).toBe(1);
  });

  it("does not double an app's kitty pushes that a raw replay carries again", async () => {
    const inline = await secondFlush(INLINE, INLINE);
    expect(kitty(inline).mainStack).toEqual([0]);
    await write(inline, '\x1b[<u');
    expect(xtermKittyFlags(inline)).toBe(0);

    const full = await secondFlush(FULLSCREEN, FULLSCREEN);
    expect(kitty(full).altStack).toEqual([0]);
    await write(full, '\x1b[<u\x1b[?1049l\x1b[?1049h');
    expect(xtermKittyFlags(full)).toBe(0);
  });
});
