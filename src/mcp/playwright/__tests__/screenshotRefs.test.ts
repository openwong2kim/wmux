import { describe, expect, it, vi } from 'vitest';

vi.mock('../snapshot', () => ({ listRefEntries: vi.fn(), resolveRef: vi.fn() }));
vi.mock('../dom-intelligence', () => ({
  listSmartElementsOnPage: vi.fn(),
  resolveSmartRefLocator: vi.fn(),
}));

import {
  NO_SNAPSHOT_REFS_LINE,
  formatRefBoxTable,
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
      [candidate(61, { x: 20, y: 30, width: 40, height: 10 }, { param: 'smartRef', role: 'textbox', name: 'Say "hi"\n there' })],
      { x: 0, y: 0, width: 1000, height: 5000 },
      { offset: { x: 0, y: 2000 }, basis: 'document CSS px' },
    );
    expect(text).toContain('smartRef=61 textbox "Say \\"hi\\" there" 20,2030,40,10');
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
});
