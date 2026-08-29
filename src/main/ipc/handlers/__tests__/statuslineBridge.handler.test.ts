/**
 * statuslineBridge.handler — the install IPC's `force` payload.
 *
 * The Settings card's Replace button is one boolean travelling renderer →
 * preload → ipcMain → installStatusline. If that boolean is dropped anywhere
 * along the way the failure is silent and looks exactly like the bug it was
 * meant to fix (#1102): the forced install skips the foreign entry again and
 * the row reports the same skip, with no error and nothing in the log. So the
 * wire itself is what this file tests.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('electron', () => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const ipcMain = {
    handle: vi.fn((channel: string, fn: (...args: unknown[]) => unknown) => {
      handlers.set(channel, fn);
    }),
    removeHandler: vi.fn((channel: string) => {
      handlers.delete(channel);
    }),
  };
  return { ipcMain, __handlers: handlers };
});

const installStatusline = vi.fn((_paths: unknown, _opts?: { force?: boolean }) => ({
  ok: true,
  scriptDest: '/tmp/wmux-statusline.mjs',
  scriptSource: '/tmp/src.mjs',
  scriptCopied: true,
  targets: [],
  error: null,
}));

vi.mock('../../../../cli/commands/setupStatusline', () => ({
  defaultPaths: () => ({ targets: [], scriptDest: '/tmp/wmux-statusline.mjs', scriptSource: '/tmp/src.mjs' }),
  installStatusline: (paths: unknown, opts?: { force?: boolean }) => installStatusline(paths, opts),
  statusStatusline: () => ({ scriptDest: '/tmp/wmux-statusline.mjs', scriptExists: true, targets: [] }),
}));

import { IPC } from '../../../../shared/constants';
import { registerStatuslineBridgeHandlers } from '../statuslineBridge.handler';

async function invokeInstall(payload?: unknown): Promise<void> {
  const electron = (await import('electron')) as unknown as {
    __handlers: Map<string, (...args: unknown[]) => unknown>;
  };
  const handler = electron.__handlers.get(IPC.STATUSLINE_BRIDGE_INSTALL);
  expect(handler).toBeDefined();
  await handler!({} as unknown, payload);
}

describe('statuslineBridge install handler', () => {
  beforeEach(() => {
    installStatusline.mockClear();
    registerStatuslineBridgeHandlers();
  });

  it('passes force:true through to the installer', async () => {
    await invokeInstall({ force: true });
    expect(installStatusline).toHaveBeenCalledWith(expect.anything(), { force: true });
  });

  // Every other shape must land on force:false. An overwrite of someone else's
  // config is opt-in by exact value, never by truthiness or by absence.
  it('defaults to force:false for a missing, empty, or non-boolean payload', async () => {
    await invokeInstall(undefined);
    await invokeInstall({});
    await invokeInstall({ force: 'true' });
    await invokeInstall({ force: 1 });
    for (const call of installStatusline.mock.calls) {
      expect(call[1]).toEqual({ force: false });
    }
    expect(installStatusline).toHaveBeenCalledTimes(4);
  });
});
