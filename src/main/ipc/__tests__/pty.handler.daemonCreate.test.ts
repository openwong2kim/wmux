// A daemon-mode create through the real handler. The account vault's join
// once read the session id before it was declared, so every daemon-mode create
// threw; the source-order tests never ran a create and missed it.
import { describe, expect, it, vi } from 'vitest';

const captured = new Map<string, (...a: unknown[]) => unknown>();
vi.mock('electron', () => ({
  app: { isPackaged: false, getAppPath: () => '/repo', getPath: () => '/tmp', on: () => undefined },
  ipcMain: {
    handle: (c: string, f: (...a: unknown[]) => unknown) => captured.set(c, f),
    removeHandler: () => undefined,
    on: () => undefined,
    removeListener: () => undefined,
    removeAllListeners: () => undefined,
  },
  BrowserWindow: { getAllWindows: () => [] },
  safeStorage: {},
  clipboard: {},
}));

import { registerPTYHandlers } from '../handlers/pty.handler';
import { IPC } from '../../../shared/constants';

describe('pty create in daemon mode', () => {
  it('reaches daemon.createSession for a plain pane, with no secret env', async () => {
    const rpc = vi.fn(async () => ({}));
    const daemonClient = {
      isConnected: true,
      writeToSession: vi.fn(),
      on: () => undefined,
      off: () => undefined,
      removeListener: () => undefined,
      rpc,
      connectSessionPipe: vi.fn(),
      disconnectSessionPipe: vi.fn(async () => undefined),
    };
    registerPTYHandlers({} as never, { setupDataForwarding: () => undefined } as never, daemonClient as never, () => null);
    const create = captured.get(IPC.PTY_CREATE);
    expect(create).toBeDefined();
    await create?.({}, { cwd: process.cwd() }).catch(() => undefined);
    const createCall = rpc.mock.calls.find((c) => (c as unknown[])[0] === 'daemon.createSession') as unknown[] | undefined;
    expect(createCall).toBeDefined();
    expect((createCall?.[1] as { secretEnv?: unknown }).secretEnv).toBeUndefined();
  });
});
