// The cross-PC A2A handlers exist before the daemon connects: a renderer read
// that races the boot connect waits for the client instead of meeting a
// missing handler, and an owner's action without a daemon is refused at once.
import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('electron', () => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  return {
    ipcMain: {
      handle: vi.fn((channel: string, fn: (...args: unknown[]) => unknown) => { handlers.set(channel, fn); }),
      removeHandler: vi.fn((channel: string) => { handlers.delete(channel); }),
    },
    BrowserWindow: { getAllWindows: () => [] },
    __handlers: handlers,
  };
});

vi.mock('../../github/PrProvider', () => ({ detectRemote: vi.fn(async () => null) }));

import * as electron from 'electron';
import { IPC } from '../../../shared/constants';
import { registerA2aRemoteHandlers } from '../handlers/a2aRemote.handler';
import type { DaemonClient } from '../../DaemonClient';

const handlers = (electron as unknown as { __handlers: Map<string, (...args: unknown[]) => Promise<unknown>> }).__handlers;
const invoke = (channel: string, ...args: unknown[]) => {
  const fn = handlers.get(channel);
  if (!fn) throw new Error(`No handler registered for '${channel}'`);
  return fn({}, ...args);
};

function fakeClient(): DaemonClient {
  return {
    on: vi.fn(),
    off: vi.fn(),
    a2aRemoteStatus: vi.fn(async () => ({ enabled: true })),
    a2aRemoteLinksList: vi.fn(async () => ({ links: [] })),
    a2aRemotePairBegin: vi.fn(async () => ({ ok: true })),
  } as unknown as DaemonClient;
}

let cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups.reverse()) c();
  cleanups = [];
});

describe('a2aRemote handlers before the daemon connects', () => {
  it('are registered without a client, and a read resolves once the client arrives', async () => {
    cleanups.push(registerA2aRemoteHandlers(null));
    expect(handlers.has(IPC.A2A_REMOTE_STATUS)).toBe(true);
    expect(handlers.has(IPC.A2A_REMOTE_LINKS_LIST)).toBe(true);
    const status = invoke(IPC.A2A_REMOTE_STATUS);
    // The handler swap on connect: the client-less registration is removed,
    // the daemon-mode one installed; the waiting read gets that client.
    cleanups.pop()?.();
    const client = fakeClient();
    cleanups.push(registerA2aRemoteHandlers(client));
    await expect(status).resolves.toEqual({ enabled: true });
    expect(client.a2aRemoteStatus).toHaveBeenCalledTimes(1);
  });

  it('a read with no daemon at all is refused after the wait, as DAEMON_DISCONNECTED', async () => {
    cleanups.push(registerA2aRemoteHandlers(null, { clientWaitMs: 5 }));
    await expect(invoke(IPC.A2A_REMOTE_LINKS_LIST)).rejects.toThrow(/DAEMON_DISCONNECTED|not connected/);
  });

  it('an action without a daemon is refused at once, never run later', async () => {
    cleanups.push(registerA2aRemoteHandlers(null, { clientWaitMs: 60_000 }));
    const begin = invoke(IPC.A2A_REMOTE_PAIR_BEGIN);
    await expect(begin).rejects.toThrow(/not connected/);
    const client = fakeClient();
    cleanups.push(registerA2aRemoteHandlers(client));
    expect(client.a2aRemotePairBegin).not.toHaveBeenCalled();
  });
});
