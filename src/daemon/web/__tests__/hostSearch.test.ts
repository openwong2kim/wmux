import { describe, it, expect } from 'vitest';
import type { TurnEvent } from '../../../shared/transcript/turnEvents';
import {
  buildSnippet,
  composeTitle,
  createSearchCursorCodec,
  foldCase,
  joinWrappedRows,
  parseSearchRequest,
  runSearch,
  ScrollbackTextCache,
  searchForbidden,
  SEARCH_LIMITS,
  type SearchPane,
  type SearchRequest,
  type SearchSources,
  type TurnPage,
  type TurnSource,
} from '../hostSearch';

const codec = createSearchCursorCodec(Buffer.alloc(32, 7));
const request = (query: string, extra: Partial<SearchRequest> = {}): SearchRequest => ({
  query, scopes: ['turns', 'sessions'], limit: 50, cursor: null, ...extra,
});
const pane = (sessionId: string, extra: Partial<SearchPane> = {}): SearchPane => ({
  sessionId, alive: true, recency: 1000, ...extra,
});
const user = (id: string, text: string, ts?: number): TurnEvent => ({ kind: 'user_text', id, text, ...(ts !== undefined ? { ts } : {}) });
const assistant = (id: string, text: string, ts?: number, thinking = false): TurnEvent =>
  ({ kind: 'assistant_text', id, text, ...(ts !== undefined ? { ts } : {}), ...(thinking ? { thinking } : {}) });
const sources = (extra: Partial<SearchSources> = {}): SearchSources => ({
  panes: [], scrollbackPanes: [], allowTranscript: true, now: () => 0, ...extra,
});
/** A file source that serves `pages` newest first. */
const fileSource = (pages: TurnPage[], cursorFor?: (lineEnd: number) => string): TurnSource => {
  let i = 0;
  return { kind: 'file', next: () => pages[i++] ?? null, ...(cursorFor ? { cursorFor } : {}) };
};
const params = (q: string) => new URLSearchParams(q);
const tag = (fn: () => unknown) => { try { fn(); return 'ok'; } catch (e) { return (e as { tag?: string }).tag; } };
/** encodeURIComponent throws on a lone surrogate, so this proves no pair was cut. */
const wellFormed = (s: string) => { encodeURIComponent(s); return true; };

describe('parseSearchRequest', () => {
  it('trims the query and applies the defaults', () => {
    expect(parseSearchRequest(params('q=%20%20hello%20'))).toEqual({ query: 'hello', scopes: ['turns', 'sessions'], limit: 50, cursor: null });
  });

  it('refuses a query outside 2..200 units after trim, or with NUL', () => {
    expect(tag(() => parseSearchRequest(params('q=%20a%20')))).toBe('invalid-query');
    expect(tag(() => parseSearchRequest(params('')))).toBe('invalid-query');
    expect(tag(() => parseSearchRequest(params(`q=${'x'.repeat(201)}`)))).toBe('invalid-query');
    expect(tag(() => parseSearchRequest(params(`q=${'x'.repeat(200)}`)))).toBe('ok');
    expect(tag(() => parseSearchRequest(params('q=ab%00cd')))).toBe('invalid-query');
  });

  it('dedupes known scopes into canonical order and refuses anything else', () => {
    expect(parseSearchRequest(params('q=ab&scope=scrollback,turns,turns')).scopes).toEqual(['turns', 'scrollback']);
    expect(tag(() => parseSearchRequest(params('q=ab&scope=turns,files')))).toBe('invalid-scope');
    expect(tag(() => parseSearchRequest(params('q=ab&scope=')))).toBe('invalid-scope');
  });

  it('accepts a limit of 1..100 only', () => {
    expect(parseSearchRequest(params('q=ab&limit=100')).limit).toBe(100);
    for (const bad of ['0', '101', '1.5', '-1', 'ten', '']) {
      expect(tag(() => parseSearchRequest(params(`q=ab&limit=${bad}`)))).toBe('invalid-limit');
    }
  });
});

