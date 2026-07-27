/**
 * chat.handler — Chat View main ↔ daemon relay (plan PR-4).
 *
 * Three properties are load-bearing and each has a test below:
 *   1. every CHAT_* invoke forwards to the matching `daemon.transcript.*` method
 *      with the daemon's parameter names (`id`, not `ptyId`);
 *   2. every channel calls `removeHandler` BEFORE `handle`, because
 *      registerAllHandlers re-runs on each daemon reconnect and a second bare
 *      handle() for the same channel throws and aborts the connect bootstrap
 *      (the regression registerHandlers.rpcInvoke.test.ts exists for);
 *   3. local (non-daemon) mode short-circuits to `{available:false,
 *      reason:'local-mode'}` instead of rejecting — an unavailable projector
 *      disables a toggle, it is not an error the renderer has to catch.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('electron', () => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const calls: string[] = [];
  const ipcMain = {
    handle: vi.fn((channel: string, fn: (...args: unknown[]) => unknown) => {
      calls.push(`handle:${channel}`);
      handlers.set(channel, fn);
    }),
    removeHandler: vi.fn((channel: string) => {
      calls.push(`remove:${channel}`);
      handlers.delete(channel);
    }),
  };
  return { ipcMain, __handlers: handlers, __calls: calls };
});

import * as electron from 'electron';
import { registerChatHandlers } from '../chat.handler';
import { IPC } from '../../../../shared/constants';
import type { DaemonClient } from '../../../DaemonClient';
import type { TranscriptAppendData } from '../../../../shared/transcript/turnEvents';

const mocked = electron as unknown as {
  __handlers: Map<string, (...a: unknown[]) => unknown>;
  __calls: string[];
};

function getHandler(channel: string): (...args: unknown[]) => unknown {
  const fn = mocked.__handlers.get(channel);
  if (!fn) throw new Error(`no handler for ${channel}`);
  return fn;
}

const fakeEvent = {} as Electron.IpcMainInvokeEvent;

interface FakeWindow {
  isDestroyed: () => boolean;
  webContents: { send: ReturnType<typeof vi.fn> };
}

function makeWindow(): FakeWindow {
  return { isDestroyed: () => false, webContents: { send: vi.fn() } };
}

/** A fake DaemonClient whose `rpc` echoes back what it was asked. */
function makeDaemon(result: unknown): {
  dc: DaemonClient;
  rpc: ReturnType<typeof vi.fn>;
  listeners: Map<string, (payload: never) => void>;
} {
  const rpc = vi.fn(async () => result);
  const listeners = new Map<string, (payload: never) => void>();
  const dc = {
    rpc,
    isConnected: true,
    on: vi.fn((event: string, cb: (payload: never) => void) => { listeners.set(event, cb); }),
    off: vi.fn((event: string) => { listeners.delete(event); }),
  } as unknown as DaemonClient;
  return { dc, rpc, listeners };
}

beforeEach(() => {
  mocked.__handlers.clear();
  mocked.__calls.length = 0;
});

describe('chat.handler — daemon relay', () => {
  it('forwards status/subscribe/unsubscribe with the daemon param name `id`', async () => {
    const { dc, rpc } = makeDaemon({ available: true, reason: 'ok' });
    registerChatHandlers({ getWindow: () => null, getDaemonClient: () => dc });

    await getHandler(IPC.CHAT_STATUS)(fakeEvent, 'pty-1');
    expect(rpc).toHaveBeenCalledWith('daemon.transcript.status', { id: 'pty-1' });

    await getHandler(IPC.CHAT_SUBSCRIBE)(fakeEvent, 'pty-1');
    expect(rpc).toHaveBeenCalledWith('daemon.transcript.subscribe', { id: 'pty-1' });

    await getHandler(IPC.CHAT_UNSUBSCRIBE)(fakeEvent, 'pty-1');
    expect(rpc).toHaveBeenCalledWith('daemon.transcript.unsubscribe', { id: 'pty-1' });
  });

  it('omits `before` unless a finite number was supplied (undefined must not become offset 0)', async () => {
    const { dc, rpc } = makeDaemon(null);
    registerChatHandlers({ getWindow: () => null, getDaemonClient: () => dc });

    await getHandler(IPC.CHAT_SNAPSHOT)(fakeEvent, 'pty-1');
    expect(rpc).toHaveBeenLastCalledWith('daemon.transcript.snapshot', { id: 'pty-1' });

    await getHandler(IPC.CHAT_SNAPSHOT)(fakeEvent, 'pty-1', 4096);
    expect(rpc).toHaveBeenLastCalledWith('daemon.transcript.snapshot', { id: 'pty-1', before: 4096 });
  });

  it('relays a code-block fetch and rejects a malformed handle without an RPC', async () => {
    const { dc, rpc } = makeDaemon({ body: 'const a = 1;' });
    registerChatHandlers({ getWindow: () => null, getDaemonClient: () => dc });

    const ok = await getHandler(IPC.CHAT_CODE_BLOCK)(fakeEvent, {
      ptyId: 'pty-1',
      srcOffset: 120,
      n: 2,
      eventId: 'uuid-9',
    });
    expect(ok).toEqual({ body: 'const a = 1;' });
    expect(rpc).toHaveBeenCalledWith('daemon.transcript.codeBlock', {
      id: 'pty-1',
      srcOffset: 120,
      n: 2,
      eventId: 'uuid-9',
    });

    rpc.mockClear();
    // No srcOffset → the projector could only guess at a line; answer null.
    expect(await getHandler(IPC.CHAT_CODE_BLOCK)(fakeEvent, { ptyId: 'pty-1', n: 2 })).toBeNull();
    expect(rpc).not.toHaveBeenCalled();
  });

  it('pushes a daemon transcript append to the renderer as (ptyId, data)', () => {
    const { dc, listeners } = makeDaemon(null);
    const win = makeWindow();
    registerChatHandlers({
      getWindow: () => win as unknown as Electron.BrowserWindow,
      getDaemonClient: () => dc,
    });

    const data: TranscriptAppendData = {
      seq: 3,
      events: [],
      cursor: { headOffset: 0, tailOffset: 10, fileSize: 10, mtimeMs: 1 },
    };
    const onTranscript = listeners.get('session:transcript');
    expect(onTranscript).toBeTypeOf('function');
    (onTranscript as unknown as (p: { sessionId: string; data: TranscriptAppendData }) => void)({
      sessionId: 'pty-7',
      data,
    });

    expect(win.webContents.send).toHaveBeenCalledWith(IPC.CHAT_APPEND, 'pty-7', data);
  });
});

