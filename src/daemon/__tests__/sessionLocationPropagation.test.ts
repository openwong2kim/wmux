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

import { DaemonSessionManager } from '../DaemonSessionManager';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

const managers: DaemonSessionManager[] = [];

afterEach(() => {
  for (const manager of managers.splice(0)) manager.disposeAll();
});

describe('daemon session location propagation', () => {
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
    manager.on('session:locationAccepted', (event) => events.push(event));

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
    manager.on('session:locationAccepted', events);

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

  it('orders a reused session id after its prior generation', async () => {
    const oldResult = deferred<string | undefined>();
    const newResult = deferred<string | undefined>();
    const resolve = vi.fn()
      .mockImplementationOnce(() => oldResult.promise)
      .mockImplementationOnce(() => newResult.promise);
    const manager = new DaemonSessionManager(resolve);
    managers.push(manager);

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
