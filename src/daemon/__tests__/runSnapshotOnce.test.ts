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
import { waitForCondition } from './_waitForFile';

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
    // lastActivity is dynamic so SUSPENDED_TTL_HOURS (7 days in StateWriter.load)
    // never expires this fixture. The original hardcoded '2026-05-15' silently
    // expired exactly 7 days later and broke this test on every CI run after
    // 2026-05-22T00:00Z, regardless of any code change.
    const recentIso = new Date(Date.now() - 60 * 60 * 1000).toISOString();
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
            createdAt: recentIso,
            lastActivity: recentIso,
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

  // Review consensus (Claude+Codex): a corrupt primary — or a read landing
  // inside atomicWriteJSON's rename window — must NOT be treated as "nothing
  // to preserve": the subsequent save would permanently drop cap-skipped
  // suspended sessions that exist only on disk. The runner walks the same
  // .bak rotation load() uses.
  it('preserves cap-skipped sessions from .bak when the primary is corrupt', async () => {
    const sessionsFile = path.join(tmpDir, 'sessions.json');
    const recentIso = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const suspended = {
      id: 'cap-skipped',
      state: 'suspended',
      cmd: 'bash',
      cwd: tmpDir,
      env: {},
      cols: 80,
      rows: 24,
      pid: 999,
      createdAt: recentIso,
      lastActivity: recentIso,
      deadTtlHours: 24,
    };
    // Valid backup slot, corrupt primary.
    fs.writeFileSync(
      `${sessionsFile}.bak`,
      JSON.stringify({ version: 1, sessions: [suspended], bootId: 'old-boot' }),
    );
    fs.writeFileSync(sessionsFile, '{{ definitely not json', 'utf8');

    manager.createSession({ id: 'live-one', cmd: 'bash', cwd: tmpDir, env: {}, cols: 80, rows: 24 });
    await runSnapshotOnce();

    const persisted = JSON.parse(fs.readFileSync(sessionsFile, 'utf-8')) as {
      sessions: { id: string }[];
    };
    const ids = persisted.sessions.map((s) => s.id).sort();
    expect(ids).toEqual(['cap-skipped', 'live-one'].sort());
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

    // New bytes arrive while the first dump is still in flight (P1-5: the
    // rerun only re-dumps DIRTY sessions — a rerun over an unchanged ring is
    // exactly the churn dirty-tracking removes; a session created or written
    // during the in-flight window is what the rerun exists to cover).
    session.ringBuffer.write(Buffer.from('mid-flight bytes'));

    // Release the first dump. The runner sees pendingRerun and re-loops,
    // which calls dumpToFile a second time on the next iteration. The
    // iteration now also awaits a real fsp.readFile + queued saveAsap
    // between dumps, so poll instead of a single setImmediate hop.
    resolveCurrent!();
    await waitForCondition(() => dumpSpy.mock.calls.length === 2);
    expect(dumpSpy).toHaveBeenCalledTimes(2);

    // Release the rerun's dump so `first` can resolve.
    resolveCurrent!();
    await first;
    expect(dumpSpy).toHaveBeenCalledTimes(2);

    // After the run fully completes, a fresh call works normally (dirty
    // again — P1-5 skips clean rings by design).
    session.ringBuffer.write(Buffer.from('post-run bytes'));
    const third = runSnapshotOnce();
    await waitForCondition(() => dumpSpy.mock.calls.length === 3);
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

// ── app-weight P1-5: dirty-only dumps ──────────────────────────────────────
describe('createSnapshotRunner — dirty-only dumps (P1-5)', () => {
  let tmpDir: string;
  let manager: DaemonSessionManager;
  let writer: StateWriter;
  let runSnapshotOnce: () => Promise<void>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-p15-test-'));
    manager = new DaemonSessionManager();
    writer = new StateWriter(tmpDir);
    runSnapshotOnce = createSnapshotRunner(manager, writer, {
      getBootId: () => 'p15-test-boot',
    });
  });

  afterEach(() => {
    manager.disposeAll();
    writer.dispose();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  function ring(id: string) {
    const m = manager.listManagedSessions().find((s) => s.meta.id === id);
    if (!m) throw new Error(`no managed session ${id}`);
    return m.ringBuffer;
  }

  it('skips a clean session on the next tick, dumps again after new bytes', async () => {
    manager.createSession({ id: 's1', cmd: 'bash', cwd: tmpDir, env: {}, cols: 80, rows: 24 });
    ring('s1').write(Buffer.from('hello'));
    const spy = vi.spyOn(ring('s1'), 'dumpToFile');

    await runSnapshotOnce(); // dirty (never dumped) → dumps
    expect(spy).toHaveBeenCalledTimes(1);
    await runSnapshotOnce(); // clean → skipped
    expect(spy).toHaveBeenCalledTimes(1);
    ring('s1').write(Buffer.from('more'));
    await runSnapshotOnce(); // dirty again → dumps
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('TOCTOU: bytes written DURING a dump keep the session dirty next tick', async () => {
    manager.createSession({ id: 's1', cmd: 'bash', cwd: tmpDir, env: {}, cols: 80, rows: 24 });
    const r = ring('s1');
    r.write(Buffer.from('initial'));
    const original = r.dumpToFile.bind(r);
    let injectOnce = true;
    const spy = vi.spyOn(r, 'dumpToFile').mockImplementation(async (p: string) => {
      const result = await original(p);
      if (injectOnce) {
        injectOnce = false;
        // Arrives while the dump's disk write is in flight (post-readAll).
        r.write(Buffer.from('mid-dump bytes'));
      }
      return result;
    });

    await runSnapshotOnce(); // dumps 'initial'; mid-dump bytes arrive after capture
    expect(spy).toHaveBeenCalledTimes(1);
    await runSnapshotOnce(); // counter was captured BEFORE the dump → still dirty
    expect(spy).toHaveBeenCalledTimes(2);
    await runSnapshotOnce(); // now clean
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('a failed dump records nothing — the session retries next tick', async () => {
    manager.createSession({ id: 's1', cmd: 'bash', cwd: tmpDir, env: {}, cols: 80, rows: 24 });
    const r = ring('s1');
    r.write(Buffer.from('data'));
    const original = r.dumpToFile.bind(r);
    const spy = vi.spyOn(r, 'dumpToFile')
      .mockRejectedValueOnce(new Error('EIO: simulated disk failure'));

    await runSnapshotOnce(); // fails — nothing recorded
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockImplementation(original);
    await runSnapshotOnce(); // still dirty → retries and succeeds
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('forces a dump every Nth tick even when clean (freshness backstop)', async () => {
    manager.createSession({ id: 's1', cmd: 'bash', cwd: tmpDir, env: {}, cols: 80, rows: 24 });
    ring('s1').write(Buffer.from('x'));
    const spy = vi.spyOn(ring('s1'), 'dumpToFile');

    await runSnapshotOnce(); // dump #1 (dirty)
    for (let i = 0; i < 9; i++) await runSnapshotOnce(); // 9 clean ticks — skipped
    expect(spy).toHaveBeenCalledTimes(1);
    await runSnapshotOnce(); // 10th clean tick → forced
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('sessions.json is saved even when every dump was skipped (metadata freshness)', async () => {
    manager.createSession({ id: 's1', cmd: 'bash', cwd: tmpDir, env: {}, cols: 80, rows: 24 });
    ring('s1').write(Buffer.from('x'));
    // 30-session scaling: the runner persists via saveAsap (awaited async
    // write) instead of the old sync saveImmediate — same unconditional
    // per-tick cadence, off the event loop.
    const saveSpy = vi.spyOn(writer, 'saveAsap');
    await runSnapshotOnce();
    await runSnapshotOnce(); // all-clean tick
    expect(saveSpy).toHaveBeenCalledTimes(2); // unconditional both times
  });

  it('session-id REUSE with a fresh ring dumps immediately — even on a byte-count collision', async () => {
    // 'old life' and 'new life' are deliberately the SAME length: an id-keyed
    // counter map would read the fresh ring as "clean" and skip its first
    // dump. Ring-identity (WeakMap) keying makes the collision impossible.
    manager.createSession({ id: 's1', cmd: 'bash', cwd: tmpDir, env: {}, cols: 80, rows: 24 });
    ring('s1').write(Buffer.from('old life'));
    await runSnapshotOnce();
    manager.destroySession('s1');

    manager.createSession({ id: 's1', cmd: 'bash', cwd: tmpDir, env: {}, cols: 80, rows: 24 });
    const spy = vi.spyOn(ring('s1'), 'dumpToFile');
    ring('s1').write(Buffer.from('new life'));
    await runSnapshotOnce();
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
