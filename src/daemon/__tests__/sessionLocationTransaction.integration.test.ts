import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { DaemonState } from '../types';

class MockPty extends EventEmitter {
  pid = 12345;
  onData() { return { dispose: () => {} }; }
  onExit() { return { dispose: () => {} }; }
  write(): void {}
  resize(): void {}
  kill(): void {}
}

const io = vi.hoisted(() => ({
  asyncWrite: vi.fn(),
  syncWrite: vi.fn(),
}));

vi.mock('node-pty', () => ({
  default: { spawn: () => new MockPty() },
  spawn: () => new MockPty(),
}));

vi.mock('../util/atomicWrite', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../util/atomicWrite')>()),
  atomicWriteJSON: io.asyncWrite,
  atomicWriteJSONSync: io.syncWrite,
}));

import {
  DaemonSessionManager,
  type DaemonSessionLocationCandidateInput,
} from '../DaemonSessionManager';
import { StateWriter } from '../StateWriter';
import {
  SessionLocationTransaction,
  submitDaemonSessionLocationCandidate,
} from '../sessionLocationPersistence';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

let tmpDir = '';
let manager: DaemonSessionManager;
let writer: StateWriter;
let transactions: SessionLocationTransaction;
let events: string[];

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fmux-location-boundary-'));
  manager = new DaemonSessionManager(async () => undefined);
  writer = new StateWriter(tmpDir);
  transactions = new SessionLocationTransaction(writer);
  events = [];
  io.asyncWrite.mockReset().mockResolvedValue(undefined);
  io.syncWrite.mockReset().mockImplementation(() => undefined);
});

