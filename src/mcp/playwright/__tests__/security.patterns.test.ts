import { describe, expect, it } from 'vitest';
import { detectDangerousPatterns } from '../security';

// Where the browser_evaluate blocklist actually draws its line.
//
// The tool description used to say only "a text scan", which left an agent to
// guess whether it was a substring match — and under a substring match every
// ordinary identifier containing `eval` or `fetch` (`retrieval`,
// `evaluateScore`, `prefetch`) would be refused. It is not a substring match,
// and these tests pin the two distinct shapes the patterns actually have so
// the description cannot drift away from the code.

describe('browser_evaluate dangerous-pattern boundaries', () => {
  it('does not fire on identifiers that merely contain a blocked name', () => {
    // The exact identifiers the dogfood report named as the worry.
    expect(detectDangerousPatterns('retrieval')).toEqual([]);
    expect(detectDangerousPatterns('const retrieval = index.retrieval')).toEqual([]);
    expect(detectDangerousPatterns('evaluateScore(x)')).toEqual([]);
    expect(detectDangerousPatterns('prefetch(url)')).toEqual([]);
    expect(detectDangerousPatterns('requireAuth(1)')).toEqual([]);
    expect(detectDangerousPatterns('important(1)')).toEqual([]);
    expect(detectDangerousPatterns('document.cookies')).toEqual([]);
    expect(detectDangerousPatterns('sessionStorageX')).toEqual([]);
  });

  it('is case-sensitive', () => {
    expect(detectDangerousPatterns('myFetch(1)')).toEqual([]);
    expect(detectDangerousPatterns('websocket')).toEqual([]);
    expect(detectDangerousPatterns('indexeddb')).toEqual([]);
    expect(detectDangerousPatterns('myLocalStorage')).toEqual([]);
  });

  it('needs the call form for fetch/eval/require/import, not the bare name', () => {
    expect(detectDangerousPatterns('fetch')).toEqual([]);
    expect(detectDangerousPatterns('const f = eval')).toEqual([]);

    expect(detectDangerousPatterns('window.fetch(url)')).toEqual(['fetch()']);
    // Whitespace between the name and its parenthesis still counts.
    expect(detectDangerousPatterns('fetch (url)')).toEqual(['fetch()']);
    expect(detectDangerousPatterns('el.eval(x)')).toEqual(['eval()']);
    expect(detectDangerousPatterns('require("fs")')).toEqual(['require()']);
    expect(detectDangerousPatterns('import("./x")')).toEqual(['dynamic import()']);
    expect(detectDangerousPatterns('new  Function("x")')).toEqual(['new Function()']);
  });

  it('matches the storage/transport names as a bare word anywhere, comments included', () => {
    expect(detectDangerousPatterns('localStorage')).toEqual(['localStorage access']);
    expect(detectDangerousPatterns('x.localStorage.y')).toEqual(['localStorage access']);
    // The honest half of "reads strings and comments too": an inert mention is
    // refused all the same.
    expect(detectDangerousPatterns('// localStorage is fine')).toEqual(['localStorage access']);
    expect(detectDangerousPatterns('"use localStorage"')).toEqual(['localStorage access']);
    expect(detectDangerousPatterns('new WebSocket(u)')).toEqual(['WebSocket']);
    expect(detectDangerousPatterns('document.cookie')).toEqual(['document.cookie access']);
  });
});
