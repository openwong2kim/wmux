import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SessionLocationSnapshot } from '../../shared/sessionLocation';

class MockPty extends EventEmitter {
  pid = 12345;
  onData() { return { dispose: () => {} }; }
  onExit() { return { dispose: () => {} }; }
  write(): void {}
  resize(): void {}
  kill(): void {}
}

vi.mock('node-pty', () => ({
  default: { spawn: () => new MockPty() },
  spawn: () => new MockPty(),
}));

import {
  DaemonSessionManager,
  type DaemonSessionLocationCandidateInput,
} from '../DaemonSessionManager';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

const managers: DaemonSessionManager[] = [];

function commitLocationCandidates(
  manager: DaemonSessionManager,
  onCommit: (event: {
    snapshot: SessionLocationSnapshot;
    reason: 'cwd' | 'enriched';
  }) => void = () => {},
): void {
  let transactionId = 0;
  manager.on('session:locationCandidate', (input: DaemonSessionLocationCandidateInput) => {
    const id = ++transactionId;
    const candidate = manager.prepareLocationCandidate(input, id);
    if (!candidate) return;
    const snapshot = manager.commitLocationCandidate(candidate, id);
    if (snapshot) onCommit({ snapshot, reason: input.reason });
  });
}

afterEach(() => {
  for (const manager of managers.splice(0)) manager.disposeAll();
});