describe('case folding and snippets', () => {
  it('folds without moving any offset', () => {
    expect(foldCase('ABC Σ')).toBe('abc σ');
    // U+0130 lowercases to two units; kept as is so every later index holds.
    expect(foldCase('İstanbul').length).toBe('İstanbul'.length);
    expect(foldCase('한글 😀 Emoji')).toBe('한글 😀 emoji');
  });

  it('cuts about 160 units around the match, with UTF-16 ranges, never through a surrogate pair', () => {
    const text = '😀'.repeat(100) + '한글 SEARCH 결과, search again' + '🎉'.repeat(100);
    const folded = foldCase(text);
    const needle = foldCase('Search');
    const { snippet, matchRanges } = buildSnippet(text, folded, needle, folded.indexOf(needle));
    expect(snippet.length).toBeGreaterThanOrEqual(159);
    expect(snippet.length).toBeLessThanOrEqual(161);
    expect(wellFormed(snippet)).toBe(true);
    expect(matchRanges).toHaveLength(2);
    expect(matchRanges.map(([s, l]) => snippet.slice(s, s + l))).toEqual(['SEARCH', 'search']);
    // The emoji before the match count two units each, as NSString does.
    const [start] = matchRanges[0];
    expect(snippet.slice(start - 3, start)).toBe('한글 ');
  });

  it('keeps a short text whole and a long match whole', () => {
    expect(buildSnippet('abc def', 'abc def', 'def', 4)).toEqual({ snippet: 'abc def', matchRanges: [[4, 3]] });
    const long = 'q'.repeat(190);
    expect(buildSnippet('x' + long + 'y', 'x' + long + 'y', long, 1).matchRanges).toEqual([[expect.any(Number), 190]]);
  });

  it('composes the title from what is known', () => {
    expect(composeTitle({ workspace: 'wmux', agent: 'Claude', cwdLeaf: 'repo' }, 'id')).toBe('wmux · Claude · repo');
    expect(composeTitle({ agent: 'Codex' }, 'id')).toBe('Codex');
    expect(composeTitle({}, 'pane-7')).toBe('pane-7');
  });
});

