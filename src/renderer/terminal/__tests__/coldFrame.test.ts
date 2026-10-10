import { describe, it, expect, beforeEach } from 'vitest';
import { Terminal as HeadlessTerminal } from '@xterm/headless';
import type { Terminal } from '@xterm/xterm';
import {
  captureColdFrame,
  coldFrameFits,
  dropColdFrame,
  rememberColdFrame,
  takeColdFrame,
  WarmFrameSwap,
  COLD_FRAME_MAX_CHARS,
  COLD_FRAME_MAX_ENTRIES,
  FULL_RESET,
  REPAINT_BEGIN,
  type ColdFrame,
  REPAINT_END,
  splitTrailingEscape,
  __coldFrameKeys,
  __resetColdFrames,
} from '../coldFrame';

// Cold-park reveal: a fresh mount of a cold-parked pane paints the frame its
// disposed terminal last showed, then swaps the daemon replay in over it.

function headless(cols = 40, rows = 6): HeadlessTerminal {
  return new HeadlessTerminal({ cols, rows, allowProposedApi: true, scrollback: 100 });
}

function write(term: HeadlessTerminal, data: string): Promise<void> {
  return new Promise((resolve) => term.write(data, resolve));
}

function screen(term: HeadlessTerminal): string[] {
  const buf = term.buffer.active;
  const rows: string[] = [];
  for (let y = 0; y < term.rows; y++) {
    rows.push(buf.getLine(buf.baseY + y)?.translateToString(true) ?? '');
  }
  return rows;
}

const frame = (text: string, cols = 80, rows = 24) => ({ frame: text, cols, rows });

function takeOrFail(ptyId: string): ColdFrame {
  const entry = takeColdFrame(ptyId);
  if (!entry) throw new Error(`no cold frame for ${ptyId}`);
  return entry;
}

describe('cold frame cache', () => {
  beforeEach(() => __resetColdFrames());

  it('is keyed by ptyId and single-use', () => {
    rememberColdFrame('a', frame('A'));
    rememberColdFrame('b', frame('B'));
    expect(takeColdFrame('a')?.frame).toBe('A');
    // The mount that painted it owns the screen now; nothing else may.
    expect(takeColdFrame('a')).toBeNull();
    expect(takeColdFrame('b')?.frame).toBe('B');
    expect(takeColdFrame('missing')).toBeNull();
  });

  it(`holds at most ${COLD_FRAME_MAX_ENTRIES} entries and evicts the least recent first`, () => {
    for (let i = 0; i < COLD_FRAME_MAX_ENTRIES + 5; i++) rememberColdFrame(`p${i}`, frame(`F${i}`));
    const keys = __coldFrameKeys();
    expect(keys).toHaveLength(COLD_FRAME_MAX_ENTRIES);
    expect(keys[0]).toBe('p5');
    expect(takeColdFrame('p0')).toBeNull();
    expect(takeColdFrame(`p${COLD_FRAME_MAX_ENTRIES + 4}`)?.frame).toBe(`F${COLD_FRAME_MAX_ENTRIES + 4}`);
  });

  it('a recapture replaces the old frame and counts as the most recent', () => {
    rememberColdFrame('a', frame('old'));
    rememberColdFrame('b', frame('B'));
    rememberColdFrame('a', frame('new'));
    expect(__coldFrameKeys()).toEqual(['b', 'a']);
    expect(takeColdFrame('a')?.frame).toBe('new');
  });

  it('refuses empty and oversized frames, and an oversized recapture drops the old one', () => {
    rememberColdFrame('a', frame('old'));
    rememberColdFrame('a', frame('x'.repeat(COLD_FRAME_MAX_CHARS + 1)));
    expect(takeColdFrame('a')).toBeNull();
    rememberColdFrame('b', frame(''));
    expect(takeColdFrame('b')).toBeNull();
    rememberColdFrame('', frame('no id'));
    expect(__coldFrameKeys()).toEqual([]);
  });

  it('drops a frame when its PTY exits', () => {
    rememberColdFrame('a', frame('A'));
    dropColdFrame('a');
    expect(takeColdFrame('a')).toBeNull();
  });

  it('fits only a terminal of the same width', () => {
    expect(coldFrameFits(frame('A', 80, 24), 80)).toBe(true);
    expect(coldFrameFits(frame('A', 80, 24), 79)).toBe(false);
    expect(coldFrameFits(frame('A', 80, 24), 120)).toBe(false);
  });
});

