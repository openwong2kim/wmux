// Unit tests for the commander session persistence store (P3a). Runs against a
// throwaway temp dir — the real wmux data dir is never touched.

import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  getCommanderSessionPath,
  loadCommanderSession,
  saveCommanderSession,
} from '../commanderSessionStore';

function withTempDir(fn: (dir: string) => Promise<void> | void): Promise<void> | void {
  const dir = mkdtempSync(join(tmpdir(), 'wmux-deck-store-'));
  const result = fn(dir);
  const cleanup = (): void => rmSync(dir, { recursive: true, force: true });
  if (result instanceof Promise) return result.finally(cleanup);
  cleanup();
  return result;
}

describe('commanderSessionStore', () => {
  it('round-trips a session id', () =>
    withTempDir(async (dir) => {
      expect(loadCommanderSession(dir)).toBeNull();
      await saveCommanderSession('sess-abc', dir);
      const loaded = loadCommanderSession(dir);
      expect(loaded?.sessionId).toBe('sess-abc');
      expect(loaded?.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    }));

  it('overwrites with the newest id', () =>
    withTempDir(async (dir) => {
      await saveCommanderSession('sess-1', dir);
      await saveCommanderSession('sess-2', dir);
      expect(loadCommanderSession(dir)?.sessionId).toBe('sess-2');
    }));

  it('returns null for a corrupt or shape-mismatched file', () =>
    withTempDir((dir) => {
      const p = getCommanderSessionPath(dir);
      writeFileSync(p, '{not json');
      expect(loadCommanderSession(dir)).toBeNull();
      writeFileSync(p, JSON.stringify({ sessionId: 42 }));
      expect(loadCommanderSession(dir)).toBeNull();
      writeFileSync(p, JSON.stringify({ sessionId: '   ' }));
      expect(loadCommanderSession(dir)).toBeNull();
    }));

  it('missing file → null (fresh install)', () => {
    expect(loadCommanderSession(join(tmpdir(), 'wmux-deck-store-nonexistent'))).toBeNull();
  });
});
