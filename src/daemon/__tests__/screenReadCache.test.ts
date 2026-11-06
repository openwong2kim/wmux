// fencedRead keeps the last answer per session and kind while its fence holds.
// The readers built on it (queuedSessionText, renderPaneScreen) are tested in
// their own files; this covers what they share: joining a running read, a
// failed read leaving nothing behind, the bound on kinds kept per session, and
// the counters the daemon's diagnostics report.
import { describe, it, expect, beforeEach } from 'vitest';
import { fencedRead, resetScreenReadCounters, screenReadCounters } from '../screenReadCache';

const keep = (fence: string) => () => fence;

describe('fencedRead', () => {
  beforeEach(() => resetScreenReadCounters());

  it('joins a running read of the same fence and counts hits, joins and misses by family', async () => {
    const owner = {};
    let reads = 0;
    const read = async () => ++reads;
    const first = fencedRead(owner, 'text:300', '10:80x24', read, keep('10:80x24'));
    const joined = fencedRead(owner, 'text:300', '10:80x24', read, keep('10:80x24'));
    expect(joined).toBe(first);
    expect(await first).toBe(1);
    expect(await fencedRead(owner, 'text:300', '10:80x24', read, keep('10:80x24'))).toBe(1);
    expect(await fencedRead(owner, 'text:2000', '10:80x24', read, keep('10:80x24'))).toBe(2);
    expect(reads).toBe(2);
    expect(screenReadCounters()).toEqual({ text: { hits: 1, joins: 1, misses: 2 } });
  });

  it('a failed read rejects every joiner and leaves nothing to reuse', async () => {
    const owner = {};
    let fail = true;
    const read = async () => { if (fail) throw new Error('parse failed'); return 'screen'; };
    const first = fencedRead(owner, 'screen:plain', 'f', read, keep('f'));
    const joined = fencedRead(owner, 'screen:plain', 'f', read, keep('f'));
    await expect(first).rejects.toThrow('parse failed');
    await expect(joined).rejects.toThrow('parse failed');
    fail = false;
    expect(await fencedRead(owner, 'screen:plain', 'f', read, keep('f'))).toBe('screen');
  });

  it('keeps a bounded number of kinds per session, dropping the least recently used', async () => {
    const owner = {};
    let reads = 0;
    const read = async () => ++reads;
    for (const depth of [1, 2, 3, 4]) await fencedRead(owner, `text:${depth}`, 'f', read, keep('f'));
    await fencedRead(owner, 'text:1', 'f', read, keep('f')); // a hit: text:1 is the newest again
    await fencedRead(owner, 'text:5', 'f', read, keep('f')); // drops text:2, the least recently used
    expect(reads).toBe(5);
    await fencedRead(owner, 'text:1', 'f', read, keep('f'));
    expect(reads).toBe(5);
    await fencedRead(owner, 'text:2', 'f', read, keep('f'));
    expect(reads).toBe(6);
  });
});