describe('chat.handler — reconnect safety', () => {
  it('calls removeHandler before handle for every channel', () => {
    const { dc } = makeDaemon(null);
    registerChatHandlers({ getWindow: () => null, getDaemonClient: () => dc });

    for (const channel of [
      IPC.CHAT_STATUS,
      IPC.CHAT_SNAPSHOT,
      IPC.CHAT_SUBSCRIBE,
      IPC.CHAT_UNSUBSCRIBE,
      IPC.CHAT_CODE_BLOCK,
    ]) {
      const removeAt = mocked.__calls.indexOf(`remove:${channel}`);
      const handleAt = mocked.__calls.indexOf(`handle:${channel}`);
      expect(removeAt, `${channel} removeHandler missing`).toBeGreaterThanOrEqual(0);
      expect(handleAt, `${channel} handle missing`).toBeGreaterThanOrEqual(0);
      expect(removeAt).toBeLessThan(handleAt);
    }
  });

  it('re-registering does not throw and the cleanup drops every channel', () => {
    const { dc } = makeDaemon(null);
    const cleanup = registerChatHandlers({ getWindow: () => null, getDaemonClient: () => dc });
    expect(() => registerChatHandlers({ getWindow: () => null, getDaemonClient: () => dc })).not.toThrow();
    cleanup();
    expect(mocked.__handlers.size).toBe(0);
  });
});

describe('chat.handler — CHAT_OPEN_GATES (the composer-gate seed)', () => {
  it('narrows the registry list to the ptyIds with a PENDING request', async () => {
    const { dc, rpc } = makeDaemon({
      pending: [
        { id: 'a1', sessionId: 'pty-1' },
        { id: 'a2', sessionId: 'pty-3' },
        // A duplicate pane and a malformed row must not reach the renderer as
        // two locks or as an undefined key.
        { id: 'a3', sessionId: 'pty-1' },
        { id: 'a4' },
      ],
      recentlyResolved: [{ id: 'a0', sessionId: 'pty-9' }],
    });
    registerChatHandlers({ getWindow: () => null, getDaemonClient: () => dc });

    expect(await getHandler(IPC.CHAT_OPEN_GATES)(fakeEvent)).toEqual(['pty-1', 'pty-3']);
    expect(rpc).toHaveBeenCalledWith('daemon.approvals.list', {});
  });

  it('answers with an empty list in local mode rather than throwing', async () => {
    registerChatHandlers({ getWindow: () => null, getDaemonClient: () => null });
    expect(await getHandler(IPC.CHAT_OPEN_GATES)(fakeEvent)).toEqual([]);
  });

  it('survives a registry that answers with no pending array', async () => {
    const { dc } = makeDaemon({});
    registerChatHandlers({ getWindow: () => null, getDaemonClient: () => dc });
    expect(await getHandler(IPC.CHAT_OPEN_GATES)(fakeEvent)).toEqual([]);
  });
});

describe('chat.handler — local (non-daemon) mode', () => {
  it('answers local-mode without reaching for a daemon', async () => {
    registerChatHandlers({ getWindow: () => null, getDaemonClient: () => null });

    expect(await getHandler(IPC.CHAT_STATUS)(fakeEvent, 'pty-1')).toEqual({
      available: false,
      reason: 'local-mode',
    });
    expect(await getHandler(IPC.CHAT_SUBSCRIBE)(fakeEvent, 'pty-1')).toEqual({
      ok: false,
      status: { available: false, reason: 'local-mode' },
    });
    expect(await getHandler(IPC.CHAT_UNSUBSCRIBE)(fakeEvent, 'pty-1')).toEqual({ ok: false });
    expect(await getHandler(IPC.CHAT_SNAPSHOT)(fakeEvent, 'pty-1')).toBeNull();
    expect(
      await getHandler(IPC.CHAT_CODE_BLOCK)(fakeEvent, { ptyId: 'pty-1', srcOffset: 0, n: 1 }),
    ).toBeNull();
  });

  it('answers local-mode for an empty ptyId even with a live daemon', async () => {
    const { dc, rpc } = makeDaemon({ available: true, reason: 'ok' });
    registerChatHandlers({ getWindow: () => null, getDaemonClient: () => dc });

    expect(await getHandler(IPC.CHAT_STATUS)(fakeEvent, '')).toEqual({
      available: false,
      reason: 'local-mode',
    });
    expect(rpc).not.toHaveBeenCalled();
  });
});
