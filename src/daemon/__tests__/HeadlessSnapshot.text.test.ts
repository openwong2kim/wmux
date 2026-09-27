import { describe, it, expect } from 'vitest';
import { generateTextSnapshot, capTextRowsToFrameBudget } from '../HeadlessSnapshot';
import { searchInBuffer, type SearchableBuffer } from '../../renderer/utils/searchEngine';
import { terminalReadCoverage } from '../../shared/terminalReadCoverage';
import { RingBuffer } from '../RingBuffer';
import { OutputModeTracker } from '../util/outputModeTracker';
import { readSessionTextReplay } from '../sessionTextReplay';

// ── Cold-park text snapshot (TASK-9) ────────────────────────────────
//
// generateTextSnapshot feeds a session's raw ANSI history through a headless
// terminal and returns the parsed grid as plain-text rows (ANSI stripped) for
// the search / readScreen fallback of parked panes. These tests prove the rows
// are correct AND that the renderer's search engine finds matches over them —
// the "parked panes are still searched, no silent miss" AC.

/** Adapt daemon rows to the SearchableBuffer surface (mirror of useRpcBridge). */
function rowsToSearchableBuffer(rows: { text: string; wrapped: boolean }[]): SearchableBuffer {
  return {
    length: rows.length,
    getLine(idx: number) {
      const row = rows[idx];
      if (!row) return undefined;
      return { isWrapped: row.wrapped, translateToString: () => row.text };
    },
  };
}

describe('generateTextSnapshot (cold-park fallback)', () => {
  it('parses ANSI history into plain-text rows (SGR stripped)', async () => {
    // Bold + colored text plus a plain line; the grid text must be ANSI-free.
    const initial = Buffer.from('\x1b[1;31mERROR\x1b[0m boom\r\nsecond line\r\n', 'utf8');
    const outcome = await generateTextSnapshot({ cols: 80, rows: 24, initial });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const texts = outcome.rows.map((r) => r.text);
    expect(texts).toContain('ERROR boom');
    expect(texts).toContain('second line');
    // No escape bytes leaked into the plain text.
    expect(texts.join('\n')).not.toMatch(/\x1b/);
  });

  it('is searchable via the renderer search engine (no silent miss)', async () => {
    const initial = Buffer.from('alpha\r\nneedle here\r\nbravo\r\n', 'utf8');
    const outcome = await generateTextSnapshot({ cols: 80, rows: 24, initial });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const matches = searchInBuffer(
      rowsToSearchableBuffer(outcome.rows),
      'needle',
      { regex: false, contextLines: 1, perBufferLineCap: 20_000, remainingBudget: 50 },
    );
    expect(matches.length).toBe(1);
    expect(matches[0].text).toContain('needle here');
  });

  it('preserves CJK content through Unicode-11 width parity', async () => {
    const initial = Buffer.from('안녕하세요 세계\r\n', 'utf8');
    const outcome = await generateTextSnapshot({ cols: 80, rows: 24, initial });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.rows.map((r) => r.text)).toContain('안녕하세요 세계');
  });

  it('trims trailing empty viewport rows', async () => {
    // A short session leaves the grid (24 rows here) mostly blank below the
    // content. Those trailing empties must not appear in the rows — otherwise a
    // parked readScreen tail_lines would return blank lines the live path omits.
    const initial = Buffer.from('only line\r\n', 'utf8');
    const outcome = await generateTextSnapshot({ cols: 80, rows: 24, initial });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.rows.length).toBeGreaterThan(0);
    expect(outcome.rows[outcome.rows.length - 1].text).not.toBe('');
    expect(outcome.rows.map((r) => r.text)).toContain('only line');
  });

  it('reports viewport-only alternate redraws while preserving normal scrollback', async () => {
    const answer = Array.from({ length: 40 }, (_, i) => `answer line ${i}`).join('\r\n');
    const normal = await generateTextSnapshot({ cols: 80, rows: 6, scrollback: 100, initial: Buffer.from(answer) });
    expect(normal.ok).toBe(true);
    if (!normal.ok) return;
    expect(normal.bufferType).toBe('normal');
    expect(normal.rows.map((row) => row.text)).toEqual(answer.split('\r\n'));
    expect(terminalReadCoverage(normal.bufferType)).toEqual({});

    // Alternate-screen entry and synchronized cursor redraws match the CLI
    // startup capture. A long answer and its replacement cannot form backlog.
    const alternate = await generateTextSnapshot({
      cols: 80, rows: 6, scrollback: 100,
      initial: Buffer.from(`\x1b[?1049h${answer}\x1b[?2026h\x1b[H\x1b[Jcurrent viewport\r\nprompt\x1b[?2026l`),
    });
    expect(alternate.ok).toBe(true);
    if (!alternate.ok) return;
    expect(alternate.rows.map((row) => row.text)).toEqual(['current viewport', 'prompt']);
    expect(alternate.bufferType).toBe('alternate');
    expect(terminalReadCoverage(alternate.bufferType)).toMatchObject({ alternateScreen: true, historyIncomplete: true });
    expect(terminalReadCoverage(alternate.bufferType).hint).toContain('full_scrollback cannot recover it');
  });

  it('fails soft on an exceeded time budget', async () => {
    // A large history with a 0 ms budget forces the budget branch.
    const big = Buffer.from('x'.repeat(2 * 1024 * 1024), 'utf8');
    const outcome = await generateTextSnapshot({ cols: 80, rows: 24, initial: big, budgetMs: 0 });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toBe('budget');
  });
});

