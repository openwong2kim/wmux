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
    expect(fs.existsSync(path.join(tmpDir, 'sessions.json'))).toBe(false);
  });

  it('dumps a .buf for every live session and persists sessions.json', async () => {
    manager.createSession({ id: 's1', cmd: 'bash', cwd: tmpDir, env: {}, cols: 80, rows: 24 });
    manager.createSession({ id: 's2', cmd: 'bash', cwd: tmpDir, env: {}, cols: 80, rows: 24 });

    await runSnapshotOnce();

    expect(fs.existsSync(path.join(tmpDir, 'sessions.json'))).toBe(true);
    expect(fs.existsSync(writer.getBufferDumpPath('s1'))).toBe(true);
    expect(fs.existsSync(writer.getBufferDumpPath('s2'))).toBe(true);
  });

  it('continues after a per-session dumpToFile failure (isolated error handling)', async () => {
    manager.createSession({ id: 'fail-one', cmd: 'bash', cwd: tmpDir, env: {}, cols: 80, rows: 24 });
    manager.createSession({ id: 'ok-two', cmd: 'bash', cwd: tmpDir, env: {}, cols: 80, rows: 24 });

    const failOne = manager.getSession('fail-one')!;
    vi.spyOn(failOne.ringBuffer, 'dumpToFile').mockRejectedValueOnce(new Error('disk full'));

    await runSnapshotOnce();

    // sessions.json still written even though one dump failed.
    expect(fs.existsSync(path.join(tmpDir, 'sessions.json'))).toBe(true);
    // ok-two's dump still produced.
    expect(fs.existsSync(writer.getBufferDumpPath('ok-two'))).toBe(true);
  });

  // In-flight guard: a concurrent re-entry while the previous run is still
  // awaiting a dumpToFile call must skip without performing additional work.
  // This locks the behavior the inline 30s setInterval relied on (its
  // `if (snapshotRunning) return` guard) so the setInterval body can safely
  // fan out to runSnapshotOnce.
  it('in-flight guard prevents concurrent execution', async () => {
    manager.createSession({ id: 's1', cmd: 'bash', cwd: tmpDir, env: {}, cols: 80, rows: 24 });
    const session = manager.getSession('s1')!;

    // dumpToFile hangs until we release it via resolveCurrent. The mock
    // re-installs resolveCurrent on every invocation so we control each call
    // independently.
    let resolveCurrent: (() => void) | null = null;
    const dumpSpy = vi.spyOn(session.ringBuffer, 'dumpToFile').mockImplementation(
      () => new Promise<void>((resolve) => { resolveCurrent = () => resolve(); }),
    );

    // First call enters and parks on the hanging dumpToFile.
    const first = runSnapshotOnce();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(dumpSpy).toHaveBeenCalledTimes(1);

    // Second concurrent call must short-circuit on the running flag.
    await runSnapshotOnce();
    expect(dumpSpy).toHaveBeenCalledTimes(1);

    // Release the first call and wait for it to fully clean up.
    resolveCurrent!();
    await first;
    expect(dumpSpy).toHaveBeenCalledTimes(1);

    // After release a fresh call works normally. Start it, let it park on
    // dumpToFile, then release so the test doesn't hang.
    const third = runSnapshotOnce();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(dumpSpy).toHaveBeenCalledTimes(2);
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