describe('captureColdFrame (real serializer)', () => {
  beforeEach(() => __resetColdFrames());

  it('captures the viewport only, with geometry, and paints it back verbatim', async () => {
    const src = headless(40, 4);
    let history = '';
    for (let i = 0; i < 30; i++) history += `line ${i}\r\n`;
    await write(src, `${history}\x1b[31mred\x1b[0m prompt$ `);
    captureColdFrame('p', src as unknown as Terminal);
    const cached = takeOrFail('p');
    expect(cached.cols).toBe(40);
    expect(cached.rows).toBe(4);
    // A few KB at most, not the scrollback.
    expect(cached.frame).not.toContain('line 0\r');
    expect(cached.frame.length).toBeLessThan(1024);

    const dst = headless(40, 4);
    await write(dst, cached.frame);
    expect(screen(dst)).toEqual(screen(src));
    expect(dst.buffer.active.cursorX).toBe(src.buffer.active.cursorX);
  });

  it('captures the alternate screen a TUI was showing, without its input modes', async () => {
    const src = headless(30, 4);
    await write(src, 'shell line\r\n');
    // A TUI: alt screen, mouse tracking, bracketed paste, app cursor keys.
    await write(src, '\x1b[?1049h\x1b[?1000h\x1b[?2004h\x1b[?1h\x1b[H\x1b[2JTUI top\x1b[4;1HTUI bottom');
    captureColdFrame('p', src as unknown as Terminal);
    const cached = takeOrFail('p');
    for (const mode of ['\x1b[?1000h', '\x1b[?2004h', '\x1b[?1h']) expect(cached.frame).not.toContain(mode);

    const dst = headless(30, 4);
    await write(dst, cached.frame);
    expect(screen(dst)).toEqual(screen(src));
    // The cosmetic frame must not change what keys and the pointer send.
    expect(dst.modes.mouseTrackingMode).toBe('none');
    expect(dst.modes.bracketedPasteMode).toBe(false);
    expect(dst.modes.applicationCursorKeysMode).toBe(false);
  });

  it('never throws on a terminal it cannot read', () => {
    const broken = { loadAddon: () => { throw new Error('disposed'); }, cols: 1, rows: 1 };
    expect(() => captureColdFrame('p', broken as unknown as Terminal)).not.toThrow();
    expect(takeColdFrame('p')).toBeNull();
  });
});

describe('WarmFrameSwap', () => {
  it('stays out of the way when no frame was painted', () => {
    const swap = new WarmFrameSwap();
    expect(swap.onData('abc')).toBe('abc');
    expect(swap.onFlush(100)).toBeNull();
    expect(swap.settleHeld()).toBeNull();
    expect(swap.phase).toBe('idle');
  });

  it('prefixes only the first payload with RIS + BEGIN and owes END at the flush', () => {
    const swap = new WarmFrameSwap();
    swap.painted();
    expect(swap.onData('chunk1')).toBe(`${REPAINT_BEGIN}chunk1`);
    expect(swap.onData('chunk2')).toBe('chunk2');
    expect(swap.phase).toBe('open');
    expect(swap.onFlush(12)).toBe(REPAINT_END);
    expect(swap.phase).toBe('idle');
    expect(swap.onData('live')).toBe('live');
    expect(swap.onFlush(0)).toBeNull();
  });

  it('drops the cached frame with a bare RIS when the daemon replayed nothing', () => {
    const swap = new WarmFrameSwap();
    swap.painted();
    expect(swap.onFlush(0)).toBe(FULL_RESET);
    expect(swap.onData('live')).toBe('live');
  });

  it('closes after held payloads when the flush marker overtook them', () => {
    const swap = new WarmFrameSwap();
    swap.painted();
    // Flush first (the replay is still held behind the scrollback load)…
    expect(swap.onFlush(500)).toBeNull();
    expect(swap.phase).toBe('warm');
    // …then the held payloads are delivered, then END.
    expect(swap.onData('held1')).toBe(`${REPAINT_BEGIN}held1`);
    expect(swap.onData('held2')).toBe('held2');
    expect(swap.settleHeld()).toBe(REPAINT_END);
    expect(swap.phase).toBe('idle');
  });

  it('settleHeld owes nothing when the flush has not arrived yet', () => {
    const swap = new WarmFrameSwap();
    swap.painted();
    expect(swap.onData('held')).toBe(`${REPAINT_BEGIN}held`);
    expect(swap.settleHeld()).toBeNull();
    expect(swap.onFlush(4)).toBe(REPAINT_END);
  });

  it('holds back an escape sequence a payload ends inside and sends it after END', () => {
    const swap = new WarmFrameSwap();
    swap.painted();
    expect(swap.onData('hello\x1b[12;')).toBe(`${REPAINT_BEGIN}hello`);
    // A later payload picks the held bytes up in front of it…
    expect(swap.onData('6Hx\x1b]0;ti')).toBe('\x1b[12;6Hx');
    // …and the flush closes the frame before what is still unfinished.
    expect(swap.onFlush(20)).toBe(`${REPAINT_END}\x1b]0;ti`);
    expect(swap.onData('tle\x07')).toBe('tle\x07');
  });

  it('close ends an open frame with the held-back bytes, and is a no-op otherwise', () => {
    const swap = new WarmFrameSwap();
    expect(swap.close()).toBeNull();
    swap.painted();
    expect(swap.close()).toBeNull();
    swap.onData('a\x1b[');
    expect(swap.close()).toBe(`${REPAINT_END}\x1b[`);
    expect(swap.phase).toBe('idle');
    expect(swap.close()).toBeNull();
  });

  it('cancel forgets the swap (a resync repainted from scratch)', () => {
    const swap = new WarmFrameSwap();
    swap.painted();
    swap.onData('x');
    swap.cancel();
    expect(swap.onFlush(10)).toBeNull();
    expect(swap.phase).toBe('idle');
  });
});