afterEach(() => {
  manager.disposeAll();
  writer.dispose();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function buildState(): DaemonState {
  return { version: 1, sessions: manager.listSessions() };
}

function wireCandidates(): void {
  manager.on('session:locationCandidate', (input: DaemonSessionLocationCandidateInput) => {
    void submitDaemonSessionLocationCandidate(
      transactions,
      manager,
      input,
      buildState,
      {
        cwd: () => events.push('cwd.changed'),
        location: () => events.push('location.changed'),
      },
    );
  });
}

describe('daemon session location transaction boundary', () => {
  it('keeps cwd invisible until exact async durability then publishes in order once', async () => {
    const write = deferred<void>();
    io.asyncWrite.mockImplementationOnce(() => write.promise);
    wireCandidates();
    manager.createSession({
      id: 'wsl-1',
      cmd: 'wsl.exe',
      cwd: '/home/me/old',
      location: { domain: 'wsl', cwd: '/home/me/old', shell: 'wsl.exe' },
    });

    manager.getSession('wsl-1')!.bridge.emit('cwd', {
      sessionId: 'wsl-1',
      cwd: '/home/me/new',
    });

    await vi.waitFor(() => expect(io.asyncWrite).toHaveBeenCalledOnce());
    expect(manager.getSession('wsl-1')!.meta.cwd).toBe('/home/me/old');
    expect(manager.getLocationSnapshot('wsl-1')!.revision).toBe(1);
    expect(manager.listSessions()[0].cwd).toBe('/home/me/old');
    expect(events).toEqual([]);

    write.resolve();
    await transactions.flush();

    expect(manager.getSession('wsl-1')!.meta.cwd).toBe('/home/me/new');
    expect(manager.getLocationSnapshot('wsl-1')!.revision).toBe(2);
    expect(events).toEqual(['cwd.changed', 'location.changed']);
  });

  it('suppresses all cwd observation when async durability fails', async () => {
    io.asyncWrite.mockRejectedValueOnce(new Error('disk full'));
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    wireCandidates();
    manager.createSession({
      id: 'wsl-1',
      cmd: 'wsl.exe',
      cwd: '/home/me/old',
      location: { domain: 'wsl', cwd: '/home/me/old', shell: 'wsl.exe' },
    });

    manager.getSession('wsl-1')!.bridge.emit('cwd', {
      sessionId: 'wsl-1',
      cwd: '/home/me/rejected',
    });
    await transactions.flush();

    expect(manager.getSession('wsl-1')!.meta.cwd).toBe('/home/me/old');
    expect(manager.getLocationSnapshot('wsl-1')!.revision).toBe(1);
    expect(events).toEqual([]);
  });

  it('preserves a rapid cwd reversal while the first write is pending', async () => {
    const firstWrite = deferred<void>();
    io.asyncWrite.mockImplementationOnce(() => firstWrite.promise);
    wireCandidates();
    manager.createSession({
      id: 'wsl-1',
      cmd: 'wsl.exe',
      cwd: '/home/me/old',
      location: { domain: 'wsl', cwd: '/home/me/old', shell: 'wsl.exe' },
    });

    manager.getSession('wsl-1')!.bridge.emit('cwd', {
      sessionId: 'wsl-1',
      cwd: '/home/me/new',
    });
    manager.getSession('wsl-1')!.bridge.emit('cwd', {
      sessionId: 'wsl-1',
      cwd: '/home/me/old',
    });
    await vi.waitFor(() => expect(io.asyncWrite).toHaveBeenCalledOnce());

    firstWrite.resolve();
    await transactions.flush();

    expect(manager.getSession('wsl-1')!.meta.cwd).toBe('/home/me/old');
    expect(manager.getLocationSnapshot('wsl-1')!.revision).toBe(3);
    expect(events).toEqual([
      'cwd.changed',
      'location.changed',
      'cwd.changed',
      'location.changed',
    ]);
  });

  it('allows the latest cwd to retry after its failed write', async () => {
    io.asyncWrite.mockRejectedValueOnce(new Error('disk full'));
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    wireCandidates();
    manager.createSession({
      id: 'wsl-1',
      cmd: 'wsl.exe',
      cwd: '/home/me/old',
      location: { domain: 'wsl', cwd: '/home/me/old', shell: 'wsl.exe' },
    });

    manager.getSession('wsl-1')!.bridge.emit('cwd', {
      sessionId: 'wsl-1',
      cwd: '/home/me/new',
    });
    await transactions.flush();
    manager.getSession('wsl-1')!.bridge.emit('cwd', {
      sessionId: 'wsl-1',
      cwd: '/home/me/new',
    });
    await transactions.flush();

    expect(io.asyncWrite).toHaveBeenCalledTimes(2);
    expect(manager.getSession('wsl-1')!.meta.cwd).toBe('/home/me/new');
    expect(events).toEqual(['cwd.changed', 'location.changed']);
  });

  it('publishes one enrichment only after retry success', async () => {
    const distro = deferred<string | undefined>();
    manager.disposeAll();
    manager = new DaemonSessionManager(() => distro.promise);
    io.syncWrite
      .mockImplementationOnce(() => { throw new Error('locked'); })
      .mockImplementationOnce(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    wireCandidates();
    manager.createSession({
      id: 'wsl-1',
      cmd: 'wsl.exe',
      cwd: '/home/me',
      location: { domain: 'wsl', cwd: '/home/me', shell: 'wsl.exe' },
    });

    distro.resolve('Ubuntu');
    await vi.waitFor(() => expect(io.syncWrite).toHaveBeenCalled());
    await transactions.flush();

    expect(io.syncWrite).toHaveBeenCalledTimes(2);
    expect(manager.getLocationSnapshot('wsl-1')!.location)
      .toHaveProperty('distro', 'Ubuntu');
    expect(events).toEqual(['location.changed']);
  });

  it('keeps enrichment invisible and silent after both immediate writes fail', async () => {
    const distro = deferred<string | undefined>();
    manager.disposeAll();
    manager = new DaemonSessionManager(() => distro.promise);
    io.syncWrite.mockImplementation(() => { throw new Error('locked'); });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    wireCandidates();
    manager.createSession({
      id: 'wsl-1',
      cmd: 'wsl.exe',
      cwd: '/home/me',
      location: { domain: 'wsl', cwd: '/home/me', shell: 'wsl.exe' },
    });

    distro.resolve('Rejected');
    await vi.waitFor(() => expect(io.syncWrite).toHaveBeenCalledTimes(2));
    await transactions.flush();

    expect(manager.getLocationSnapshot('wsl-1')!.revision).toBe(1);
    expect(manager.getLocationSnapshot('wsl-1')!.location)
      .not.toHaveProperty('distro');
    expect(events).toEqual([]);
  });
});