describe('runSearch — turns', () => {
  it('matches user and assistant text case-insensitively, and nothing else', async () => {
    const events: TurnEvent[] = [
      user('u1', 'Please FIX the parser', 10),
      assistant('a1', 'Fixed it:\u0000code:0\u0000 the parser now works', 20),
      assistant('t1', 'thinking about the parser', 30, true),
      { kind: 'tool_use', id: 'x1', toolUseId: 't', name: 'Bash', argSummary: 'grep parser', ts: 40 },
    ];
    const out = await runSearch(request('PARSER', { scopes: ['turns'] }), null, sources({
      panes: [pane('p1')],
      turns: async () => ({ kind: 'page', events }),
    }), codec);
    expect(out.results.map((r) => r.turnEventId)).toEqual(['a1', 'u1']);
    expect(out.results[0]).toMatchObject({ kind: 'turn', sessionId: 'p1', at: 20, alive: true });
    // The code-block marker never reaches the phone.
    expect(out.results[0].snippet).not.toContain('\u0000');
    expect(out.coverage).toEqual({ searchedSessions: 1, skippedSessions: [] });
    expect(out.truncated).toBe(false);
  });

  it('orders timed hits newest first across panes, then untimed ones by pane recency', async () => {
    const out = await runSearch(request('needle', { scopes: ['turns'] }), null, sources({
      panes: [pane('old', { recency: 1 }), pane('new', { recency: 9 })],
      turns: async (id) => ({ kind: 'page', events: id === 'old'
        ? [user('o1', 'needle', 50), user('o2', 'needle')]
        : [user('n1', 'needle', 40), user('n2', 'needle')] }),
    }), codec);
    expect(out.results.map((r) => r.turnEventId)).toEqual(['o1', 'n1', 'n2', 'o2']);
  });

  it('reports the resolver reason for a session it cannot read', async () => {
    const out = await runSearch(request('abc', { scopes: ['turns'] }), null, sources({
      panes: [pane('p1')],
      turns: async () => ({ kind: 'skip', reason: 'no-transcript-path' }),
    }), codec);
    expect(out.coverage).toEqual({ searchedSessions: 0, skippedSessions: [{ sessionId: 'p1', scope: 'turns', reason: 'no-transcript-path' }] });
    expect(out.truncated).toBe(false);
  });

  it('stops at the per-session window, keeps what it read, and says so', async () => {
    const pages: TurnPage[] = [
      { events: [user('new', 'match here', 20)], lineEnds: [300], bytes: 100, done: false },
      { events: [user('old', 'match there', 10)], lineEnds: [200], bytes: 100, done: true },
    ];
    const out = await runSearch(request('match', { scopes: ['turns'] }), null, sources({
      panes: [pane('p1')],
      turns: async () => fileSource(pages, (end) => `cursor-${end}`),
      limits: { ...SEARCH_LIMITS, sessionBytes: 100 },
    }), codec);
    expect(out.results.map((r) => [r.turnEventId, r.turnCursor])).toEqual([['new', 'cursor-300']]);
    expect(out.truncated).toBe(true);
    expect(out.coverage.skippedSessions).toEqual([{ sessionId: 'p1', scope: 'turns', reason: 'budget' }]);
    expect(out.coverage.searchedSessions).toBe(1);
  });

  it('reads a whole small file without truncating', async () => {
    const pages: TurnPage[] = [
      { events: [user('new', 'match', 20)], lineEnds: [300], bytes: 100, done: false },
      { events: [user('old', 'match', 10)], lineEnds: [200], bytes: 100, done: true },
    ];
    const out = await runSearch(request('match', { scopes: ['turns'] }), null, sources({
      panes: [pane('p1')], turns: async () => fileSource(pages),
    }), codec);
    expect(out.results.map((r) => r.turnEventId)).toEqual(['new', 'old']);
    expect(out.truncated).toBe(false);
  });

  it('spends the total byte budget and the wall clock across panes', async () => {
    const onePage = (): TurnSource => fileSource([{ events: [user('e', 'match', 1)], lineEnds: [1], bytes: 100, done: true }]);
    const bytes = await runSearch(request('match', { scopes: ['turns'] }), null, sources({
      panes: [pane('a', { recency: 3 }), pane('b', { recency: 2 }), pane('c', { recency: 1 })],
      turns: async () => onePage(),
      limits: { ...SEARCH_LIMITS, totalBytes: 150 },
    }), codec);
    expect(bytes.truncated).toBe(true);
    expect(bytes.coverage.skippedSessions).toEqual([{ sessionId: 'c', scope: 'turns', reason: 'budget' }]);

    let clock = 0;
    const timed = await runSearch(request('match', { scopes: ['turns'] }), null, sources({
      panes: [pane('a', { recency: 3 }), pane('b', { recency: 2 })],
      // The first pane's read is what spends the clock.
      turns: async () => ({ kind: 'file', next: () => {
        clock += 5000;
        return { events: [user('e', 'match', 1)], lineEnds: [1], bytes: 100, done: true };
      } }),
      now: () => clock,
    }), codec);
    expect(timed.truncated).toBe(true);
    expect(timed.coverage.skippedSessions).toEqual([{ sessionId: 'b', scope: 'turns', reason: 'budget' }]);
  });
});

