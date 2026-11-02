// Windows sign-in pickers (az login, MSAL/WAM) parent to the pane's console
// window; the daemon makes the app window its owner on every pane, live or
// spawned later, so the picker opens above wmux instead of behind it.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import os from 'node:os';

class MockPty extends EventEmitter {
  pid = 4242;
  readonly parents: Buffer[] = [];
  onData() { return { dispose: () => undefined }; }
  onExit() { return { dispose: () => undefined }; }
  write(): void { /* noop */ }
  resize(): void { /* noop */ }
  kill(): void { /* noop */ }
  setParentWindow(handle: Buffer): boolean { this.parents.push(Buffer.from(handle)); return true; }
}

const spawned: MockPty[] = [];
vi.mock('node-pty', () => {
  const spawn = () => {
    const p = new MockPty();
    spawned.push(p);
    return p;
  };
  return { default: { spawn }, spawn };
});

import { DaemonSessionManager } from '../DaemonSessionManager';

const hwnd = Buffer.from([0x2a, 0x10, 0, 0, 0, 0, 0, 0]);
const create = (manager: DaemonSessionManager, id: string) =>
  manager.createSession({ id, cmd: '/bin/bash', cwd: os.tmpdir(), env: { PATH: '/usr/bin' } });

describe('DaemonSessionManager host window', () => {
  let manager: DaemonSessionManager;
  beforeEach(() => {
    spawned.length = 0;
    manager = new DaemonSessionManager();
  });
  afterEach(() => manager.disposeAll());

  it('gives every live pane the app window as its console owner', () => {
    create(manager, 'a');
    create(manager, 'b');
    expect(manager.setHostWindow(hwnd)).toBe(2);
    expect(spawned.map((p) => p.parents.at(-1)?.equals(hwnd))).toEqual([true, true]);
  });

  it('gives a pane spawned later the window at spawn', () => {
    manager.setHostWindow(hwnd);
    create(manager, 'c');
    expect(spawned.at(-1)?.parents).toHaveLength(1);
    expect(spawned.at(-1)?.parents[0].equals(hwnd)).toBe(true);
  });

  it('gives the window to a pane whose pid was still pending when it was reported (the first pane at app start)', async () => {
    const pending = manager.createSessionAsync({ id: 'g', cmd: '/bin/bash', cwd: os.tmpdir(), env: { PATH: '/usr/bin' } });
    // Spawned already, not registered yet: the live-pane sweep cannot see it.
    expect(manager.setHostWindow(hwnd)).toBe(0);
    await pending;
    expect(spawned.at(-1)?.parents).toHaveLength(1);
    expect(spawned.at(-1)?.parents[0].equals(hwnd)).toBe(true);
  });

  it('a repeated report of the same window costs no call per pane', () => {
    create(manager, 'h');
    expect(manager.setHostWindow(hwnd)).toBe(1);
    expect(manager.setHostWindow(Buffer.from(hwnd))).toBe(0);
    expect(spawned.at(-1)?.parents).toHaveLength(1);
  });

  it('spawns without an owner until main has reported a window', () => {
    create(manager, 'd');
    expect(spawned.at(-1)?.parents).toHaveLength(0);
  });

  it('stops giving a window to new panes when it goes, without sending live ones a NULL owner', () => {
    create(manager, 'e');
    manager.setHostWindow(hwnd);
    expect(manager.setHostWindow(null)).toBe(0);
    // Windows drops a destroyed window as the owner itself; NULL never reaches ConPTY.
    expect(spawned[0].parents).toHaveLength(1);
    create(manager, 'f');
    expect(spawned.at(-1)?.parents).toHaveLength(0);
  });
});
