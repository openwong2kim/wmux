import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { EventEmitter } from 'node:events';

// Local PTY mode writes the same pid-map anchors as daemon mode, through the
// shared helpers, so a pane keeps one PID and dispose clears it by content.
const { spawn } = vi.hoisted(() => ({
  spawn: vi.fn(() => ({ pid: 4321, kill: vi.fn(), onData: vi.fn(), onExit: vi.fn(), write: vi.fn(), resize: vi.fn() })),
}));
vi.mock('node-pty', () => ({ spawn, default: { spawn } }));
import { PTYManager } from '../PTYManager';
import { getPidMapDir } from '../../../shared/constants';

describe('PTYManager pid-map anchors', () => {
  let tmp: string;
  let savedUserProfile: string | undefined;
  let savedHome: string | undefined;
  let mapDir: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-ptymgr-pidmap-'));
    savedUserProfile = process.env.USERPROFILE;
    savedHome = process.env.HOME;
    process.env.USERPROFILE = tmp;
    process.env.HOME = tmp;
    mapDir = getPidMapDir();
    spawn.mockClear();
  });

  afterEach(() => {
    if (savedUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = savedUserProfile;
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const read = (pid: string | number) => {
    try { return fs.readFileSync(path.join(mapDir, String(pid)), 'utf8'); } catch { return null; }
  };

  it('writes the shell PID through the shared writer, dropping an earlier PID of the same pane', () => {
    const manager = new PTYManager();
    try {
      fs.mkdirSync(mapDir, { recursive: true });
      // An earlier anchor for the id this manager mints first.
      fs.writeFileSync(path.join(mapDir, '1111'), 'pty-1', 'utf8');
      fs.writeFileSync(path.join(mapDir, '2222'), 'daemon-other', 'utf8');

      const instance = manager.create({});
      expect(instance.id).toBe('pty-1');
      expect(read(4321)).toBe('pty-1');
      expect(read(1111)).toBeNull();
      expect(read(2222)).toBe('daemon-other');
    } finally { manager.disposeAll(); }
  });

  it('dispose removes the pane\'s anchors by content, leaving a file another pane owns', () => {
    const manager = new PTYManager();
    try {
      const instance = manager.create({});
      expect(read(4321)).toBe(instance.id);
      fs.writeFileSync(path.join(mapDir, '2222'), 'daemon-other', 'utf8');

      manager.dispose(instance.id);

      expect(read(4321)).toBeNull();
      expect(read(2222)).toBe('daemon-other');
    } finally { manager.disposeAll(); }
  });

  it('dispose does not remove a file whose PID now names another pane', () => {
    const manager = new PTYManager();
    try {
      const instance = manager.create({});
      // The PID file was re-pointed to a different pane (reused PID).
      fs.writeFileSync(path.join(mapDir, '4321'), 'daemon-other', 'utf8');

      manager.dispose(instance.id);

      expect(read(4321)).toBe('daemon-other');
    } finally { manager.disposeAll(); }
  });
  // #2398 — node-pty 1.2.0-beta on Windows: pid 0 until the output pipe
  // connects, and a CreateProcess failure is an exit while it is still 0.
  const deferredPty = () => {
    const exits = new EventEmitter();
    const p = {
      pid: 0,
      _socket: new EventEmitter(),
      kill: vi.fn(),
      onData: vi.fn(),
      onExit: (listener: (e: { exitCode: number }) => void) => {
        exits.on('exit', listener);
        return { dispose: () => { exits.off('exit', listener); } };
      },
      write: vi.fn(),
      resize: vi.fn(),
      fail: (exitCode: number) => exits.emit('exit', { exitCode }),
    };
    return p;
  };

  it('writes the anchor for the pid the deferred ConPTY reports, never for 0', async () => {
    const late = deferredPty();
    spawn.mockImplementationOnce(() => late as never);
    const manager = new PTYManager();
    try {
      const pending = manager.createAsync({});
      await new Promise<void>((r) => setImmediate(r));
      expect(read(0)).toBeNull();
      expect(manager.get('pty-1')).toBeUndefined();
      late.pid = 6543;
      late._socket.emit('ready_datapipe');
      const instance = await pending;
      expect(read(6543)).toBe(instance.id);
      expect(read(0)).toBeNull();
    } finally { manager.disposeAll(); }
  });

  it('registers nothing when the spawn fails before a pid exists', async () => {
    const failed = deferredPty();
    spawn.mockImplementationOnce(() => failed as never);
    const manager = new PTYManager();
    try {
      const pending = manager.createAsync({});
      await new Promise<void>((r) => setImmediate(r));
      failed.fail(267);
      await expect(pending).rejects.toThrow(/Cannot create process, error code: 267$/);
      expect(manager.get('pty-1')).toBeUndefined();
      expect(read(0)).toBeNull();
      expect(fs.existsSync(mapDir) ? fs.readdirSync(mapDir) : []).toEqual([]);
    } finally { manager.disposeAll(); }
  });

  it('reports a cancel, not the spawn error, when a disposed create then fails to spawn', async () => {
    const failed = deferredPty();
    spawn.mockImplementationOnce(() => failed as never);
    const manager = new PTYManager();
    try {
      const pending = manager.createAsync({});
      await new Promise<void>((r) => setImmediate(r));
      manager.dispose('pty-1');
      failed.fail(87);
      await expect(pending).rejects.toThrow(/^PTY creation cancelled$/);
    } finally { manager.disposeAll(); }
  });

  it('counts creates whose pid is pending against the instance limit, before spawning', async () => {
    const pending: Array<ReturnType<typeof deferredPty>> = [];
    spawn.mockImplementation(() => { const p = deferredPty(); pending.push(p); return p as never; });
    const manager = new PTYManager();
    try {
      const creates = Array.from({ length: 21 }, () => manager.createAsync({}));
      const settled = Promise.allSettled(creates);
      await new Promise<void>((r) => setImmediate(r));
      expect(pending).toHaveLength(20);
      pending.forEach((p, i) => { p.pid = 9000 + i; p._socket.emit('ready_datapipe'); });
      const results = await settled;
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(20);
      const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
      expect(rejected.map((r) => String(r.reason?.message))).toEqual([expect.stringContaining('Maximum PTY instances reached')]);
    } finally {
      manager.disposeAll();
      spawn.mockReset();
      spawn.mockImplementation(() => ({ pid: 4321, kill: vi.fn(), onData: vi.fn(), onExit: vi.fn(), write: vi.fn(), resize: vi.fn() }));
    }
  });
});
