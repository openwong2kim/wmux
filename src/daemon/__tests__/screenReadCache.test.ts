// fencedRead keeps the last answer per session and kind while its fence holds.
// The readers built on it (queuedSessionText, renderPaneScreen) are tested in
// their own files; this covers what they share: joining a running read, a
// failed read leaving nothing behind, the bound on kinds kept per session, and
// the counters the daemon's diagnostics report.
import { describe, it, expect, beforeEach } from 'vitest';
import { fencedRead, noteScreenParse, resetScreenReadCounters, screenParseCounters, screenReadCounters } from '../screenReadCache';

const keep = (fence: string) => () => fence;

describe('screen parse counters', () => {
  beforeEach(() => resetScreenReadCounters());

  it('count a parse by family, with text reads reduced to depth buckets', () => {
    noteScreenParse('screen:plain', 40, 100);
    noteScreenParse('screen:undimmed', 60, 300);
    noteScreenParse('pane', 10, 50);
    noteScreenParse('text:160', 5, 1);
    noteScreenParse('text:300', 5, 1);
    noteScreenParse('text:2000', 7, 2);
    noteScreenParse('text:5000', 9, 3);
    expect(screenParseCounters()).toEqual({
      screen: { parses: 2, msTotal: 100, msMax: 60, bytes: 400 },
      pane: { parses: 1, msTotal: 10, msMax: 10, bytes: 50 },
      'text<=300': { parses: 2, msTotal: 10, msMax: 5, bytes: 2 },
      'text<=2000': { parses: 1, msTotal: 7, msMax: 7, bytes: 2 },
      'text>2000': { parses: 1, msTotal: 9, msMax: 9, bytes: 3 },
    });
  });
});

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