describe('runSearch — sessions and scrollback', () => {
  it('matches pane metadata once per pane, and run history with its time', async () => {
    const out = await runSearch(request('deploy', { scopes: ['sessions'] }), null, sources({
      panes: [pane('p1', { workspace: 'Deploy', agent: 'Claude', cwd: '/src/deploy-tool', cwdLeaf: 'deploy-tool', surfaceTitle: 'Deploy run' })],
      history: () => [
        { id: 'h1', sessionId: 'p1', workspace: 'Deploy', agent: 'Claude', at: 500, summary: 'Finished the deploy script' },
        { id: 'h2', sessionId: 'gone', workspace: 'Ops', agent: 'Codex', at: 400, summary: 'deploy rolled back' },
      ],
    }), codec);
    expect(out.results).toEqual([
      expect.objectContaining({ kind: 'session', sessionId: 'p1', at: 500, alive: true, title: 'Deploy · Claude · deploy-tool', surfaceTitle: 'Deploy run' }),
      expect.objectContaining({ kind: 'session', sessionId: 'gone', at: 400, title: 'Ops · Codex' }),
      expect.objectContaining({ kind: 'session', sessionId: 'p1', snippet: 'Deploy · Claude · deploy-tool' }),
    ]);
    // A run with no pane behind it says nothing about liveness.
    expect(out.results[1]).not.toHaveProperty('alive');
  });

  it('searches scrollback lines across wraps, capping fresh extractions but not cached ones', async () => {
    const reads: string[] = [];
    const out = await runSearch(request('ERROR', { scopes: ['scrollback'] }), null, sources({
      scrollbackPanes: [pane('cached', { recency: 9 }), pane('fresh', { recency: 5, alive: false }), pane('late', { recency: 1 })],
      scrollback: {
        cached: (id) => (id === 'cached' ? ['build ok', 'build error: x'] : undefined),
        read: async (id) => { reads.push(id); return joinWrappedRows([{ text: 'fatal err', wrapped: false }, { text: 'or here', wrapped: true }]); },
      },
      limits: { ...SEARCH_LIMITS, scrollbackPanes: 1 },
    }), codec);
    expect(reads).toEqual(['fresh']);
    expect(out.results.map((r) => [r.sessionId, r.snippet, r.alive])).toEqual([
      ['cached', 'build error: x', true],
      ['fresh', 'fatal error here', false],
    ]);
    expect(out.results[0]).not.toHaveProperty('at');
    expect(out.coverage.skippedSessions).toEqual([{ sessionId: 'late', scope: 'scrollback', reason: 'budget' }]);
    expect(out.truncated).toBe(true);
  });

  it('covers more panes than the cache holds once warm, instead of evicting the pane it reads next', async () => {
    // Wired as handleSearch wires it: one shared cache, filled after each read.
    // Scanning in recency order and reading as it went, each fresh read evicted
    // the least recently used entry, which was the next pane in the scan; a
    // static nine-pane host then came back truncated on every other search.
    const cache = new ScrollbackTextCache(8);
    const panes = Array.from({ length: 9 }, (_, i) => pane(`p${i}`, { recency: 100 - i }));
    const reads: string[] = [];
    const reader = {
      cached: (id: string) => cache.get(id, 'k'),
      read: async (id: string) => { reads.push(id); const lines = [`needle in ${id}`]; cache.set(id, 'k', lines); return lines; },
    };
    const search = () => runSearch(request('needle', { scopes: ['scrollback'] }), null, sources({ scrollbackPanes: panes, scrollback: reader }), codec);
    const first = await search();
    expect(first.results).toHaveLength(6);
    expect(first.truncated).toBe(true);
    for (let round = 0; round < 4; round++) {
      reads.length = 0;
      const again = await search();
      expect(again.results).toHaveLength(9);
      expect(again.coverage.skippedSessions).toEqual([]);
      expect(again.truncated).toBe(false);
      expect(reads.length).toBeLessThanOrEqual(SEARCH_LIMITS.scrollbackPanes);
    }
  });

  it('skips a pane whose ring cannot be read as unavailable', async () => {
    const out = await runSearch(request('abc', { scopes: ['scrollback'] }), null, sources({
      scrollbackPanes: [pane('p1')],
      scrollback: { cached: () => undefined, read: async () => null },
    }), codec);
    expect(out.coverage.skippedSessions).toEqual([{ sessionId: 'p1', scope: 'scrollback', reason: 'unavailable' }]);
    expect(out.truncated).toBe(false);
  });
});

