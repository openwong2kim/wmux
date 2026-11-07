// A read from the ring's newest 256 KiB must give the whole ring's answer or
// none. Each hazard fixture is first shown to be served WRONG by a tail that
// only checks for unknown cells (no cell is unknown, yet the rows differ),
// then shown to fall back, with its reason, to the whole ring's answer.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RingBuffer } from '../RingBuffer';
import { OutputModeTracker } from '../util/outputModeTracker';
import { generateTextSnapshotUnqueued, type TextSnapshotOutcome } from '../HeadlessSnapshot';
import { UNKNOWN_CELL, tailCut, withUnknownCells } from '../sessionTextReplay';
import {
  TAIL_BYTES, TAIL_CHECK_INTERVAL_MS, TAIL_CHECK_SPACING_MS, TAIL_MISS_CAP, TAIL_QUIET_RETRY_MS, guardedTailRead, resetTailReadCounters, tailReadCounters,
  type GuardedTailSession,
} from '../guardedTailRead';
import { queuedScreenTail, queuedScreenText, queuedTextSnapshot, queuedTextTail, type TextReadSession } from '../queuedSessionText';

const COLS = 80;
const ROWS = 24;

function session(chunks: string[]): TextReadSession & GuardedTailSession {
  const ringBuffer = new RingBuffer(2 * 1024 * 1024);
  const outputModes = new OutputModeTracker();
  for (const chunk of chunks) {
    ringBuffer.write(Buffer.from(chunk, 'utf8'));
    outputModes.feed(chunk, ringBuffer.totalBytesWritten);
  }
  return { meta: { cols: COLS, rows: ROWS }, ringBuffer, bridge: { outputModes } };
}

function table(s: TextReadSession) {
  return { getSession: (id: string) => (id === 'pane' ? s : undefined) };
}

function texts(outcome: TextSnapshotOutcome | null): string[] {
  if (!outcome?.ok) throw new Error(`read failed: ${outcome ? outcome.reason : 'null'}`);
  return outcome.rows.map((r) => r.text);
}

/** Pages of ~1 KiB, enough to put the cut far past `prefix`: each starts with an erase, so the tail knows every cell. */
const PAD = `\x1b[12;1H${'x'.repeat(70)}`.repeat(14);
function pages(prefix: string, page: (i: number) => string, suffix = ''): string[] {
  return [prefix, ...Array.from({ length: 360 }, (_, i) => `\x1b[H\x1b[2J${PAD}${page(i)}`), suffix];
}

/** A tail that checks only for unknown cells: the guard before this PR's hazard scan. */
async function unguardedTail(s: TextReadSession & GuardedTailSession): Promise<string[]> {
  const data = s.ringBuffer.readAll();
  const writtenAt = s.ringBuffer.totalBytesWritten;
  const raw = data.subarray(tailCut(data, TAIL_BYTES));
  const lead = s.bridge.outputModes?.preamble(writtenAt - raw.length) ?? '';
  const { replay } = withUnknownCells({ raw, replay: Buffer.concat([Buffer.from(lead, 'utf8'), raw]), geometry: undefined, writtenAt }, s.meta);
  return texts(await generateTextSnapshotUnqueued({ cols: COLS, rows: ROWS, scrollback: 0, initial: replay }));
}

const shell = '$ ls\r\nfile-a  file-b\r\n$ ';
/**
 * `xtermOnly`: the rust engine does not implement the sequence (LNM, ?47 and
 * ?1047 are no-ops there), so its unguarded tail is not wrong; the guard
 * still falls back, as the engine the whole-ring read uses is not fixed.
 */
