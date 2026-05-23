import { describe, it, expect } from 'vitest';
import { resolvePtyIdForCwd, extractUsageFromPayload } from '../hooks.rpc';

describe('resolvePtyIdForCwd', () => {
  it('exact cwd match returns activePtyId', () => {
    const got = resolvePtyIdForCwd('/foo/bar', [
      {
        id: 'w1',
        name: 'one',
        metadata: { cwd: '/foo/bar' },
        activePtyId: 'p1',
        ptyIds: ['p1', 'p2'],
      },
    ]);
    expect(got).toBe('p1');
  });

  it('prefix match returns longest-matching workspace ptyId', () => {
    const got = resolvePtyIdForCwd('/foo/bar/baz/qux', [
      { id: 'w1', name: 'short', metadata: { cwd: '/foo' }, activePtyId: 'p1', ptyIds: ['p1'] },
      { id: 'w2', name: 'long', metadata: { cwd: '/foo/bar' }, activePtyId: 'p2', ptyIds: ['p2'] },
      { id: 'w3', name: 'other', metadata: { cwd: '/other' }, activePtyId: 'p3', ptyIds: ['p3'] },
    ]);
    expect(got).toBe('p2'); // longest prefix wins
  });

  it('rejects non-directory prefix matches (no /foo/barber match for workspace /foo/bar)', () => {
    const got = resolvePtyIdForCwd('/foo/barber', [
      { id: 'w1', name: 'one', metadata: { cwd: '/foo/bar' }, activePtyId: 'p1', ptyIds: ['p1'] },
    ]);
    expect(got).toBeNull();
  });

  it('Windows-style paths normalize to forward slash, lowercase drive', () => {
    const got = resolvePtyIdForCwd('D:\\wmux\\src', [
      {
        id: 'w1',
        name: 'wmux',
        metadata: { cwd: 'd:/wmux' },
        activePtyId: 'p1',
        ptyIds: ['p1'],
      },
    ]);
    expect(got).toBe('p1');
  });

  it('no workspace owns the cwd → null', () => {
    const got = resolvePtyIdForCwd('/not/wmux', [
      { id: 'w1', name: 'one', metadata: { cwd: '/foo' }, activePtyId: 'p1', ptyIds: ['p1'] },
    ]);
    expect(got).toBeNull();
  });

  it('workspace with missing metadata.cwd is ignored', () => {
    const got = resolvePtyIdForCwd('/foo', [
      { id: 'w1', name: 'no-cwd', activePtyId: 'p1', ptyIds: ['p1'] },
      { id: 'w2', name: 'with-cwd', metadata: { cwd: '/foo' }, activePtyId: 'p2', ptyIds: ['p2'] },
    ]);
    expect(got).toBe('p2');
  });

  it('falls back to first ptyId when activePtyId missing', () => {
    const got = resolvePtyIdForCwd('/foo', [
      { id: 'w1', name: 'no-active', metadata: { cwd: '/foo' }, ptyIds: ['p1', 'p2'] },
    ]);
    expect(got).toBe('p1');
  });

  it('returns null when workspace has neither activePtyId nor ptyIds', () => {
    const got = resolvePtyIdForCwd('/foo', [
      { id: 'w1', name: 'empty', metadata: { cwd: '/foo' } },
    ]);
    expect(got).toBeNull();
  });

  it('rejects path-traversal escapes via canonicalization (codex P1 #8)', () => {
    // `/repo/../other` collapses to `/other` after canonicalization.
    // It must NOT match the workspace at `/repo`.
    const got = resolvePtyIdForCwd('/repo/../other', [
      { id: 'w1', name: 'repo', metadata: { cwd: '/repo' }, activePtyId: 'p1', ptyIds: ['p1'] },
      { id: 'w2', name: 'other', metadata: { cwd: '/other' }, activePtyId: 'p2', ptyIds: ['p2'] },
    ]);
    expect(got).toBe('p2');
  });

  it('collapses redundant ./ and // segments', () => {
    const got = resolvePtyIdForCwd('/repo/./src//foo', [
      { id: 'w1', name: 'repo', metadata: { cwd: '/repo' }, activePtyId: 'p1', ptyIds: ['p1'] },
    ]);
    expect(got).toBe('p1');
  });

  it('exact match short-circuits before prefix scan', () => {
    // If exact-match were not first, the prefix scan over '/foo' would
    // also produce a longest-prefix hit (length 4) on the second entry,
    // and we'd return that. Exact match must beat any prefix.
    const got = resolvePtyIdForCwd('/foo/bar', [
      { id: 'w1', name: 'prefix', metadata: { cwd: '/foo' }, activePtyId: 'p1', ptyIds: ['p1'] },
      { id: 'w2', name: 'exact', metadata: { cwd: '/foo/bar' }, activePtyId: 'p2', ptyIds: ['p2'] },
    ]);
    expect(got).toBe('p2');
  });
});

describe('isAgentSignal (re-export check)', () => {
  // Smoke-imported separately to keep this file focused; full validation
  // tests live next to signal-types.ts spec if needed. Here we just make
  // sure the public API surface is exported.
  it('module exports resolvePtyIdForCwd', () => {
    expect(typeof resolvePtyIdForCwd).toBe('function');
  });
});

describe('extractUsageFromPayload', () => {
  it('extracts a well-formed usage block', () => {
    const got = extractUsageFromPayload({
      usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
    });
    expect(got).toEqual({ inputTokens: 100, outputTokens: 50, totalTokens: 150 });
  });

  it('returns null when payload has no usage field', () => {
    expect(extractUsageFromPayload({})).toBeNull();
    expect(extractUsageFromPayload({ session_id: 'abc' })).toBeNull();
  });

  it('returns null when usage is not an object', () => {
    expect(extractUsageFromPayload({ usage: 'not an object' })).toBeNull();
    expect(extractUsageFromPayload({ usage: 123 })).toBeNull();
    expect(extractUsageFromPayload({ usage: null })).toBeNull();
  });

  it('returns null when required fields are missing or wrong type', () => {
    expect(extractUsageFromPayload({ usage: { inputTokens: 100 } })).toBeNull();
    expect(extractUsageFromPayload({ usage: { inputTokens: '100', outputTokens: 50, totalTokens: 150 } })).toBeNull();
  });

  it('rejects negative / NaN / infinity values defensively', () => {
    expect(extractUsageFromPayload({
      usage: { inputTokens: -1, outputTokens: 50, totalTokens: 150 },
    })).toBeNull();
    expect(extractUsageFromPayload({
      usage: { inputTokens: NaN, outputTokens: 50, totalTokens: 150 },
    })).toBeNull();
    expect(extractUsageFromPayload({
      usage: { inputTokens: 100, outputTokens: Infinity, totalTokens: 150 },
    })).toBeNull();
  });

  it('accepts zero token counts (e.g., session_start with empty conversation)', () => {
    const got = extractUsageFromPayload({
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    });
    expect(got).toEqual({ inputTokens: 0, outputTokens: 0, totalTokens: 0 });
  });
});