describe('capTextRowsToFrameBudget (readSessionText frame budget)', () => {
  it('leaves rows untouched when under the cap', () => {
    const rows = Array.from({ length: 100 }, (_, i) => ({ text: `line ${i}`, wrapped: false }));
    const out = capTextRowsToFrameBudget(rows, 700 * 1024);
    expect(out.truncated).toBe(false);
    expect(out.rows.length).toBe(100);
  });

  it('drops OLDEST rows to fit the cap and reports truncated', () => {
    // 20k rows of ~100 chars each ≈ 2.5 MB serialized — well over the frame cap.
    const rows = Array.from({ length: 20_000 }, (_, i) => ({
      text: `row ${String(i).padStart(6, '0')} ${'x'.repeat(90)}`,
      wrapped: false,
    }));
    const CAP = 700 * 1024;
    const out = capTextRowsToFrameBudget(rows, CAP);
    expect(out.truncated).toBe(true);
    // The TRUE serialized size (JSON-escaped) of the kept rows stays under cap.
    const trueSize = JSON.stringify(out.rows).length;
    expect(trueSize).toBeLessThanOrEqual(CAP);
    // The TAIL is kept (most relevant) — the last row survives, an early one is gone.
    expect(out.rows[out.rows.length - 1].text).toContain('row 019999');
    expect(out.rows.some((r) => r.text.includes('row 000000'))).toBe(false);
  });

  it('accounts for JSON escaping so quote/backslash-heavy rows stay under cap', () => {
    // Windows paths + quotes: every \ and " DOUBLES under JSON.stringify. A
    // raw text.length estimate would under-count and could blow the frame.
    const heavy = 'C:\\Users\\rizz\\"proj"\\node_modules\\'.repeat(4);
    const rows = Array.from({ length: 40_000 }, () => ({ text: heavy, wrapped: false }));
    const CAP = 700 * 1024;
    const out = capTextRowsToFrameBudget(rows, CAP);
    expect(out.truncated).toBe(true);
    // The honest JSON size of what we return must fit — this is the assertion
    // that fails with a raw text.length estimate.
    expect(JSON.stringify(out.rows).length).toBeLessThanOrEqual(CAP);
  });
});


describe('session text replay mode restoration', () => {
  it('reports alternate-screen coverage after the ring evicts the entry sequence', async () => {
    const ring = new RingBuffer(128);
    const modes = new OutputModeTracker();
    const feed = (text: string) => {
      ring.write(Buffer.from(text));
      modes.feed(text, ring.totalBytesWritten);
    };
    feed('\x1b[?1049h');
    feed('old frame\r\n'.repeat(30));
    feed('\x1b[H\x1b[Jcurrent viewport\r\nprompt');
    expect(ring.readAll().includes(Buffer.from('\x1b[?1049h'))).toBe(false);
    expect(modes.altScreen).toBe(true);
    const outcome = await generateTextSnapshot({
      cols: 80, rows: 6, scrollback: 100,
      initial: readSessionTextReplay(ring, modes),
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.bufferType).toBe('alternate');
    expect(outcome.rows.map((row) => row.text)).toEqual(['current viewport', 'prompt']);
    expect(terminalReadCoverage(outcome.bufferType)).toMatchObject({ alternateScreen: true, historyIncomplete: true });
    expect(terminalReadCoverage(outcome.bufferType).hint).toContain('if the application supports one');
  });

  it('preserves shell history when the entry is retained and stops warning after exit', async () => {
    const ring = new RingBuffer(4096);
    const modes = new OutputModeTracker();
    const feed = (text: string) => {
      ring.write(Buffer.from(text));
      modes.feed(text, ring.totalBytesWritten);
    };
    feed('shell history\r\n\x1b[?1049hcurrent viewport');
    // Reasserting alternate mode before a retained entry would paint this
    // shell history into the wrong buffer and discard it on exit.
    const initial = readSessionTextReplay(ring, modes);
    expect(initial).toEqual(ring.readAll());
    const exited = await generateTextSnapshot({
      cols: 80, rows: 6,
      initial: Buffer.concat([initial, Buffer.from('\x1b[?1049l')]),
    });
    expect(exited.ok).toBe(true);
    if (!exited.ok) return;
    expect(exited.rows.map((row) => row.text)).toEqual(['shell history']);
    expect(terminalReadCoverage(exited.bufferType)).toEqual({});

    feed('\x1b[?1049l');
    expect(modes.altScreen).toBe(false);
    expect(readSessionTextReplay(ring, modes)).toEqual(ring.readAll());
  });
});