const rustEngine = process.env.WMUX_TERMINAL_CORE === 'rust';
const hazards: Array<{ name: string; chunks: string[]; reason: string; xtermOnly?: boolean }> = [
  { name: 'margins set before the cut', reason: 'margins',
    chunks: pages('\x1b[1;20r', (i) => `\x1b[24;1Hstatus ${i}${Array.from({ length: 5 }, (_, j) => `\x1b[20;1H\nline ${i}-${j}`).join('')}`) },
  { name: 'origin mode set before the cut', reason: 'origin',
    chunks: pages('\x1b[?6h', (i) => `\x1b[3;20r\x1b[1;1Horigin ${i}\x1b[r`) },
  { name: 'G0 designated line drawing before the cut', reason: 'charset', chunks: pages('\x1b(0', () => '\x1b[1;1Hlqqqk') },
  { name: 'SO with G1 line drawing before the cut', reason: 'charset', chunks: pages('\x1b)0\x0e', () => '\x1b[1;1Hlqqqk') },
  { name: 'a tab stop set before the cut', reason: 'tabs', chunks: pages('\x1b[3g\x1b[1;5H\x1bH', () => '\x1b[1;1Ha\tb') },
  { name: 'tab stops cleared before the cut', reason: 'tabs', chunks: pages('\x1b[3g', () => '\x1b[1;1Ha\tb') },
  { name: 'insert mode set before the cut', reason: 'insert', chunks: pages('\x1b[4h', () => '\x1b[1;1Hxxxx\x1b[1;1Hab') },
  { name: 'new-line mode set before the cut', reason: 'newline', chunks: pages('\x1b[20h', () => '\x1b[1;5Habc\ndef'), xtermOnly: true },
  // Autowrap off at the cut and turned back on inside the tail: the preamble leaves ?7 to the tail, which starts it on.
  { name: 'autowrap turned off before the cut and on inside the tail', reason: 'autowrap',
    chunks: pages('\x1b[?7l', () => `\x1b[1;1H${'w'.repeat(100)}`, '\x1b[?7h') },
  { name: 'a cursor saved before the cut and restored inside the tail', reason: 'saved-cursor',
    chunks: pages('\x1b[20;1H\x1b7', (i) => `\x1b8status ${i}`) },
  ...[['1049', '\x1b[?1049l'], ['47', '\x1b[?47l'], ['1047', '\x1b[?1047l'], ['1049', '\x1b[?25;1049l']].map(([mode, exit]) => ({
    name: `a screen switch inside the tail (${JSON.stringify(exit)})`, reason: 'screen-switch',
    chunks: pages(`${shell}\x1b[?${mode}h`, (i) => `\x1b[1;1Happ ${i}`, exit),
    xtermOnly: mode !== '1049',
  })),
];

afterEach(() => { resetTailReadCounters(); vi.useRealTimers(); });

describe('guarded tail: hazards', () => {
  for (const fixture of hazards) {
    it(`${fixture.name}: an unguarded tail is wrong with no unknown cell; the guarded one falls back`, async () => {
      const s = session(fixture.chunks);
      const full = texts(await queuedScreenText(table(s), 'pane'));
      const unguarded = await unguardedTail(s);
      expect(unguarded.some((row) => row.includes(UNKNOWN_CELL))).toBe(false);
      if (!(fixture.xtermOnly && rustEngine)) expect(unguarded).not.toEqual(full);

      const guarded = await queuedScreenTail(table(s), 'pane', 'stallwatch');
      expect(guarded?.via).toBe('full');
      expect(texts(guarded)).toEqual(full);
      expect(tailReadCounters().stallwatch.fallbacks).toEqual({ [fixture.reason]: 1 });
    });
  }

  it('a text read falls back the same way and answers the whole ring\'s rows', async () => {
    const s = session(hazards[0].chunks);
    const full = await queuedTextSnapshot(table(s), 'pane', 80);
    const guarded = await queuedTextTail(table(s), 'pane', 80, 'fleet');
    expect(guarded?.via).toBe('full');
    expect(texts(guarded)).toEqual(texts(full));
    expect(tailReadCounters().fleet.fallbacks).toEqual({ margins: 1 });
  });
});

describe('guarded tail: served', () => {
  const served: Array<{ name: string; chunks: string[] }> = [
    // IND scrolls the region; the page's only line feed comes after the margins are reset, so the cut lands outside them.
    { name: 'margins used only inside the tail', chunks: pages('', (i) => `\x1b[1;20r\x1b[20;1H\x1bDline ${i}\x1b[r\x1b[24;1Hstatus ${i}\r\n`) },
    { name: 'a hazard cleared by RIS before the cut', chunks: pages('\x1b(0\x1b[2;20r\x1b[4h\x1bc', () => '\x1b[1;1Hlqqqk') },
    { name: 'sgr0 re-selecting ASCII on every line', chunks: pages('', (i) => `\x1b[1;1H\x1b(B\x1b[mrow ${i}\x1b(B\x1b[m`) },
    { name: 'an alternate screen entered before the cut and never left', chunks: pages(`${shell}\x1b[?1049h`, (i) => `\x1b[1;1Happ ${i}`) },
  ];
  for (const fixture of served) {
    it(`${fixture.name}: served from the tail, equal to the whole ring`, async () => {
      const s = session(fixture.chunks);
      const full = texts(await queuedScreenText(table(s), 'pane'));
      const guarded = await queuedScreenTail(table(s), 'pane', 'stallwatch');
      expect(guarded?.via).toBe('tail');
      expect(texts(guarded)).toEqual(full);
      expect(tailReadCounters().stallwatch).toMatchObject({ served: 1, fallbacks: {} });
    });
  }

  it('origin mode set before the ring start is served: the whole-ring replay does not restore it either', async () => {
    // ?6h falls out of a small ring; the pages set margins inside the tail.
    // The whole-ring replay starts with origin off, as the tail does, so both
    // put the text on row 1 (a live terminal would put it on row 3).
    const ringBuffer = new RingBuffer(320 * 1024);
    const outputModes = new OutputModeTracker();
    for (const chunk of pages('\x1b[?6h', (i) => `\x1b[3;20r\x1b[1;1Horigin ${i}\x1b[r\r\n`)) {
      ringBuffer.write(Buffer.from(chunk, 'utf8'));
      outputModes.feed(chunk, ringBuffer.totalBytesWritten);
    }
    expect(ringBuffer.totalBytesWritten).toBeGreaterThan(ringBuffer.size);
    const s = { meta: { cols: COLS, rows: ROWS }, ringBuffer, bridge: { outputModes } };
    const full = texts(await queuedScreenText(table(s), 'pane'));
    const guarded = await queuedScreenTail(table(s), 'pane', 'stallwatch');
    expect(guarded?.via).toBe('tail');
    expect(texts(guarded)).toEqual(full);
    expect(full.findIndex((row) => row.startsWith('origin 359'))).toBe(0);
  });

  it('a TUI that writes no line feed until its last line is still served (the cut starts at an escape)', async () => {
    const frames = Array.from({ length: 2000 }, (_, n) =>
      `\x1b[H${Array.from({ length: ROWS }, (_, r) => `\x1b[${r + 1};1Hitem ${n}:${r} ${'x'.repeat(30 + ((n * r) % 40))}\x1b[K`).join('')}`);
    const s = session(['\x1b[?1049h\x1b[2J', ...frames, '\r\ndone']);
    const guarded = await queuedScreenTail(table(s), 'pane', 'stallwatch');
    expect(guarded?.via).toBe('tail');
    expect(texts(guarded)).toEqual(texts(await queuedScreenText(table(s), 'pane')));
  });

  it('a ring that fits in the tail is read whole', async () => {
    const s = session(['\x1b[2;20rsmall ring\r\n']);
    const guarded = await queuedScreenTail(table(s), 'pane', 'stallwatch');
    expect(guarded?.via).toBe('tail');
    expect(texts(guarded)).toEqual(texts(await queuedScreenText(table(s), 'pane')));
    expect(tailReadCounters().stallwatch).toMatchObject({ whole: 1, served: 0 });
  });

  it('a recovered pane with no size yet still marks unknown cells (read at 80x24, as the whole-ring reads)', async () => {
    const ticks = Array.from({ length: 30_000 }, (_, t) => `\x1b[1;60H${String(t).padStart(8, '0')}`);
    const s = session(['\x1b[?1049h\x1b[2J', ...Array.from({ length: ROWS }, (_, r) => `\x1b[${r + 1};1Hrow ${r}`), ...ticks]);
    (s as { meta: unknown }).meta = {};
    const guarded = await queuedScreenTail(table(s), 'pane', 'stallwatch');
    expect(guarded?.via).toBe('full');
    expect(texts(guarded)).toEqual(texts(await queuedScreenText(table(s), 'pane')));
    expect(tailReadCounters().stallwatch.fallbacks).toEqual({ 'unknown-visible': 1 });
  });

  it('a pane whose visible cells the tail never wrote falls back as unknown-visible', async () => {
    // Painted once, then only a clock ticks: the tail can't see the rest of the screen.
    const ticks = Array.from({ length: 30_000 }, (_, t) => `\x1b[1;60H${String(t).padStart(8, '0')}`);
    const s = session(['\x1b[?1049h\x1b[2J', ...Array.from({ length: ROWS }, (_, r) => `\x1b[${r + 1};1Hrow ${r}`), ...ticks]);
    const guarded = await queuedScreenTail(table(s), 'pane', 'stallwatch');
    expect(guarded?.via).toBe('full');
    expect(texts(guarded)).toEqual(texts(await queuedScreenText(table(s), 'pane')));
    expect(tailReadCounters().stallwatch.fallbacks).toEqual({ 'unknown-visible': 1 });
  });
});

describe('guarded tail: cost and the real-data check', () => {
  const parseCounting = () => {
    const calls: number[] = [];
    return {
      calls,
      parse: (initial: Buffer) => { calls.push(initial.length); return generateTextSnapshotUnqueued({ cols: COLS, rows: ROWS, scrollback: 0, initial }); },
    };
  };

  it('a hazard fallback parses the whole ring once and never the tail', async () => {
    const s = session(hazards[0].chunks);
    const { calls, parse } = parseCounting();
    await guardedTailRead(s, { site: 'stallwatch', parse });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toBeGreaterThanOrEqual(s.ringBuffer.size);
  });

  it('an unknown-visible fallback is one tail parse plus one whole-ring parse', async () => {
    const ticks = Array.from({ length: 30_000 }, (_, t) => `\x1b[1;60H${String(t).padStart(8, '0')}`);
    const s = session(['\x1b[?1049h\x1b[2Jpainted once', ...ticks]);
    const { calls, parse } = parseCounting();
    await guardedTailRead(s, { site: 'stallwatch', parse });
    expect(calls).toHaveLength(2);
    expect(calls[0]).toBeLessThan(TAIL_BYTES + 64 * 1024);
    expect(calls[1]).toBeGreaterThanOrEqual(s.ringBuffer.size);
  });

  it('compares a served answer with the whole ring at most once per pane per 10 minutes, keeping counts only', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-07T00:00:00Z'));
    const canary = 'CANARY-7f3a9c';
    const s = session(pages('', (i) => `\x1b[1;1H${canary} ${i}`));
    const inputs = (rows: readonly string[]) => ({ running: rows.some((r) => r.includes(canary)), token: rows.find((r) => r.includes(canary)) });
    const { calls, parse } = parseCounting();
    const read = () => guardedTailRead(s, { site: 'stallwatch', parse, inputs });

    expect((await read()).via).toBe('tail');
    expect(calls).toHaveLength(2); // the tail, then the check's whole ring
    await read();
    vi.setSystemTime(Date.now() + TAIL_CHECK_INTERVAL_MS - 1);
    await read();
    expect(tailReadCounters().stallwatch.checks).toBe(1);
    vi.setSystemTime(Date.now() + 1);
    await read();
    expect(tailReadCounters().stallwatch).toMatchObject({ served: 4, checks: 2, mismatches: {} });
    expect(JSON.stringify(tailReadCounters())).not.toContain(canary);
  });

  it('counts a check\'s mismatch by part and direction', async () => {
    const s = session(pages('', (i) => `\x1b[1;1Hrow ${i}`));
    let n = 0;
    const tailAnswer = await guardedTailRead(s, {
      site: 'fleet',
      parse: async (initial) => {
        const answer = await generateTextSnapshotUnqueued({ cols: COLS, rows: ROWS, scrollback: 0, initial });
        // The second parse is the check's: make its viewport differ.
        return n++ === 0 || !answer.ok ? answer : { ...answer, rows: answer.rows.map((r, i) => (i === 0 ? { ...r, text: 'other' } : r)) };
      },
      inputs: (rows) => ({ running: rows[0] !== 'other' }),
    });
    expect(tailAnswer.via).toBe('tail');
    expect(tailReadCounters().fleet.mismatches).toEqual({ viewport: 1, 'running:tail-only': 1, any: 1 });
  });

  it('a failing check never changes the answer', async () => {
    const t = session(pages('', (i) => `\x1b[1;1Hrow ${i}`));
    let m = 0;
    const answer = await guardedTailRead(t, {
      site: 'stallwatch',
      parse: (initial) => (m++ === 0 ? generateTextSnapshotUnqueued({ cols: COLS, rows: ROWS, scrollback: 0, initial }) : Promise.reject(new Error('boom'))),
    });
    expect(answer.via).toBe('tail');
    expect(answer.ok).toBe(true);
    expect(tailReadCounters().stallwatch.mismatches).toEqual({ 'check-failed': 1 });
  });

  it('checks at most one pane per 10 seconds, so a daemon start does not stack them', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-07T00:00:00Z'));
    const panes = [0, 1].map(() => session(pages('', (i) => `\x1b[1;1Hrow ${i}`)));
    const parse = (initial: Buffer) => generateTextSnapshotUnqueued({ cols: COLS, rows: ROWS, scrollback: 0, initial });
    for (const pane of panes) await guardedTailRead(pane, { site: 'stallwatch', parse });
    expect(tailReadCounters().stallwatch.checks).toBe(1);
    vi.setSystemTime(Date.now() + TAIL_CHECK_SPACING_MS);
    for (const pane of panes) await guardedTailRead(pane, { site: 'stallwatch', parse });
    expect(tailReadCounters().stallwatch).toMatchObject({ served: 4, checks: 2 });
  });
});

describe('guarded tail: a reader stops trying a tail that keeps missing', () => {
  /** A Claude-style screen: static rows painted once by position, then only a status cell repaints. */
  const repaintRing = () => {
    const ticks = Array.from({ length: 30_000 }, (_, t) => `\x1b[1;60H${String(t).padStart(8, '0')}`);
    return session(['\x1b[?1049h\x1b[2J', ...Array.from({ length: ROWS }, (_, r) => `\x1b[${r + 1};1Hrow ${r}`), ...ticks]);
  };
  const counting = () => {
    const calls: number[] = [];
    return {
      calls,
      parse: (initial: Buffer) => { calls.push(initial.length); return generateTextSnapshotUnqueued({ cols: COLS, rows: ROWS, scrollback: 0, initial }); },
    };
  };
  /** Parses per read: 2 = tail tried and missed, 1 = straight to the whole ring (or served). */
  const read = async (s: GuardedTailSession, site: 'stallwatch' | 'fleet' = 'stallwatch') => {
    const { calls, parse } = counting();
    const answer = await guardedTailRead(s, { site, parse });
    return { via: answer.via, parses: calls.length };
  };

  it(`a repainting pane stops paying for the tail after ${TAIL_MISS_CAP} misses, with the same answer`, async () => {
    const s = repaintRing();
    const reads = [];
    for (let i = 0; i < TAIL_MISS_CAP + 2; i++) reads.push(await read(s));
    expect(reads.map((r) => r.parses)).toEqual([...Array(TAIL_MISS_CAP).fill(2), 1, 1]);
    expect(reads.every((r) => r.via === 'full')).toBe(true);
    expect(tailReadCounters().stallwatch).toMatchObject({ reads: TAIL_MISS_CAP + 2, skipped: 2, fallbacks: { 'unknown-visible': TAIL_MISS_CAP } });
    const skippedAnswer = await guardedTailRead(s, { site: 'stallwatch', parse: (initial) => generateTextSnapshotUnqueued({ cols: COLS, rows: ROWS, scrollback: 0, initial }) });
    expect(texts(skippedAnswer)).toEqual(texts(await queuedScreenText(table(s as TextReadSession), 'pane')));
  });

  it('a plain shell pane keeps being served by the tail', async () => {
    const s = session(pages('', (i) => `\x1b[1;1Hrow ${i}`));
    const reads = [];
    for (let i = 0; i < TAIL_MISS_CAP + 3; i++) reads.push(await read(s));
    expect(reads.every((r) => r.via === 'tail')).toBe(true);
    expect(tailReadCounters().stallwatch).toMatchObject({ skipped: 0, fallbacks: {} });
  });

  it('counts per reader: Fleet keeps trying while StallWatch is capped', async () => {
    const s = repaintRing();
    for (let i = 0; i < TAIL_MISS_CAP; i++) await read(s, 'stallwatch');
    expect((await read(s, 'stallwatch')).parses).toBe(1);
    expect((await read(s, 'fleet')).parses).toBe(2);
  });

  it('tries the tail again after a resize', async () => {
    const s = repaintRing();
    for (let i = 0; i < TAIL_MISS_CAP; i++) await read(s);
    expect((await read(s)).parses).toBe(1);
    (s.meta as { cols: number }).cols = COLS + 1;
    expect((await read(s)).parses).toBe(2);
    expect((await read(s)).parses).toBe(1);
  });

  it('tries the tail again once a whole tail of new output has arrived', async () => {
    const s = repaintRing();
    for (let i = 0; i < TAIL_MISS_CAP; i++) await read(s);
    const more = Array.from({ length: 15_000 }, (_, t) => `\x1b[1;60H${String(t).padStart(8, '9')}`).join('');
    s.ringBuffer.write(Buffer.from(more.slice(0, TAIL_BYTES / 2)));
    expect((await read(s)).parses).toBe(1);
    s.ringBuffer.write(Buffer.from(more.slice(0, TAIL_BYTES / 2 + 1)));
    expect((await read(s)).parses).toBe(2);
  });

  it('tries the tail again when output resumes after a long quiet stretch, not while it stays quiet', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-08T00:00:00Z'));
    const s = repaintRing();
    const tick = (t: number) => s.ringBuffer.write(Buffer.from(`\x1b[1;60H${String(t).padStart(8, '7')}`));
    for (let i = 0; i < TAIL_MISS_CAP; i++) await read(s);
    // Output keeps moving: no retry.
    vi.setSystemTime(Date.now() + 1_000);
    tick(1);
    expect((await read(s)).parses).toBe(1);
    // Quiet for the whole stretch: reading again would only miss again.
    vi.setSystemTime(Date.now() + TAIL_QUIET_RETRY_MS);
    expect((await read(s)).parses).toBe(1);
    // Output resumes after it: the app may have redrawn, so try once.
    tick(2);
    expect((await read(s)).parses).toBe(2);
    tick(3);
    expect((await read(s)).parses).toBe(1);
  });

  it('a failed tail parse (a budget timeout under load) is not a miss', async () => {
    const s = repaintRing();
    let n = 0;
    const failingTail = (initial: Buffer) => (n++ % 2 === 0
      ? Promise.resolve({ ok: false as const, reason: 'budget' as const })
      : generateTextSnapshotUnqueued({ cols: COLS, rows: ROWS, scrollback: 0, initial }));
    for (let i = 0; i < TAIL_MISS_CAP + 1; i++) await guardedTailRead(s, { site: 'stallwatch', parse: failingTail as never });
    expect(tailReadCounters().stallwatch).toMatchObject({ skipped: 0, fallbacks: { 'tail-failed': TAIL_MISS_CAP + 1 } });
  });

  it('counts each request variant apart: a deep-history read does not cap the screen read', async () => {
    const s = repaintRing();
    const { parse } = counting();
    for (let i = 0; i < TAIL_MISS_CAP; i++) await guardedTailRead(s, { site: 'fleet', variant: 'scrollback:5000', parse });
    const deep = counting();
    await guardedTailRead(s, { site: 'fleet', variant: 'scrollback:5000', parse: deep.parse });
    expect(deep.calls).toHaveLength(1);
    const screen = counting();
    await guardedTailRead(s, { site: 'fleet', variant: 'scrollback:0', parse: screen.parse });
    expect(screen.calls).toHaveLength(2);
  });

  it('a tail served again clears the run', async () => {
    const s = repaintRing();
    for (let i = 0; i < TAIL_MISS_CAP; i++) await read(s);
    // The app clears and redraws every row: the tail knows the whole screen again.
    s.ringBuffer.write(Buffer.from(`\x1b[2J${Array.from({ length: ROWS }, (_, r) => `\x1b[${r + 1};1Hnew ${r}`).join('')}`));
    (s.meta as { cols: number }).cols = COLS + 1;
    expect((await read(s)).via).toBe('tail'); // plus the once-per-10-minutes whole-ring check
    (s.meta as { cols: number }).cols = COLS;
    expect((await read(s)).via).toBe('tail');
  });
});
