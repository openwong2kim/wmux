import { describe, expect, it } from 'vitest';
import {
  CONTINUE_BYTES_MAX,
  CONTINUE_FILES_MAX,
  CONTINUE_TTL_MAX_MS,
  coerceContinuePolicy,
  continueAnswerFor,
  continueClaimable,
  continueClockOk,
  continueOutAllowed,
  continueResumesSource,
  isContinueBranch,
  normalizeContinueRel,
  parseContinueManifest,
  parseContinueRequest,
  parseContinueResult,
  parseContinueStatusQuery,
  type A2aContinueIncomingRecordV1,
  type A2aContinueRequestV1,
} from '../a2aContinue';

const ID = 'ct-0f0e0d0c-0b0a-4908-8706-050403020100';
const SESSION = '7e5f189d-7215-4fd7-8b5d-8786aa5d5b3f';
const HEAD = 'a'.repeat(40);
const SHA = 'b'.repeat(64);
const HOST = '6c1f2a8e-3b4d-4e5f-8a9b-0c1d2e3f4a5b';

const request = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  v: 1,
  continueId: ID,
  sessionId: SESSION,
  agent: 'claude',
  repo: { origin: 'github.com/acme/widget', branch: 'feat/x', head: HEAD },
  estimate: { bytes: 1024, files: 2 },
  expiresAt: '2026-10-29T12:00:00.000Z',
  ...over,
});

const manifest = (files: unknown[], over: Record<string, unknown> = {}): Record<string, unknown> => ({
  v: 1,
  continueId: ID,
  head: HEAD,
  transcript: { sha256: SHA, bytes: 10 },
  files,
  ...over,
});

describe('parseContinueRequest', () => {
  it('takes exactly a request, and keeps a subfolder in its normal form', () => {
    expect(parseContinueRequest(request())).toEqual(request());
    const withSub = parseContinueRequest(request({ repo: { origin: 'github.com/acme/widget', branch: 'main', head: HEAD, sub: 'packages/app' } }));
    expect(withSub?.repo.sub).toBe('packages/app');
  });

  it('refuses extra keys, a URL or a path for origin, a guessed id, and an estimate over the caps', () => {
    expect(parseContinueRequest(request({ from: { kind: 'pane' } }))).toBeNull();
    expect(parseContinueRequest(request({ sessionId: 'latest' }))).toBeNull();
    expect(parseContinueRequest(request({ agent: 'codex' }))).toBeNull();
    for (const origin of ['https://github.com/acme/widget', 'git@github.com:acme/widget', '/srv/git/widget', 'github.com/acme/../x', 'GitHub.com/acme/widget']) {
      expect(parseContinueRequest(request({ repo: { origin, branch: 'main', head: HEAD } }))).toBeNull();
    }
    for (const sub of ['../x', '/abs', 'a//b', './a', 'a\\b', 'apps/aux', 'src/a:b', 'apps.', 'apps/x ']) {
      expect(parseContinueRequest(request({ repo: { origin: 'github.com/acme/widget', branch: 'main', head: HEAD, sub } }))).toBeNull();
    }
    expect(parseContinueRequest(request({ estimate: { bytes: CONTINUE_BYTES_MAX + 1, files: 0 } }))).toBeNull();
    expect(parseContinueRequest(request({ estimate: { bytes: 0, files: CONTINUE_FILES_MAX + 1 } }))).toBeNull();
  });
});

describe('isContinueBranch', () => {
  it('takes a plain branch name and refuses the forms git refuses or another PC could not hold', () => {
    expect(isContinueBranch('feat/a2a-continue_1.2')).toBe(true);
    for (const b of ['', '-x', 'a..b', 'a/', 'a.', '.a', 'a/.b', 'x.lock', 'a//b', 'a b', 'a~1', 'a^', 'a:b', '브랜치', 'a@{1}', 'HEAD', 'HEAD/x']) {
      expect(isContinueBranch(b)).toBe(false);
    }
  });
});

describe('normalizeContinueRel', () => {
  it('takes a plain relative path below the folder', () => {
    expect(normalizeContinueRel('tool-results/toolu_01.txt')).toBe('tool-results/toolu_01.txt');
    expect(normalizeContinueRel('subagents/agent-a1b2.jsonl')).toBe('subagents/agent-a1b2.jsonl');
  });

  it('refuses a path that leaves the folder or that some PC cannot hold as is', () => {
    const bad = [
      '', '/abs', 'a/../b', '..', './a', 'a//b', 'a/', 'a\\b', 'C:x', 'a:b', 'a*b', 'a?b', 'a"b', 'a<b', 'a|b', 'a\u0000b', 'a\nb',
      'CON', 'nul.txt', 'sub/Aux.jsonl', 'com1', 'LPT9.log', 'conin$', 'a.', 'a ', 'dir./x',
      `${'a/'.repeat(8)}b`, 'x'.repeat(121), `${'abcd/'.repeat(48)}x`,
    ];
    for (const rel of bad) expect(normalizeContinueRel(rel)).toBeNull();
  });
});

