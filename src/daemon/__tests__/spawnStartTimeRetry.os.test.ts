import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';

// #2388: the spawn read the shell's start time once; when that read failed
// (`ps` timed out) nothing read it again, and every later tree kill of the
// pane was refused for good. The spawn now retries the read a few times,
// while the shell has not exited.
const spawned: FakePty[] = [];
class FakePty extends EventEmitter {
  pid = 0;
  readonly _socket = new EventEmitter();
  readonly kill = vi.fn();
  onData() { return { dispose: () => { /* noop */ } }; }
  onExit(listener: (e: { exitCode: number }) => void) {
    this.on('exit', listener);
    return { dispose: () => { this.off('exit', listener); } };
  }
  write(): void { /* noop */ }
  resize(): void { /* noop */ }
  connect(pid: number): void { this.pid = pid; this._socket.emit('ready_datapipe'); }
}

vi.mock('../../shared/terminalPty', async (importOriginal) => (await import('../../test-utils/ptyTransportStub')).routeSpawnToNodePtyMock(importOriginal));
vi.mock('node-pty', () => {
  const spawn = () => { const p = new FakePty(); spawned.push(p); return p; };
  return { default: { spawn }, spawn };
});

/** What the next start-time reads answer (null: the read failed). */
const startReads: Array<string | null> = [];
const readPids: number[] = [];
vi.mock('../phantomExit', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../phantomExit')>()),
  // The spawn's native read (Windows) found nothing either.
  getProcessCreatedAtFt: () => null,
  getProcessStartTime: async (pid: number) => {
    readPids.push(pid);
    return startReads.length > 0 ? startReads.shift() ?? null : null;
  },
}));

import { DaemonSessionManager } from '../DaemonSessionManager';
import { UNKNOWN_ROOT_REFUSAL, recordedStartOf, treeKillRefusal } from '../automation/verifiedTreeKill';

const flush = () => new Promise<void>((r) => setImmediate(r));
const settle = async () => { for (let i = 0; i < 20; i++) { await new Promise((r) => setTimeout(r, 5)); } };
// The form a read takes on this platform (Windows: a FILETIME).
const START = process.platform === 'win32' ? '134296036801234567' : 'Mon Oct 19 10:00:00 2026';

describe('spawn-time start-time read retry (#2388)', () => {
  let manager: DaemonSessionManager;

  const create = async () => {
    const pending = manager.createSessionAsync({ id: 's', cmd: process.execPath, cwd: process.cwd() });
    await flush();
    spawned[0].connect(4242);
    await pending;
    return manager.getSession('s')!.meta;
  };

  beforeEach(() => {
    spawned.length = 0;
    startReads.length = 0;
    readPids.length = 0;
    manager = new DaemonSessionManager();
    manager.spawnStartRetryDelaysMs = [1, 1, 1];
  });

  afterEach(() => manager.disposeAll());

  it('a read that fails once and then succeeds records the identity, and the tree kill is allowed', async () => {
    startReads.push(null, START);
    const meta = await create();
    await settle();
    expect(readPids).toEqual([4242, 4242]);
    expect(recordedStartOf(meta)).toBe(START);
    expect(treeKillRefusal(meta)).toBeNull();
  });

  it('reads that fail for the whole window leave the identity unknown, and the tree kill is refused', async () => {
    const meta = await create();
    await settle();
    expect(readPids).toEqual([4242, 4242, 4242, 4242]);
    expect(recordedStartOf(meta)).toBeUndefined();
    expect(treeKillRefusal(meta)).toBe(UNKNOWN_ROOT_REFUSAL);
    expect(UNKNOWN_ROOT_REFUSAL).toMatch(/folder is kept/);
    expect(UNKNOWN_ROOT_REFUSAL).toMatch(/Close and keep folder/);
  });

  it('stops reading once the shell exited, and records nothing read after', async () => {
    startReads.push(null, START);
    const meta = await create();
    spawned[0].emit('exit', { exitCode: 0 });
    await settle();
    expect(readPids).toEqual([4242]);
    expect(recordedStartOf(meta)).toBeUndefined();
  });
});
