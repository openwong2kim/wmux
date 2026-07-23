import { describe, it, expect } from 'vitest';
import { generateTextSnapshot, capTextRowsToFrameBudget } from '../HeadlessSnapshot';
import { searchInBuffer, type SearchableBuffer } from '../../renderer/utils/searchEngine';

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
