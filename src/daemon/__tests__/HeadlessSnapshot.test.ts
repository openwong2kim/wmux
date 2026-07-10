import { describe, it, expect } from 'vitest';
import { Terminal } from '@xterm/headless';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { generateSnapshot, FEED_SLICE_BYTES } from '../HeadlessSnapshot';

// ── Round-trip harness ──────────────────────────────────────────────
//
// Fidelity is proven by CELL COMPARISON: parse the raw bytes continuously
// into a "reference" terminal, restore the snapshot payload into another
// terminal, and assert the two buffers (text + cursor + relevant modes)
// agree. Both terminals use the exact config the generator uses
// (@xterm/headless, Unicode 11 tables, allowProposedApi) so widths line up.

function makeTerminal(cols: number, rows: number): Terminal {
  const t = new Terminal({ cols, rows, scrollback: 5000, allowProposedApi: true });
  t.loadAddon(new Unicode11Addon());
  t.unicode.activeVersion = '11';
  return t;
}

function writeAsync(t: Terminal, data: string | Uint8Array): Promise<void> {
  return new Promise<void>((resolve) => t.write(data as string | Uint8Array, resolve));
}

async function referenceTerminal(bytes: Buffer, cols: number, rows: number): Promise<Terminal> {
  const t = makeTerminal(cols, rows);
  await writeAsync(t, bytes);
  return t;
}

async function restoredTerminal(payload: Buffer, cols: number, rows: number): Promise<Terminal> {
  const t = makeTerminal(cols, rows);
  await writeAsync(t, payload);
  return t;
}

/** Every row of the normal buffer (scrollback + viewport), whitespace-trimmed. */
function bufferText(t: Terminal): string[] {
  const buf = t.buffer.normal;
  const lines: string[] = [];
  for (let i = 0; i < buf.length; i++) {
    const line = buf.getLine(i);
    lines.push(line ? line.translateToString(true) : '');
  }
  return lines;
}

/** Trailing blank rows are not fidelity-relevant (the cursor encodes them). */
function trimTrailingBlank(lines: string[]): string[] {
  let end = lines.length;
  while (end > 0 && lines[end - 1] === '') end--;
  return lines.slice(0, end);
}

function cursor(t: Terminal): { x: number; y: number } {
  return { x: t.buffer.active.cursorX, y: t.buffer.active.cursorY };
}

async function expectRoundTrip(bytes: Buffer, cols: number, rows: number): Promise<Buffer> {
  const res = await generateSnapshot({ cols, rows, initial: bytes });
  expect(res.ok).toBe(true);
  if (!res.ok) throw new Error(`unexpected fallback: ${res.reason}`);
  const ref = await referenceTerminal(bytes, cols, rows);
  const restored = await restoredTerminal(res.payload, cols, rows);
  expect(trimTrailingBlank(bufferText(restored))).toEqual(trimTrailingBlank(bufferText(ref)));
  expect(cursor(restored)).toEqual(cursor(ref));
  return res.payload;
}

