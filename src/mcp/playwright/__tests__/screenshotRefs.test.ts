import { describe, expect, it, vi } from 'vitest';

const { listRefEntries, resolveRef, listSmartElementsOnPage } = vi.hoisted(() => ({
  listRefEntries: vi.fn(),
  resolveRef: vi.fn(),
  listSmartElementsOnPage: vi.fn(),
}));

vi.mock('../snapshot', () => ({ listRefEntries, resolveRef }));
vi.mock('../dom-intelligence', () => ({
  listSmartElementsOnPage,
  resolveSmartRefLocator: vi.fn(),
}));

import {
  NO_SNAPSHOT_REFS_LINE,
  UNKNOWN_AREA_LINE,
  formatRefBoxTable,
  interleaveByPosition,
  refBoxCandidates,
  type RefBoxCandidate,
} from '../screenshotRefs';

const AREA = { x: 0, y: 0, width: 1000, height: 800 };

function candidate(
  ref: number,
  box: { x: number; y: number; width: number; height: number } | null,
  extra: Partial<RefBoxCandidate> = {},
): RefBoxCandidate {
  return { param: 'ref', ref, role: 'button', name: `b${ref}`, measure: async () => box, ...extra };
}

describe('formatRefBoxTable', () => {
  it('keeps only boxes intersecting the captured area, sorted top-to-bottom then left-to-right', async () => {
    const text = await formatRefBoxTable(
      [
        candidate(1, { x: 500, y: 100, width: 50, height: 20 }),
        candidate(2, { x: 10, y: 100, width: 50, height: 20 }),
        candidate(3, { x: 10, y: 5, width: 50, height: 20 }),
        candidate(4, { x: 10, y: 900, width: 50, height: 20 }), // below the fold
        candidate(5, { x: 990, y: 790, width: 50, height: 50 }), // straddles the corner
        candidate(6, null),
      ],
      AREA,
      { basis: 'viewport CSS px' },
    );
    const rows = text.split('\n');
    expect(rows[0]).toBe('Refs in this capture (viewport CSS px: x,y,w,h):');
    expect(rows.slice(1, 5)).toEqual([
      'ref=3 button "b3" 10,5,50,20',
      'ref=2 button "b2" 10,100,50,20',
      'ref=1 button "b1" 500,100,50,20',
      'ref=5 button "b5" 990,790,50,50',
    ]);
    expect(rows[5]).toBe('Not listed: 0 timed out, 2 outside the capture or without a box, 0 cut by the 60-row / 150-measure caps.');
  });

  it('names the parameter each ref belongs in and applies the fullPage offset', async () => {
    const text = await formatRefBoxTable(
      [candidate(61, { x: 20, y: 30, width: 40, height: 10 }, { param: 'smartRef', role: 'textbox', name: 'Say "hi"\n there \\n' })],
      { x: 0, y: 0, width: 1000, height: 5000 },
      { offset: { x: 0, y: 2000 }, basis: 'document CSS px' },
    );
    // The backslash is escaped before the quote, so the quoting cannot be undone.
    expect(text).toContain('smartRef=61 textbox "Say \\"hi\\" there \\\\n" 20,2030,40,10');
    expect(text).not.toContain('Not listed');
  });

  it('cuts the table at 60 rows and counts the rest', async () => {
    const many = Array.from({ length: 80 }, (_, i) => candidate(i + 1, { x: 0, y: i * 5, width: 10, height: 4 }));
    const text = await formatRefBoxTable(many, AREA, { basis: 'viewport CSS px' });
    const rows = text.split('\n').filter((l) => l.startsWith('ref='));
    expect(rows).toHaveLength(60);
    expect(text).toContain('20 cut by the 60-row');
  });

  it('measures at most 150 refs', async () => {
    const measure = vi.fn(async () => ({ x: 0, y: 0, width: 10, height: 10 }));
    const many = Array.from({ length: 200 }, (_, i) => candidate(i + 1, null, { measure }));
    const text = await formatRefBoxTable(many, AREA, { basis: 'viewport CSS px', rowCap: 1000 });
    expect(measure).toHaveBeenCalledTimes(150);
    expect(text).toContain('50 cut by the');
  });

  it('stops at the time budget and counts the refs that did not answer', async () => {
    const hang = () => new Promise<null>(() => undefined);
    const started = Date.now();
    const text = await formatRefBoxTable(
      [
        candidate(1, { x: 1, y: 1, width: 5, height: 5 }),
        candidate(2, null, { measure: hang }),
        candidate(3, null, { measure: hang }),
      ],
      AREA,
      { basis: 'viewport CSS px', budgetMs: 50 },
    );
    expect(Date.now() - started).toBeLessThan(1000);
    expect(text).toContain('ref=1 button');
    expect(text).toContain('Not listed: 2 timed out');
  });

  it('counts a ref whose resolution throws as having no box', async () => {
    const text = await formatRefBoxTable(
      [candidate(1, null, { measure: async () => { throw new Error('stale'); } })],
      AREA,
      { basis: 'viewport CSS px' },
    );
    expect(text).toContain('(none of the snapshot refs is inside the captured area)');
    expect(text).toContain('1 outside the capture or without a box');
  });

  it('tells the agent to snapshot first when there are no refs', async () => {
    expect(await formatRefBoxTable([], AREA, { basis: 'viewport CSS px' })).toBe(NO_SNAPSHOT_REFS_LINE);
    expect(NO_SNAPSHOT_REFS_LINE).toContain('call browser_snapshot');
  });

  it('finds the refs inside a scrolled viewport even when they are far past the measure cap', async () => {
    // Document order: 260 refs above the viewport, then the 40 inside it.
    const many = Array.from({ length: 300 }, (_, i) =>
      candidate(i + 1, i < 260 ? { x: 0, y: -(260 - i) * 20, width: 10, height: 10 } : { x: 0, y: (i - 260) * 20, width: 10, height: 10 }),
    );
    const text = await formatRefBoxTable(many, AREA, { basis: 'viewport CSS px' });
    const rows = text.split('\n').filter((l) => l.startsWith('ref='));
    expect(rows).toHaveLength(40);
    expect(rows[0]).toBe('ref=261 button "b261" 0,0,10,10');
  });

  it('does not start more measurements once the budget is spent', async () => {
    vi.useFakeTimers();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1000);
    try {
      const measure = vi.fn<RefBoxCandidate['measure']>(() => new Promise<null>(() => undefined));
      const many = Array.from({ length: 200 }, (_, i) => candidate(i + 1, null, { measure }));
      const pending = formatRefBoxTable(many, AREA, { basis: 'viewport CSS px', budgetMs: 30 });
      // Simulate a timeout firing while the coarse wall clock has not advanced.
      await vi.advanceTimersByTimeAsync(30);
      const text = await pending;
      // Only the first sample batch ever started.
      expect(measure).toHaveBeenCalledTimes(50);
      expect(measure.mock.calls[0][0]).toBeLessThanOrEqual(30);
      expect(text).toContain('timed out');
    } finally {
      clock.mockRestore();
      vi.useRealTimers();
    }
  });

  it('lists every box, unfiltered, when the captured area is unknown', async () => {
    const text = await formatRefBoxTable(
      [candidate(1, { x: 5, y: 5000, width: 10, height: 10 }), candidate(2, null)],
      null,
      { basis: 'viewport CSS px' },
    );
    expect(text.split('\n')[1]).toBe(UNKNOWN_AREA_LINE);
    expect(text).toContain('ref=1 button "b1" 5,5000,10,10');
  });
});

