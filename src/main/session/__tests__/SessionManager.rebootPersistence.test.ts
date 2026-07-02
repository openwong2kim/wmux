/**
 * v2 RCA fix (reboot-reattach, axis A) — SessionManager persistence contract.
 *
 * 1. load() distinguishes "no file" (first launch → null) from "file exists
 *    but unreadable" (transient AV/indexer lock → THROW). The old
 *    collapse-to-null made the renderer treat a locked session.json as a first
 *    launch and overwrite it with the default empty workspace (adversarial
 *    review P2 — data loss).
 * 2. save()/load() log a ptyId summary (axis A ③ observability): the
 *    fossil-vs-fresh question after a reboot must be answerable from the log.
 *
 * Electron `app.getPath('userData')` is mocked to a per-test tmpdir (same
 * pattern as SessionManager.metadata.test.ts).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const tmpRoot = path.join(os.tmpdir(), 'wmux-sessionmgr-reboot-test');

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => tmpRoot),
  },
}));

import { SessionManager } from '../SessionManager';
import type { SessionData } from '../../../shared/types';

function freshDir(): void {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  fs.mkdirSync(tmpRoot, { recursive: true });
}

/** Nested-branch SessionData with N ptyId-bearing surfaces (+ one ptyId-less). */
function makeSession(ptyIds: string[]): SessionData {
  const leaves = ptyIds.map((id, i) => ({
    id: `pane-${i}`,
    type: 'leaf' as const,
    surfaces: [
      { id: `surf-${i}`, ptyId: id, title: 't', shell: 'pwsh', cwd: 'D:/x' },
      ...(i === 0 ? [{ id: 'surf-empty', ptyId: '', title: 'e', shell: 'pwsh', cwd: 'D:/x' }] : []),
    ],
    activeSurfaceId: `surf-${i}`,
  }));
  const rootPane = leaves.length === 1
    ? leaves[0]
    : { id: 'branch-0', type: 'branch' as const, direction: 'horizontal' as const, children: leaves };
  return {
    workspaces: [{ id: 'ws-1', name: 'W1', rootPane, activePaneId: leaves[0].id } as SessionData['workspaces'][number]],
    activeWorkspaceId: 'ws-1',
    sidebarVisible: true,
  };
}

describe('SessionManager — reboot persistence contract', () => {
  beforeEach(freshDir);
  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('load() returns null when session.json does not exist (true first launch)', () => {
    const sm = new SessionManager();
    expect(sm.load()).toBeNull();
  });

  it('load() THROWS when session.json exists but is unreadable — never silently null', () => {
    const sm = new SessionManager();
    sm.save(makeSession(['pty-real']));
    // Simulate a transient read failure (AV/indexer lock at boot).
    const readSpy = vi.spyOn(fs, 'readFileSync').mockImplementation(() => {
      throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' });
    });
    try {
      expect(() => sm.load()).toThrow();
    } finally {
      readSpy.mockRestore();
    }
    // The on-disk layout survives untouched for the next boot.
    expect(fs.existsSync(path.join(tmpRoot, 'session.json'))).toBe(true);
  });

  it('save() → load() round-trips and logs the ptyId summary on both sides', () => {
    const logSpy = vi.spyOn(console, 'log');
    const sm = new SessionManager();
    sm.save(makeSession(['pty-aaaa-1111', 'pty-bbbb-2222']));

    const saveLine = logSpy.mock.calls.map((c) => String(c[0])).find((m) => m.includes('[SessionManager] save:'));
    expect(saveLine).toContain('2 pty');
    expect(saveLine).toContain('pty-aaaa-1111');
    expect(saveLine).toContain('pty-bbbb-2222');

    const loaded = sm.load();
    expect(loaded).not.toBeNull();
    const loadLine = logSpy.mock.calls.map((c) => String(c[0])).find((m) => m.includes('[SessionManager] load'));
    expect(loadLine).toContain('2 pty');
  });

  it('ptyId summary truncates beyond 6 ids but reports the full count', () => {
    const logSpy = vi.spyOn(console, 'log');
    const sm = new SessionManager();
    sm.save(makeSession(['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7', 'p8']));
    const saveLine = logSpy.mock.calls.map((c) => String(c[0])).find((m) => m.includes('[SessionManager] save:'));
    expect(saveLine).toContain('8 pty');
    expect(saveLine).toContain('…');
    expect(saveLine).not.toContain('p7');
  });
});