describe('the swap sequence on a real parser', () => {
  it('RIS + BEGIN replaces the cached frame and holds rendering until END', async () => {
    const term = headless(30, 4);
    await write(term, 'cached frame row 1\r\ncached frame row 2');
    // Daemon snapshot, as it arrives: first chunk prefixed, then the rest.
    await write(term, `${REPAINT_BEGIN}snapshot row 1\r\n`);
    // The renderer buffers rows while this is set: no empty or half frame.
    expect(term.modes.synchronizedOutputMode).toBe(true);
    await write(term, 'snapshot row 2');
    expect(term.modes.synchronizedOutputMode).toBe(true);
    await write(term, REPAINT_END);
    expect(term.modes.synchronizedOutputMode).toBe(false);

    // Exactly what a fresh terminal shows for the same snapshot: nothing of
    // the cached frame survives, on screen or in scrollback.
    const fresh = headless(30, 4);
    await write(fresh, 'snapshot row 1\r\nsnapshot row 2');
    expect(screen(term)).toEqual(screen(fresh));
    expect(term.buffer.active.length).toBe(fresh.buffer.active.length);
    expect(term.buffer.active.cursorX).toBe(fresh.buffer.active.cursorX);
    expect(term.buffer.active.cursorY).toBe(fresh.buffer.active.cursorY);
  });

  // A snapshot ends with the escape sequence the daemon's ring was still
  // inside (HeadlessSnapshot's partial tail); the live bytes after the flush
  // marker finish it. END must not land in between.
  async function swapAcrossFlush(replay: string, live: string): Promise<{ term: HeadlessTerminal; titles: string[] }> {
    const term = headless(30, 14);
    const titles: string[] = [];
    term.onTitleChange((title) => titles.push(title));
    await write(term, 'cached frame');
    const swap = new WarmFrameSwap();
    swap.painted();
    await write(term, swap.onData(replay));
    await write(term, swap.onFlush(replay.length) ?? '');
    await write(term, swap.onData(live));
    return { term, titles };
  }

  it('a flush boundary inside a CSI still positions the cursor', async () => {
    const { term } = await swapAcrossFlush('hello\x1b[12;', '6HX');
    expect(term.modes.synchronizedOutputMode).toBe(false);
    expect(screen(term)[0]).toBe('hello');
    expect(screen(term)[11]).toBe('     X');
    expect(term.buffer.active.cursorX).toBe(6);
    expect(term.buffer.active.cursorY).toBe(11);
  });

  it('a flush boundary inside an OSC still sets the title', async () => {
    const { term, titles } = await swapAcrossFlush('hello\x1b]0;my ti', 'tle\x07 world');
    expect(term.modes.synchronizedOutputMode).toBe(false);
    expect(titles).toEqual(['my title']);
    expect(screen(term)[0]).toBe('hello world');
  });

  it('a flush boundary inside a long OSC (a raw replay has no tail cap) still sets the title', async () => {
    const long = 'x'.repeat(6000);
    const { term, titles } = await swapAcrossFlush(`hello\x1b]0;${long}`, 'y\x07 world');
    expect(titles).toEqual([`${long}y`]);
    expect(screen(term)[0]).toBe('hello world');
  });

  it('splitTrailingEscape lets a resync write END before the replay tail, across chunks', async () => {
    const held = [
      { data: 'hello\x1b', replay: true },
      { data: '[12;', replay: true },
    ];
    const { complete, pending } = splitTrailingEscape(held);
    expect(complete).toEqual([{ data: 'hello', replay: true }]);
    expect(pending).toEqual({ data: '\x1b[12;', replay: true });
    const term = headless(30, 14);
    await write(term, `cached${REPAINT_BEGIN}`);
    for (const chunk of complete) await write(term, chunk.data);
    await write(term, REPAINT_END);
    await write(term, pending?.data ?? '');
    await write(term, '6HX');
    expect(screen(term)[0]).toBe('hello');
    expect(term.buffer.active.cursorX).toBe(6);
    expect(term.buffer.active.cursorY).toBe(11);
    // A replay that ends at ground passes through untouched.
    const whole = [{ data: 'a\x1b[1m', replay: true }, { data: 'b', replay: false }];
    expect(splitTrailingEscape(whole)).toEqual({ complete: whole, pending: null });
  });

  it('RIS leaves no mode the cached frame or an old screen had set', async () => {
    const term = headless(30, 4);
    await write(term, '\x1b[?1049h\x1b[?1000h\x1b[?25lold');
    await write(term, `${REPAINT_BEGIN}new${REPAINT_END}`);
    expect(term.buffer.active.type).toBe('normal');
    expect(term.modes.mouseTrackingMode).toBe('none');
    expect(screen(term)[0]).toBe('new');
  });
});
