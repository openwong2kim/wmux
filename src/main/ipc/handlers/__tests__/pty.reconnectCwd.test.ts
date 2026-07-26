import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { IPC } from '../../../../shared/constants';
import {
  getCwd,
  getPaneCommandTarget,
  onCwdUpdate,
  removeCwd,
  removePaneLocation,
} from '../metadata.handler';
import { registerPTYHandlers } from '../pty.handler';
import type { PTYManager } from '../../../pty/PTYManager';
import type { PTYBridge } from '../../../pty/PTYBridge';
import type { DaemonClient } from '../../../DaemonClient';
import type { SessionLocation } from '../../../../shared/sessionLocation';

const electronMock = vi.hoisted(() => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  return {
    handlers,
    ipcMain: {
      handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
        handlers.set(channel, handler);
      }),
      removeHandler: vi.fn((channel: string) => {
        handlers.delete(channel);
      }),
      on: vi.fn(),
      removeAllListeners: vi.fn(),
    },
  };
});

vi.mock('electron', async (importOriginal) => ({
  ...await importOriginal<typeof import('electron')>(),
  ipcMain: electronMock.ipcMain,
}));

/**
 * Source-level regression lock (owner-reported 2026-07-19):
 *
 * After an app restart, reconnecting to the daemon's persistent session
 * (PTY_RECONNECT) shows only the name in the workspace sidebar — no branch/port/PR.
 * Cause: the metadata poll only handles panes present in cwdMap, and
 * buildMetadataPayload returns null immediately without a cwd, so the entire context
 * line disappears when there's no cwd. The create path seeds cwd, but reconnect threw
 * away the cwd the daemon included in the listSessions response. After-the-fact prompt
 * scraping only catches PowerShell/bash prompts, not macOS's default zsh ("works on
 * win but not mac"), so reconnect must seed it.
 *
 * The registered handler is exercised through the mocked ipcMain boundary so
 * the assertion covers its daemon RPC wiring and metadata side effects.
 */

const SRC = readFileSync(
  path.resolve(process.cwd(), 'src/main/ipc/handlers/pty.handler.ts'),
  'utf8',
);

// Slice out only the PTY_RECONNECT handler body (so it doesn't mix with the create path's updateCwd).
const reconnectStart = SRC.indexOf('IPC.PTY_RECONNECT, wrapHandler');
const RECONNECT = reconnectStart > -1 ? SRC.slice(reconnectStart) : '';

type ListedSession = {
  id: string;
  cmd: string;
  state: string;
  cwd?: string;
  location?: SessionLocation;
};

class FakeDaemon extends EventEmitter {
  readonly isConnected = true;
  readonly rpc = vi.fn(async (method: string) => {
    if (method === 'daemon.listSessions') return this.sessions;
    return {};
  });
  readonly connectSessionPipe = vi.fn(async () => {});
  readonly isSessionPipeWritable = vi.fn(() => true);
  readonly writeToSession = vi.fn(() => true);
  readonly disconnectSessionPipe = vi.fn(async () => {});

  constructor(readonly sessions: ListedSession[]) {
    super();
  }
}

let cleanup: (() => void) | undefined;
const testIds = ['pty-live', 'pty-absent', 'pty-dead'];

beforeEach(() => {
  electronMock.handlers.clear();
  for (const id of testIds) {
    removeCwd(id);
    removePaneLocation(id);
  }
});

afterEach(() => {
  cleanup?.();
  cleanup = undefined;
  for (const id of testIds) {
    removeCwd(id);
    removePaneLocation(id);
  }
});

function registerReconnect(sessions: ListedSession[]) {
  const daemon = new FakeDaemon(sessions);
  cleanup = registerPTYHandlers(
    {} as PTYManager,
    {} as PTYBridge,
    daemon as unknown as DaemonClient,
  );
  const handler = electronMock.handlers.get(IPC.PTY_RECONNECT);
  if (!handler) throw new Error('PTY_RECONNECT handler was not registered');
  return { daemon, handler };
}

describe('PTY_RECONNECT metadata restoration', () => {
  it('seeds the authoritative location once before notifying cwd listeners', async () => {
    const location: SessionLocation = {
      domain: 'wsl',
      cwd: '/home/me/project',
      shell: 'wsl.exe',
      distro: 'Ubuntu',
    };
    const { handler } = registerReconnect([{
      id: 'pty-live',
      cmd: 'wsl.exe',
      state: 'running',
      cwd: '/home/me/project',
      location,
    }]);
    const observed: Array<SessionLocation | undefined> = [];
    const unsubscribe = onCwdUpdate((id) => {
      if (id === 'pty-live') observed.push(getPaneCommandTarget(id)?.location);
    });

    const result = await handler({}, 'pty-live');
    unsubscribe();

    expect(result).toMatchObject({ success: true, id: 'pty-live' });
    expect(observed).toEqual([location]);
    expect(getCwd('pty-live')).toBe('/home/me/project');
    expect(getPaneCommandTarget('pty-live')?.location).toEqual(location);
  });

  it.each([
    ['absent', [], 'pty-absent'],
    ['dead', [{ id: 'pty-dead', cmd: 'pwsh.exe', state: 'dead', cwd: 'C:\\repo' }], 'pty-dead'],
  ] as const)('does not seed metadata for an %s session', async (_case, sessions, id) => {
    const { handler } = registerReconnect([...sessions]);
    const listener = vi.fn();
    const unsubscribe = onCwdUpdate(listener);

    const result = await handler({}, id);
    unsubscribe();

    expect(result).toMatchObject({ success: false, code: 'session-dead' });
    expect(listener).not.toHaveBeenCalled();
    expect(getCwd(id)).toBeUndefined();
    expect(getPaneCommandTarget(id)).toBeUndefined();
  });
});

/**
 * Source-level regression lock (dogfood 2026-07-22, 30-session scaling branch):
 *
 * A recovered pane sat BLANK until it was clicked. Root cause: attachSession
 * makes the daemon replay the session's historical RingBuffer (the only paint
 * an idle recovered shell gets — no new output is coming), but the reconnect
 * handler registered the session:data forwarder AFTER attach+connect. Under
 * boot load (many sessions recovering, busy event loop) DaemonClient could
 * read+emit that replay before a handler existed, dropping it; the pane then
 * stayed blank until a focus/reveal forced a resync.
 *
 * Fix: register setSessionDataListener BEFORE daemon.attachSession so no replay
 * byte can arrive without a handler. This lock pins that ordering — the handler
 * is deeply coupled to daemonClient RPC (electron import), so like the cwd lock
 * above we assert it at the source level.
 */
describe('PTY_RECONNECT registers session:data before attachSession (source-level lock)', () => {
  const listenerIdx = RECONNECT.indexOf('setSessionDataListener(id, onSessionData)');
  const attachIdx = RECONNECT.indexOf("daemon.attachSession', { id }");

  it('registers the session:data handler in the reconnect path', () => {
    expect(listenerIdx).toBeGreaterThan(-1);
  });

  it('calls attachSession in the reconnect path', () => {
    expect(attachIdx).toBeGreaterThan(-1);
  });

  it('registers the handler BEFORE attachSession (closes the replay-drop window)', () => {
    expect(listenerIdx).toBeLessThan(attachIdx);
  });

  it('does not re-register the handler a second time after attach (no duplicate)', () => {
    const matches = RECONNECT.match(/setSessionDataListener\(id, onSessionData\)/g) ?? [];
    expect(matches.length).toBe(1);
  });
});