describe('parseContinueManifest', () => {
  it('takes a manifest within the caps', () => {
    const files = [{ rel: 'tool-results/a.txt', sha256: SHA, bytes: 5 }, { rel: 'subagents/b.jsonl', sha256: SHA, bytes: 7 }];
    expect(parseContinueManifest(manifest(files))).toEqual(manifest(files));
  });

  it('refuses two paths one case-insensitive file system takes for one, and a file where a folder must be', () => {
    expect(parseContinueManifest(manifest([{ rel: 'a/B.txt', sha256: SHA, bytes: 1 }, { rel: 'a/b.txt', sha256: SHA, bytes: 1 }]))).toBeNull();
    // Two forms of one Greek letter.
    expect(parseContinueManifest(manifest([{ rel: 'σ.txt', sha256: SHA, bytes: 1 }, { rel: 'ς.txt', sha256: SHA, bytes: 1 }]))).toBeNull();
    // Composed and decomposed forms of the same name.
    expect(parseContinueManifest(manifest([{ rel: 'café', sha256: SHA, bytes: 1 }, { rel: 'café', sha256: SHA, bytes: 1 }]))).toBeNull();
    expect(parseContinueManifest(manifest([{ rel: 'a', sha256: SHA, bytes: 1 }, { rel: 'A/b', sha256: SHA, bytes: 1 }]))).toBeNull();
  });

  it('refuses totals over the caps, a bad hash, and extra keys', () => {
    const big = Math.floor(CONTINUE_BYTES_MAX / 2);
    expect(parseContinueManifest(manifest([{ rel: 'a', sha256: SHA, bytes: big }, { rel: 'b', sha256: SHA, bytes: big }]))).toBeNull();
    expect(parseContinueManifest(manifest(Array.from({ length: CONTINUE_FILES_MAX + 1 }, (_, i) => ({ rel: `f${i}`, sha256: SHA, bytes: 0 }))))).toBeNull();
    expect(parseContinueManifest(manifest([{ rel: 'a', sha256: 'B'.repeat(64), bytes: 1 }]))).toBeNull();
    expect(parseContinueManifest(manifest([{ rel: 'a', sha256: SHA, bytes: 1, path: '/x' }]))).toBeNull();
    expect(parseContinueManifest(manifest([], { sessionId: SESSION }))).toBeNull();
    expect(parseContinueManifest(manifest([], { head: 'HEAD' }))).toBeNull();
  });
});

describe('results and status', () => {
  it('parses a result and a status query strictly', () => {
    expect(parseContinueResult({ v: 1, continueId: ID, code: 'ready' })).toEqual({ v: 1, continueId: ID, code: 'ready' });
    expect(parseContinueResult({ v: 1, continueId: ID, code: 'ok' })).toBeNull();
    expect(parseContinueResult({ v: 1, continueId: ID, code: 'started', detail: '/x' })).toBeNull();
    expect(parseContinueStatusQuery({ v: 1, continueId: ID })).toEqual({ v: 1, continueId: ID });
    expect(parseContinueStatusQuery({ v: 1, continueId: 'sp-1' })).toBeNull();
  });

  it('resumes the source only on a final answer that is not started', () => {
    // `unknown` is no proof B never ran it: the owner decides.
    for (const code of ['waiting-for-approval', 'ready', 'received', 'started', 'unknown'] as const) expect(continueResumesSource(code)).toBe(false);
    for (const code of ['declined', 'expired', 'failed', 'diverged'] as const) expect(continueResumesSource(code)).toBe(true);
  });

  it("answers a status query from B's record, and unknown without one", () => {
    const parsed = parseContinueRequest(request()) as A2aContinueRequestV1;
    const record = (state: A2aContinueIncomingRecordV1['state'], code?: A2aContinueIncomingRecordV1['code']): A2aContinueIncomingRecordV1 => ({
      v: 1, hostId: HOST, request: parsed, state, ...(code ? { code } : {}), receivedAt: '2026-10-29T11:00:00.000Z', updatedAt: '2026-10-29T11:00:00.000Z',
    });
    expect(continueAnswerFor(undefined)).toBe('unknown');
    expect(continueAnswerFor(record('awaiting'))).toBe('waiting-for-approval');
    expect(continueAnswerFor(record('receiving'))).toBe('ready');
    expect(continueAnswerFor(record('starting'))).toBe('received');
    expect(continueAnswerFor(record('decided', 'started'))).toBe('started');
    expect(continueAnswerFor(record('decided'))).toBe('failed');
    expect(continueAnswerFor(record('decided', 'received'))).toBe('failed');

    const expires = Date.parse(parsed.expiresAt);
    expect(continueClaimable(record('received'), expires)).toBe(true);
    expect(continueClaimable(record('received'), expires + 1)).toBe(false);
    expect(continueClaimable(record('receiving'), expires - 1000)).toBe(false);
    expect(continueClaimable(record('decided', 'expired'), expires - 1000)).toBe(false);
  });

  it('keeps a request inside its window by the receiver clock', () => {
    const now = Date.parse('2026-10-29T12:00:00.000Z');
    const at = (ms: number) => new Date(now + ms).toISOString();
    expect(continueClockOk(at(0), at(60_000), now)).toBe(true);
    expect(continueClockOk(at(11 * 60_000), at(20 * 60_000), now)).toBe(false);
    expect(continueClockOk(at(0), at(CONTINUE_TTL_MAX_MS + 1), now)).toBe(false);
    expect(continueClockOk(at(-60_000), at(-1), now)).toBe(false);
  });
});

describe('coerceContinuePolicy', () => {
  it('is off by default, never takes a mode that skips permission checks, and allows only the PCs listed', () => {
    const policy = coerceContinuePolicy({ v: 1, in: { enabled: true, permissionMode: 'bypassPermissions' }, out: { [HOST]: { allowed: true }, 'not-a-host': { allowed: true } }, version: 3 });
    expect(policy?.in).toEqual({ enabled: true, permissionMode: 'auto' });
    expect(policy?.version).toBe(3);
    expect(Object.keys(policy?.out ?? {})).toEqual([HOST]);
    expect(policy && continueOutAllowed(policy, HOST)).toBe(true);
    const off = coerceContinuePolicy({ v: 1 });
    expect(off?.in.enabled).toBe(false);
    expect(off && continueOutAllowed(off, HOST)).toBe(false);
    expect(coerceContinuePolicy({ v: 2 })).toBeNull();
  });
});