describe('daemon session location propagation', () => {
  it('carries the exact location generation on explicit destroy', () => {
    const manager = new DaemonSessionManager();
    managers.push(manager);
    const destroying = vi.fn();
    manager.on('session:destroying', destroying);
    manager.createSession({
      id: 'destroyed-generation',
      cmd: 'wsl.exe',
      cwd: '/home/me',
      location: { domain: 'wsl', cwd: '/home/me', shell: 'wsl.exe' },
    });
    const generation = manager.getLocationSnapshot('destroyed-generation')!.generation;

    manager.destroySession('destroyed-generation');

    expect(destroying).toHaveBeenCalledWith({
      id: 'destroyed-generation',
      locationGeneration: generation,
    });
  });

  it('persists the distro carried by the actual child environment without enumeration', () => {
    const resolve = vi.fn<() => Promise<string | undefined>>();
    const manager = new DaemonSessionManager(resolve);
    managers.push(manager);

    const session = manager.createSession({
      id: 'wsl-explicit',
      cmd: 'wsl.exe',
      cwd: '/home/me/repo',
      env: { WSL_DISTRO_NAME: 'Alpine' },
      location: { domain: 'wsl', cwd: '/home/me/repo', shell: 'wsl.exe' },
    });

    expect(session.location).toMatchObject({ distro: 'Alpine' });
    expect(manager.getLocationSnapshot('wsl-explicit')?.location)
      .toMatchObject({ distro: 'Alpine' });
    expect(resolve).not.toHaveBeenCalled();
  });

  it('stores late enrichment on the durable record and preserves a newer cwd', async () => {
    const distro = deferred<string | undefined>();
    const manager = new DaemonSessionManager(() => distro.promise);
    managers.push(manager);
    const events: Array<{ snapshot: SessionLocationSnapshot; reason: string }> = [];
    commitLocationCandidates(manager, (event) => events.push(event));

    manager.createSession({
      id: 'wsl-1',
      cmd: 'wsl.exe',
      cwd: '/home/me/old',
      location: { domain: 'wsl', cwd: '/home/me/old', shell: 'wsl.exe' },
    });
    const initial = manager.getLocationSnapshot('wsl-1')!;

    manager.getSession('wsl-1')!.bridge.emit('cwd', {
      sessionId: 'wsl-1',
      cwd: '/home/me/new',
    });
    distro.resolve('Ubuntu');
    await vi.waitFor(() => {
      expect(manager.getSession('wsl-1')?.meta.location).toMatchObject({
        cwd: '/home/me/new',
        distro: 'Ubuntu',
      });
    });

    const enriched = events.find((event) => event.reason === 'enriched')!;
    expect(enriched.snapshot.generation).toBe(initial.generation);
    expect(enriched.snapshot.revision).toBeGreaterThan(initial.revision);
    expect(enriched.snapshot.location).toEqual({
      domain: 'wsl',
      cwd: '/home/me/new',
      shell: expect.stringContaining('wsl.exe'),
      distro: 'Ubuntu',
    });
  });

  it('emits nothing when a session closes before resolution finishes', async () => {
    const distro = deferred<string | undefined>();
    const manager = new DaemonSessionManager(() => distro.promise);
    managers.push(manager);
    const events = vi.fn();
    manager.on('session:locationCandidate', events);

    manager.createSession({
      id: 'wsl-1',
      cmd: 'wsl.exe',
      cwd: '/home/me/repo',
      location: { domain: 'wsl', cwd: '/home/me/repo', shell: 'wsl.exe' },
    });
    manager.destroySession('wsl-1');
    distro.resolve('Ubuntu');
    await Promise.resolve();

    expect(events).not.toHaveBeenCalled();
  });

  it('emits nothing when the PTY dies naturally before resolution finishes', async () => {
    const distro = deferred<string | undefined>();
    const manager = new DaemonSessionManager(() => distro.promise);
    managers.push(manager);
    const events = vi.fn();
    manager.on('session:locationCandidate', events);

    manager.createSession({
      id: 'wsl-natural-exit',
      cmd: 'wsl.exe',
      cwd: '/home/me/repo',
      location: { domain: 'wsl', cwd: '/home/me/repo', shell: 'wsl.exe' },
    });
    manager.getSession('wsl-natural-exit')!.bridge.emit('exit', {
      sessionId: 'wsl-natural-exit',
      exitCode: 0,
    });
    distro.resolve('Ubuntu');
    await Promise.resolve();
    await Promise.resolve();

    expect(events).not.toHaveBeenCalled();
    expect(manager.getSession('wsl-natural-exit')?.meta.location)
      .not.toHaveProperty('distro');
  });

  it('keeps a staged enrichment invisible until the transaction commits it', async () => {
    const distro = deferred<string | undefined>();
    const manager = new DaemonSessionManager(() => distro.promise);
    managers.push(manager);
    const initial = manager.createSession({
      id: 'wsl-rollback',
      cmd: 'wsl.exe',
      cwd: '/home/me/repo',
      location: { domain: 'wsl', cwd: '/home/me/repo', shell: 'wsl.exe' },
    });
    let input: DaemonSessionLocationCandidateInput | undefined;
    manager.on('session:locationCandidate', (event) => { input = event; });

    distro.resolve('Ubuntu');
    await vi.waitFor(() => expect(input).toBeDefined());

    expect(initial.location).not.toHaveProperty('distro');
    expect(manager.getSession('wsl-rollback')?.meta.location)
      .not.toHaveProperty('distro');
    expect(manager.getLocationSnapshot('wsl-rollback')?.location)
      .not.toHaveProperty('distro');

    const candidate = manager.prepareLocationCandidate(input!, 1)!;
    expect(manager.listSessionsWithLocationCandidate(candidate)![0].location)
      .toHaveProperty('distro', 'Ubuntu');
    expect(manager.getLocationSnapshot('wsl-rollback')?.revision).toBe(1);

    const committed = manager.commitLocationCandidate(candidate, 1)!;
    expect(committed.revision).toBe(2);
    expect(manager.getSession('wsl-rollback')?.meta.location)
      .toHaveProperty('distro', 'Ubuntu');
  });

  it('orders a reused session id after its prior generation', async () => {
    const oldResult = deferred<string | undefined>();
    const newResult = deferred<string | undefined>();
    const resolve = vi.fn()
      .mockImplementationOnce(() => oldResult.promise)
      .mockImplementationOnce(() => newResult.promise);
    const manager = new DaemonSessionManager(resolve);
    managers.push(manager);
    commitLocationCandidates(manager);

    manager.createSession({
      id: 'wsl-1',
      cmd: 'wsl.exe',
      cwd: '/home/me/old',
      location: { domain: 'wsl', cwd: '/home/me/old', shell: 'wsl.exe' },
    });
    const oldGeneration = manager.getLocationSnapshot('wsl-1')!.generation;
    manager.destroySession('wsl-1');
    manager.createSession({
      id: 'wsl-1',
      cmd: 'wsl.exe',
      cwd: '/home/me/new',
      location: { domain: 'wsl', cwd: '/home/me/new', shell: 'wsl.exe' },
    });
    const newGeneration = manager.getLocationSnapshot('wsl-1')!.generation;

    oldResult.resolve('Stale');
    newResult.resolve('Ubuntu');
    await vi.waitFor(() => {
      expect(manager.getSession('wsl-1')?.meta.location).toMatchObject({
        cwd: '/home/me/new',
        distro: 'Ubuntu',
      });
    });

    expect(newGeneration).toBeGreaterThan(oldGeneration);
  });
});
