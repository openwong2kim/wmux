import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// Mock node-pty so createSession does not spawn real processes.
// Mirrors the pattern in DaemonSessionManager.test.ts.
class MockPty extends EventEmitter {
  pid = 12345;
  onData() { return { dispose: () => { /* noop */ } }; }
  onExit() { return { dispose: () => { /* noop */ } }; }
  write(_data: string): void { /* noop */ }
  resize(_cols: number, _rows: number): void { /* noop */ }
  kill(): void { /* noop */ }
}

vi.mock('node-pty', () => ({
  default: { spawn: () => new MockPty() },
  spawn: () => new MockPty(),
}));

// Import after mock so DaemonSessionManager wires the mock.
import { DaemonSessionManager } from '../DaemonSessionManager';
import { StateWriter } from '../StateWriter';
import { createSnapshotRunner } from '../snapshotRunner';

describe('createSnapshotRunner (A1b — extracted from periodic interval body)', () => {
  let tmpDir: string;
  let manager: DaemonSessionManager;
  let writer: StateWriter;
  let runSnapshotOnce: () => Promise<void>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-a1b-test-'));
    manager = new DaemonSessionManager();
    writer = new StateWriter(tmpDir);
    runSnapshotOnce = createSnapshotRunner(manager, writer, {
      getBootId: () => 'a1b-test-boot',
    });
  });

  afterEach(() => {
    manager.disposeAll();
    writer.dispose();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('no-ops when there are no live sessions', async () => {
    await runSnapshotOnce();
    // Buffer dir may exist (ensureBufferDir was skipped on empty); no dumps.
    expect(fs.readdirSync(tmpDir).filter((n) => n.endsWith('.buf'))).toHaveLength(0);
  });

  it('dumps a .buf for every live session', async () => {
    manager.createSession({ id: 's1', cmd: 'bash', cwd: tmpDir, env: {}, cols: 80, rows: 24 });
    manager.createSession({ id: 's2', cmd: 'bash', cwd: tmpDir, env: {}, cols: 80, rows: 24 });

    await runSnapshotOnce();

    expect(fs.existsSync(writer.getBufferDumpPath('s1'))).toBe(true);
    expect(fs.existsSync(writer.getBufferDumpPath('s2'))).toBe(true);
  });

  // sessions.json must include both managed sessions (with their current
  // in-memory metadata: lastActivity, cwd, geometry) AND any non-managed
  // entries already in the file (cap-skipped suspended sessions from
  // recovery, which live only in the file because MAX_RECOVER_SESSIONS
  // bounded what got loaded into sessionManager). Codex review P2,
  // session 019e2af8.
  it('merges cap-skipped sessions from existing sessions.json into the save', async () => {
    const sessionsFile = path.join(tmpDir, 'sessions.json');
    fs.writeFileSync(
      sessionsFile,
      JSON.stringify({
        version: 1,
        sessions: [
          {
            id: 'cap-skipped',
            state: 'suspended',
            cmd: 'bash',
            cwd: tmpDir,
            env: {},
            cols: 80,
            rows: 24,
            pid: 999,
            createdAt: '2026-05-15T00:00:00Z',
            lastActivity: '2026-05-15T00:00:00Z',
            deadTtlHours: 24,
          },
        ],
        bootId: 'old-boot',
      }),
    );

    manager.createSession({ id: 'live-one', cmd: 'bash', cwd: tmpDir, env: {}, cols: 80, rows: 24 });

    await runSnapshotOnce();

    const persisted = JSON.parse(fs.readFileSync(sessionsFile, 'utf-8')) as {
      sessions: { id: string }[];
      bootId?: string;
    };
    // Both entries present.
    const ids = persisted.sessions.map((s) => s.id).sort();
    expect(ids).toEqual(['cap-skipped', 'live-one'].sort());
    // bootId refreshed to runner's value.
    expect(persisted.bootId).toBe('a1b-test-boot');
    // Live session's .buf produced.
    expect(fs.existsSync(writer.getBufferDumpPath('live-one'))).toBe(true);
  });

  // Authoritative-managed rule: if a session id exists in both the existing
  // file and sessionManager, sessionManager wins (carries the latest
  // lastActivity / cwd / geometry that may not yet have been saved by any
  // RPC handler).
  it('takes sessionManager state as authoritative for managed session ids', async () => {
    const sessionsFile = path.join(tmpDir, 'sessions.json');
    fs.writeFileSync(
      sessionsFile,
      JSON.stringify({
        version: 1,
        sessions: [
          {
            id: 'live-one',
            state: 'detached',
            cmd: 'OLD-CMD',
            cwd: '/old/cwd',
            env: {},
            cols: 9999,
            rows: 9999,
            pid: 1,
            createdAt: '2026-01-01T00:00:00Z',
            lastActivity: '2026-01-01T00:00:00Z',
            deadTtlHours: 24,
          },
        ],
        bootId: 'old-boot',
      }),
    );

    manager.createSession({ id: 'live-one', cmd: 'bash', cwd: tmpDir, env: {}, cols: 80, rows: 24 });

    await runSnapshotOnce();

    const persisted = JSON.parse(fs.readFileSync(sessionsFile, 'utf-8')) as {
      sessions: { id: string; cmd: string; cwd: string; cols: number; rows: number }[];
    };
    expect(persisted.sessions).toHaveLength(1);
    // DaemonSessionManager resolves bare shell names to absolute paths on
    // POSIX (`bash` → `/bin/bash` on macOS / Linux) but not on Windows.
    // The invariant under test is "managed overrides the stale OLD-CMD",
    // not "cmd equals the string we passed". Match on bash suffix and
    // assert the stale value is gone.
    expect(persisted.sessions[0].cmd).toMatch(/bash$/);
    expect(persisted.sessions[0].cmd).not.toBe('OLD-CMD');
    expect(persisted.sessions[0].cwd).toBe(tmpDir);
    expect(persisted.sessions[0].cols).toBe(80);
    expect(persisted.sessions[0].rows).toBe(24);
  });

  it('continues after a per-session dumpToFile failure (isolated error handling)', async () => {
    manager.createSession({ id: 'fail-one', cmd: 'bash', cwd: tmpDir, env: {}, cols: 80, rows: 24 });
    manager.createSession({ id: 'ok-two', cmd: 'bash', cwd: tmpDir, env: {}, cols: 80, rows: 24 });

    const failOne = manager.getSession('fail-one')!;
    vi.spyOn(failOne.ringBuffer, 'dumpToFile').mockRejectedValueOnce(new Error('disk full'));

    await runSnapshotOnce();

    // ok-two's dump still produced.
    expect(fs.existsSync(writer.getBufferDumpPath('ok-two'))).toBe(true);
  });

  // Pending-rerun pattern: a concurrent trigger arriving while the previous
  // run is mid-dump must NOT be dropped — otherwise a session created during
  // the in-flight window would miss its .buf until the next 30 s interval.
  // The runner marks pendingRerun and re-loops after the current iteration
  // completes. Codex review P2, session 019e2af8.
  it('in-flight guard queues a rerun for concurrent triggers', async () => {
    manager.createSession({ id: 's1', cmd: 'bash', cwd: tmpDir, env: {}, cols: 80, rows: 24 });
    const session = manager.getSession('s1')!;

    let resolveCurrent: (() => void) | null = null;
    const dumpSpy = vi.spyOn(session.ringBuffer, 'dumpToFile').mockImplementation(
      () => new Promise<void>((resolve) => { resolveCurrent = () => resolve(); }),
    );

    // First call enters and parks on the hanging dumpToFile.
    const first = runSnapshotOnce();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(dumpSpy).toHaveBeenCalledTimes(1);

    // Concurrent trigger marks pendingRerun and returns without dumping.
    await runSnapshotOnce();
    expect(dumpSpy).toHaveBeenCalledTimes(1);

    // Release the first dump. The runner sees pendingRerun and re-loops,
    // which calls dumpToFile a second time on the next iteration.
    resolveCurrent!();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(dumpSpy).toHaveBeenCalledTimes(2);

    // Release the rerun's dump so `first` can resolve.
    resolveCurrent!();
    await first;
    expect(dumpSpy).toHaveBeenCalledTimes(2);

    // After the run fully completes, a fresh call works normally.
    const third = runSnapshotOnce();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(dumpSpy).toHaveBeenCalledTimes(3);
    resolveCurrent!();
    await third;
  });

  it('treats dead sessions as not-live (skips dump for them)', async () => {
    manager.createSession({ id: 'alive', cmd: 'bash', cwd: tmpDir, env: {}, cols: 80, rows: 24 });
    manager.createSession({ id: 'dead', cmd: 'bash', cwd: tmpDir, env: {}, cols: 80, rows: 24 });
    const deadSession = manager.getSession('dead')!;
    deadSession.meta.state = 'dead';

    const aliveDumpSpy = vi.spyOn(manager.getSession('alive')!.ringBuffer, 'dumpToFile');
    const deadDumpSpy = vi.spyOn(deadSession.ringBuffer, 'dumpToFile');

    await runSnapshotOnce();

    expect(aliveDumpSpy).toHaveBeenCalledTimes(1);
    expect(deadDumpSpy).not.toHaveBeenCalled();
  });
});