describe('HeadlessSnapshot — fidelity round-trips', () => {
  it('reproduces plain text with SGR colors across scrollback', async () => {
    const rows = 10;
    let s = '';
    for (let i = 0; i < 50; i++) {
      s += `\x1b[3${i % 8}mline number ${i} with some content\x1b[0m\r\n`;
    }
    await expectRoundTrip(Buffer.from(s), 80, rows);
  });

  it('reproduces a CJK + emoji row at the correct widths', async () => {
    const bytes = Buffer.from('한글 테스트 🚀 中文 done\r\nsecond line ascii\r\n');
    await expectRoundTrip(bytes, 40, 10);
  });

  it('restores bracketed-paste mode', async () => {
    const res = await generateSnapshot({
      cols: 80,
      rows: 24,
      initial: Buffer.from('\x1b[?2004hprompt$ \r\n'),
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const restored = await restoredTerminal(res.payload, 80, 24);
    expect(restored.modes.bracketedPasteMode).toBe(true);
  });

  it('restores application-cursor-keys mode', async () => {
    const res = await generateSnapshot({
      cols: 80,
      rows: 24,
      initial: Buffer.from('\x1b[?1hcontent\r\n'),
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const restored = await restoredTerminal(res.payload, 80, 24);
    expect(restored.modes.applicationCursorKeysMode).toBe(true);
  });

  it('restores mouse tracking mode and re-emits the SGR encoding', async () => {
    const res = await generateSnapshot({
      cols: 80,
      rows: 24,
      initial: Buffer.from('\x1b[?1002h\x1b[?1006happ ready\r\n'),
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const restored = await restoredTerminal(res.payload, 80, 24);
    expect(restored.modes.mouseTrackingMode).toBe('drag');
    // The public API does not expose the ?1006 encoding; the generator must
    // re-inject it explicitly so the app keeps receiving SGR-format reports.
    expect(res.payload.toString('utf8')).toContain('\x1b[?1006h');
  });

  it('degrades on the alternate screen buffer', async () => {
    const res = await generateSnapshot({
      cols: 80,
      rows: 24,
      initial: Buffer.from('\x1b[?1049h\x1b[HVIM-LIKE CONTENT\r\n'),
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toBe('alt-screen');
  });

  it('degrades while DECSTBM margins are active, but not after they are cleared', async () => {
    const active = await generateSnapshot({
      cols: 80,
      rows: 24,
      initial: Buffer.from('\x1b[2;10rmargined content\r\n'),
    });
    expect(active.ok).toBe(false);
    if (!active.ok) expect(active.reason).toBe('margins');

    const cleared = await generateSnapshot({
      cols: 80,
      rows: 24,
      initial: Buffer.from('\x1b[2;10rmargined\x1b[rback to full\r\n'),
    });
    expect(cleared.ok).toBe(true);
  });

  it('keeps an unfinished trailing sequence so the next live bytes complete it', async () => {
    const bytes = Buffer.from('hello \x1b[3'); // ends mid-CSI
    const res = await generateSnapshot({ cols: 80, rows: 24, initial: bytes });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    // The partial tail is shipped verbatim so the renderer's parser holds it.
    expect(res.payload.toString('utf8').endsWith('\x1b[3')).toBe(true);

    // Continuing with '1mRED' must land identically to a continuous parse.
    const restored = await restoredTerminal(res.payload, 80, 24);
    await writeAsync(restored, '1mRED');
    const ref = await referenceTerminal(Buffer.from('hello \x1b[31mRED'), 80, 24);
    expect(trimTrailingBlank(bufferText(restored))).toEqual(trimTrailingBlank(bufferText(ref)));
  });

  it('carries a UTF-8 char split between the initial buffer and a drain chunk', async () => {
    const han = Buffer.from('한'); // 3 bytes
    const initial = Buffer.concat([Buffer.from('AB'), han.subarray(0, 2)]);
    let drained = false;
    const res = await generateSnapshot({
      cols: 80,
      rows: 24,
      initial,
      drainQueue: () => {
        if (drained) return [];
        drained = true;
        return [han.subarray(2)];
      },
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const restored = await restoredTerminal(res.payload, 80, 24);
    const ref = await referenceTerminal(Buffer.from('AB한'), 80, 24);
    expect(trimTrailingBlank(bufferText(restored))).toEqual(trimTrailingBlank(bufferText(ref)));
  });

  it('drains the live tee over multiple rounds', async () => {
    const rounds: Buffer[][] = [[Buffer.from('mid1 ')], [Buffer.from('mid2 ')]];
    let i = 0;
    const res = await generateSnapshot({
      cols: 80,
      rows: 24,
      initial: Buffer.from('start '),
      drainQueue: () => rounds[i++] ?? [],
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const restored = await restoredTerminal(res.payload, 80, 24);
    const ref = await referenceTerminal(Buffer.from('start mid1 mid2 '), 80, 24);
    expect(trimTrailingBlank(bufferText(restored))).toEqual(trimTrailingBlank(bufferText(ref)));
  });

  it('degrades to a budget fallback when the parse exceeds its time budget', async () => {
    const big = Buffer.alloc(8 * 1024 * 1024, 0x41); // 8 MB of 'A'
    const res = await generateSnapshot({ cols: 80, rows: 24, initial: big, budgetMs: 0 });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('budget');
  }, 20000);

  it('smoke: serializes several MB of text within a generous budget', async () => {
    const line = 'x'.repeat(79) + '\r\n';
    const target = 4 * 1024 * 1024;
    let s = '';
    while (s.length < target) s += line;
    const res = await generateSnapshot({
      cols: 80,
      rows: 24,
      initial: Buffer.from(s),
      budgetMs: 60000,
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      // eslint-disable-next-line no-console
      console.log(`[HeadlessSnapshot smoke] bytesIn=${res.bytesIn} durationMs=${res.durationMs}`);
    }
  }, 60000);

  // CodeRabbit critical regression: an INTERIOR 256 KB feed-slice boundary
  // used to split multibyte chars (only the final slice carried its tail),
  // decoding both halves as U+FFFD.
  it('keeps a multibyte char intact across an interior feed-slice boundary', async () => {
    const cols = 120;
    const rows = 10;
    // Pad so the 3-byte '한' straddles the FEED_SLICE_BYTES boundary
    // (1 byte in slice 0, 2 bytes in slice 1), then end with a marker line.
    const pad = 'x'.repeat(64) + '\r\n'; // 66 ASCII bytes
    let s = '';
    while (s.length + pad.length <= FEED_SLICE_BYTES - 1) s += pad;
    s += 'x'.repeat(FEED_SLICE_BYTES - 1 - s.length); // exactly SLICE-1 bytes
    const bytes = Buffer.concat([
      Buffer.from(s),
      Buffer.from('한글 boundary check\r\nend-marker$ '),
    ]);
    expect(bytes[FEED_SLICE_BYTES - 1]).toBe(Buffer.from('한')[0]); // straddles
    const res = await generateSnapshot({ cols, rows, initial: bytes });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const restored = await restoredTerminal(res.payload, cols, rows);
    const text = bufferText(restored).join('\n');
    expect(text).toContain('한글 boundary check');
    expect(text).not.toContain('�');
  }, 30000);
});
