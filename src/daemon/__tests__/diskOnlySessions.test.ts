// #2493 — records recovery leaves on disk (a session the recovery cap
// excluded) survive every save, not only the boot and snapshot ones.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { retireAdopted, withDiskOnlySessions } from '../diskOnlySessions';
import type { DaemonSession } from '../types';

const session = (id: string, state: DaemonSession['state'] = 'attached'): DaemonSession => ({ id, state } as DaemonSession);

describe('withDiskOnlySessions', () => {
  it('keeps every disk-only record after the managed sessions', () => {
    const merged = withDiskOnlySessions([session('a'), session('b')], [session('capped-1', 'suspended'), session('capped-2', 'suspended')]);
    expect(merged.map((s) => s.id)).toEqual(['a', 'b', 'capped-1', 'capped-2']);
  });

  it('a managed session wins over a disk-only record with its id', () => {
    const merged = withDiskOnlySessions([session('a')], [session('a', 'suspended'), session('c', 'suspended')]);
    expect(merged).toEqual([session('a'), session('c', 'suspended')]);
  });

  it('a record the manager adopted is retired, so closing that pane later does not bring it back', () => {
    let diskOnly = [session('capped', 'suspended'), session('other', 'suspended')];
    diskOnly = retireAdopted([session('capped')], diskOnly);
    expect(diskOnly.map((s) => s.id)).toEqual(['other']);
    // The pane closes: the manager no longer lists it, and nothing restores it.
    expect(withDiskOnlySessions([], diskOnly).map((s) => s.id)).toEqual(['other']);
  });

  it('returns the managed list as it is when nothing is disk-only', () => {
    const managed = [session('a')];
    expect(withDiskOnlySessions(managed, [])).toBe(managed);
  });
});

// buildState and recoverSessions live in index.ts closures that need main();
// their contract is locked at the source, as resumeContinueTurn.test.ts does.
describe('disk-only wiring', () => {
  // A Windows checkout has CRLF line endings; the anchors below are written with \n.
  const src = fs.readFileSync(path.join(__dirname, '..', 'index.ts'), 'utf-8').replace(/\r\n/g, '\n');

  it('every save writes the disk-only records back, shutdown saves included', () => {
    const at = src.indexOf('function buildState(sessionManager: DaemonSessionManager): DaemonState {');
    expect(src.slice(at, at + 600)).toMatch(/sessions: sessionsToSave\(sessionManager\)/);
    // Graceful shutdown and the synchronous exit handler build their state directly.
    expect(src.match(/const suspendState: DaemonState = \{\s*version: 1,\s*sessions: sessionsToSave\(sessionManager\),/g)).toHaveLength(2);
    expect(src).not.toMatch(/sessions: sessionManager\.listSessions\(\),/);
  });

  it('closing a pane recovery left on disk only retires its record (no session:destroyed fires for it)', () => {
    const at = src.indexOf('const destroySessionNow = async (p: DaemonDestroySessionParams): Promise<unknown> => {');
    expect(at).toBeGreaterThan(-1);
    expect(src.slice(at, at + 1800)).toMatch(/diskOnlySessions = diskOnlySessions\.filter\(\(s\) => s\.id !== p\.id\);/);
  });

  it('a destroyed session\'s disk-only record is retired', () => {
    const at = src.indexOf("sessionManager.on('session:destroyed', (payload: { id: string }) => {\n    recoveredAgentShellIds.delete(payload.id);");
    expect(at).toBeGreaterThan(-1);
    expect(src.slice(at, at + 700)).toMatch(/diskOnlySessions = diskOnlySessions\.filter\(\(s\) => s\.id !== payload\.id\);/);
  });

  it('recovery records what it left on disk whether or not anything changed', () => {
    const rec = src.slice(src.indexOf('async function recoverSessions('));
    const at = rec.indexOf('diskOnlySessions = state.sessions.filter(');
    expect(at).toBeGreaterThan(-1);
    // Outside the `if (changed)` that only gates the boot save.
    expect(rec.slice(at, at + 200)).toMatch(/diskOnlySessions = state\.sessions\.filter\(\(s\) => !managedIds\.has\(s\.id\)\);\s*if \(changed\) \{/);
  });
});
