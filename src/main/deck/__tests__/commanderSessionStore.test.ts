// Unit tests for the commander session persistence store (P3a, per-workspace
// M1.5). Runs against a throwaway temp dir — the real wmux data dir is never
// touched.

import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  getCommanderSessionPath,
  loadCommanderSession,
  saveCommanderSession,
  clearCommanderSession,
} from '../commanderSessionStore';

function withTempDir(fn: (dir: string) => Promise<void> | void): Promise<void> | void {
  const dir = mkdtempSync(join(tmpdir(), 'wmux-deck-store-'));
  const result = fn(dir);
  const cleanup = (): void => rmSync(dir, { recursive: true, force: true });
  if (result instanceof Promise) return result.finally(cleanup);
  cleanup();
  return result;
}

describe('commanderSessionStore (per-workspace)', () => {
  it('round-trips a session id per workspace', () =>
    withTempDir(async (dir) => {
      expect(loadCommanderSession('ws-1', dir)).toBeNull();
      await saveCommanderSession('ws-1', 'sess-abc', dir);
      const loaded = loadCommanderSession('ws-1', dir);
      expect(loaded?.sessionId).toBe('sess-abc');
      expect(loaded?.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      // Another workspace has no entry.
      expect(loadCommanderSession('ws-2', dir)).toBeNull();
    }));

  it('clearCommanderSession drops only that workspace; clearing twice / missing file is a no-op', () =>
    withTempDir(async (dir) => {
      await saveCommanderSession('ws-1', 'sess-1', dir);
      await saveCommanderSession('ws-2', 'sess-2', dir);
      await clearCommanderSession('ws-1', dir);
      expect(loadCommanderSession('ws-1', dir)).toBeNull();
      expect(loadCommanderSession('ws-2', dir)?.sessionId).toBe('sess-2');
      // Idempotent — and a clear against a dir with no file must not create one.
      await clearCommanderSession('ws-1', dir);
      await clearCommanderSession('ws-absent', dir);
      expect(loadCommanderSession('ws-2', dir)?.sessionId).toBe('sess-2');
    }));

  it('workspaces persist independently — saving one never clobbers another', () =>
    withTempDir(async (dir) => {
      await saveCommanderSession('ws-1', 'sess-1', dir);
      await saveCommanderSession('ws-2', 'sess-2', dir);
      await saveCommanderSession('ws-1', 'sess-1b', dir);
      expect(loadCommanderSession('ws-1', dir)?.sessionId).toBe('sess-1b');
      expect(loadCommanderSession('ws-2', dir)?.sessionId).toBe('sess-2');
    }));

  it('discards the legacy fleet-wide schema (pre-M1.5 top-level sessionId)', () =>
    withTempDir((dir) => {
      writeFileSync(
        getCommanderSessionPath(dir),
        JSON.stringify({ sessionId: 'legacy-fleet-session', updatedAt: '2026-01-01T00:00:00Z' }),
      );
      expect(loadCommanderSession('ws-1', dir)).toBeNull();
    }));

  it('returns null for a corrupt or shape-mismatched file / entry', () =>
    withTempDir((dir) => {
      const p = getCommanderSessionPath(dir);
      writeFileSync(p, '{not json');
      expect(loadCommanderSession('ws-1', dir)).toBeNull();
      writeFileSync(p, JSON.stringify({ sessions: { 'ws-1': { sessionId: 42 } } }));
      expect(loadCommanderSession('ws-1', dir)).toBeNull();
      writeFileSync(p, JSON.stringify({ sessions: { 'ws-1': { sessionId: '   ' } } }));
      expect(loadCommanderSession('ws-1', dir)).toBeNull();
      writeFileSync(p, JSON.stringify({ sessions: [] }));
      expect(loadCommanderSession('ws-1', dir)).toBeNull();
    }));

  it('a corrupt sibling entry does not take the healthy ones down', () =>
    withTempDir(async (dir) => {
      writeFileSync(
        getCommanderSessionPath(dir),
        JSON.stringify({
          sessions: {
            'ws-bad': { sessionId: 42 },
            'ws-good': { sessionId: 'sess-good', updatedAt: '2026-01-01T00:00:00Z' },
          },
        }),
      );
      expect(loadCommanderSession('ws-bad', dir)).toBeNull();
      expect(loadCommanderSession('ws-good', dir)?.sessionId).toBe('sess-good');
      // A save keeps the healthy entry.
      await saveCommanderSession('ws-new', 'sess-new', dir);
      expect(loadCommanderSession('ws-good', dir)?.sessionId).toBe('sess-good');
      expect(loadCommanderSession('ws-new', dir)?.sessionId).toBe('sess-new');
    }));

  it('an empty workspaceId neither loads nor saves', () =>
    withTempDir(async (dir) => {
      await saveCommanderSession('', 'sess-x', dir);
      expect(loadCommanderSession('', dir)).toBeNull();
      expect(loadCommanderSession('ws-1', dir)).toBeNull();
    }));

  it('missing file → null (fresh install)', () => {
    expect(loadCommanderSession('ws-1', join(tmpdir(), 'wmux-deck-store-nonexistent'))).toBeNull();
  });
});
