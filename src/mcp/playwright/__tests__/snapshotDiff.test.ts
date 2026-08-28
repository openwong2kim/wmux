import { describe, expect, it } from 'vitest';
import { diffSnapshotLines, formatSnapshotResult } from '../snapshotDiff';

// browser_snapshot auto-diff (Phase 1): line-LCS over the line-oriented
// snapshot text, with a full-snapshot fallback whenever a diff would not be a
// real savings. The first line of every result declares which was returned.

function lines(n: number, prefix = 'line'): string {
  return Array.from({ length: n }, (_, i) => `- ${prefix} ${i} [ref=${i}]`).join('\n');
}

describe('diffSnapshotLines', () => {
  it('reports only the changed region with @ line markers and 1 context line', () => {
    const prev = lines(30);
    const next = prev.replace('- line 12 [ref=12]', '- line 12 CHANGED [ref=12]');

    const diff = diffSnapshotLines(prev, next);
    expect(diff).not.toBeNull();
    expect(diff!.changedLines).toBe(2); // one removed + one added
    expect(diff!.text).toContain('@ line');
    expect(diff!.text).toContain('- - line 12 [ref=12]');
    expect(diff!.text).toContain('+ - line 12 CHANGED [ref=12]');
    // Distant unchanged lines are omitted.
    expect(diff!.text).not.toContain('line 0 ');
    expect(diff!.text).not.toContain('line 29');
  });

  it('returns a zero-change marker for identical inputs', () => {
    const text = lines(5);
    expect(diffSnapshotLines(text, text)).toEqual({
      text: '(no changes since previous snapshot)',
      changedLines: 0,
    });
  });

  it('bails (null) when the changed region exceeds the DP bound', () => {
    const prev = lines(900, 'old');
    const next = lines(900, 'new');
    expect(diffSnapshotLines(prev, next)).toBeNull();
  });
});

describe('formatSnapshotResult', () => {
  it('returns full with header when no baseline exists', () => {
    const out = formatSnapshotResult(null, 'a\nb');
    expect(out.usedDiff).toBe(false);
    expect(out.text.startsWith('[snapshot: full]\n')).toBe(true);
    expect(out.text).toContain('a\nb');
  });

  it('returns a diff with header when the change is small', () => {
    const prev = lines(40);
    const next = prev.replace('- line 3 [ref=3]', '- line 3 NEW [ref=3]');
    const out = formatSnapshotResult(prev, next);
    expect(out.usedDiff).toBe(true);
    expect(out.text.split('\n')[0]).toContain('[snapshot: diff vs previous');
    expect(out.text).toContain('full:true');
    expect(out.text).toContain('+ - line 3 NEW [ref=3]');
  });

  it('falls back to full when the diff is not a real savings (>50%)', () => {
    const prev = lines(10, 'old');
    const next = lines(10, 'new');
    const out = formatSnapshotResult(prev, next);
    expect(out.usedDiff).toBe(false);
    expect(out.text.startsWith('[snapshot: full]\n')).toBe(true);
  });
});