describe('interleaveByPosition', () => {
  it('merges two ordered lists by relative position', () => {
    expect(interleaveByPosition(['a1', 'a2', 'a3', 'a4'], ['b1', 'b2'])).toEqual(['a1', 'b1', 'a2', 'a3', 'b2', 'a4']);
    expect(interleaveByPosition([], ['b1'])).toEqual(['b1']);
  });
});

describe('refBoxCandidates measurement', () => {
  const page = {} as never;

  it('passes the remaining budget as a timeout, abandons a hanging ref, and disposes every handle it created', async () => {
    const disposed: number[] = [];
    const created: number[] = [];
    listRefEntries.mockReturnValue([
      { ref: 1, role: 'button', name: 'fast' },
      { ref: 2, role: 'button', name: 'late' },
      { ref: 3, role: 'button', name: 'never' },
    ]);
    listSmartElementsOnPage.mockReturnValue([]);
    const handle = (ref: number) => {
      created.push(ref);
      return {
        boundingBox: async () => ({ x: ref, y: ref, width: 10, height: 10 }),
        dispose: async () => { disposed.push(ref); },
      };
    };
    resolveRef.mockImplementation((_p: unknown, ref: string) => {
      if (ref === '1') return Promise.resolve(handle(1));
      if (ref === '2') return new Promise((r) => setTimeout(() => r(handle(2)), 80));
      return new Promise(() => undefined);
    });

    const started = Date.now();
    const text = await formatRefBoxTable(refBoxCandidates(page), AREA, { basis: 'viewport CSS px', budgetMs: 30 });

    expect(Date.now() - started).toBeLessThan(500);
    expect(text).toContain('ref=1 button "fast"');
    expect(text).toContain('Not listed: 2 timed out');
    for (const call of resolveRef.mock.calls) {
      expect(call[2].timeout).toBeGreaterThan(0);
      expect(call[2].timeout).toBeLessThanOrEqual(30);
    }
    // The late handle arrives after the table is done and is still released.
    await new Promise((r) => setTimeout(r, 120));
    expect(created.sort()).toEqual([1, 2]);
    expect(disposed.sort()).toEqual(created);
  });
});
