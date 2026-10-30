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

  it('spawns without an owner until main has reported a window', () => {
    create(manager, 'd');
    expect(spawned.at(-1)?.parents).toHaveLength(0);
  });

  it('clears the owner of live panes when the window goes, and stops giving it to new ones', () => {
    create(manager, 'e');
    manager.setHostWindow(hwnd);
    manager.setHostWindow(null);
    expect(spawned[0].parents.at(-1)?.equals(Buffer.alloc(8))).toBe(true);
    create(manager, 'f');
    expect(spawned.at(-1)?.parents).toHaveLength(0);
  });
});