describe('gates', () => {
  it('forbids only a request whose every scope needs the transcript grant', () => {
    expect(searchForbidden(['turns', 'sessions'], false)).toBe(true);
    expect(searchForbidden(['turns', 'scrollback'], false)).toBe(false);
    expect(searchForbidden(['turns', 'sessions'], true)).toBe(false);
  });

  it('reports every pane as transcript-disabled for the gated scopes and still searches scrollback', async () => {
    let turnReads = 0;
    const out = await runSearch(request('hello', { scopes: ['turns', 'sessions', 'scrollback'] }), null, sources({
      allowTranscript: false,
      panes: [pane('p1', { workspace: 'hello' })],
      scrollbackPanes: [pane('p1')],
      history: () => [{ id: 'h', sessionId: 'p1', workspace: 'w', agent: 'a', at: 1, summary: 'hello' }],
      turns: async () => { turnReads += 1; return { kind: 'page', events: [user('u', 'hello')] }; },
      scrollback: { cached: () => ['hello world'], read: async () => null },
    }), codec);
    expect(turnReads).toBe(0);
    expect(out.results.map((r) => r.kind)).toEqual(['scrollback']);
    expect(out.coverage.skippedSessions).toEqual([
      { sessionId: 'p1', scope: 'turns', reason: 'transcript-disabled' },
      { sessionId: 'p1', scope: 'sessions', reason: 'transcript-disabled' },
    ]);
  });
});

describe('cursor', () => {
  const events = [1, 2, 3, 4, 5].map((n) => user(`e${n}`, `match ${n}`, n));
  const run = (req: SearchRequest) => runSearch(req, req.cursor === null ? null : codec.decode(req, req.cursor), sources({
    panes: [pane('p1')], turns: async () => ({ kind: 'page', events }),
  }), codec);

  it('round-trips: pages continue exactly where the last one stopped', async () => {
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let i = 0; i < 5; i++) {
      const out = await run(request('match', { scopes: ['turns'], limit: 2, cursor }));
      seen.push(...out.results.map((r) => r.turnEventId as string));
      cursor = out.nextCursor;
      if (cursor === null) break;
    }
    expect(seen).toEqual(['e5', 'e4', 'e3', 'e2', 'e1']);
    expect(cursor).toBeNull();
  });

  it('refuses a cursor that was edited, belongs to another query or scope set, or another daemon', async () => {
    const req = request('match', { scopes: ['turns'], limit: 2 });
    const cursor = (await run(req)).nextCursor as string;
    expect(tag(() => codec.decode(req, cursor))).toBe('ok');
    // Case folding is part of the query's identity, so a re-cased query continues.
    expect(tag(() => codec.decode({ ...req, query: 'MATCH' }, cursor))).toBe('ok');

    const [payload, mac] = cursor.split('.');
    const edited = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(payload, 'base64url').toString()), k: [null, 0, 'p1', 'turn', 0, 'e0'] })).toString('base64url');
    expect(tag(() => codec.decode(req, `${edited}.${mac}`))).toBe('invalid-cursor');
    expect(tag(() => codec.decode({ ...req, query: 'other' }, cursor))).toBe('invalid-cursor');
    expect(tag(() => codec.decode({ ...req, scopes: ['turns', 'sessions'] }, cursor))).toBe('invalid-cursor');
    expect(tag(() => createSearchCursorCodec(Buffer.alloc(32, 8)).decode(req, cursor))).toBe('invalid-cursor');
    for (const junk of ['x', 'a.b', `${cursor}.more`, 'y'.repeat(2000)]) expect(tag(() => codec.decode(req, junk))).toBe('invalid-cursor');
  });
});

describe('scrollback text cache', () => {
  it('serves only the key it was filled under, evicts the oldest, and forgets closed panes', () => {
    const cache = new ScrollbackTextCache(2);
    cache.set('a', 'k1', ['a']);
    expect(cache.get('a', 'k1')).toEqual(['a']);
    expect(cache.get('a', 'k2')).toBeUndefined();
    cache.set('b', 'k', ['b']);
    cache.get('a', 'k1'); // a is now the most recent
    cache.set('c', 'k', ['c']);
    expect(cache.get('b', 'k')).toBeUndefined();
    expect(cache.get('a', 'k1')).toEqual(['a']);
    cache.retain(new Set(['c']));
    expect(cache.size).toBe(1);
  });
});
