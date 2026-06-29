/**
 * channelLocal.handler — renderer-only channel-mutation IPC (D5).
 *
 * The in-app channels UI (create + composer post) has no senderPtyId, so the
 * pipe-facing a2a.channel handler would fail it closed. This handler is
 * reachable ONLY from the renderer (an ipcMain.handle channel, unreachable from
 * the pipe), so it trusts the renderer-supplied verifiedWorkspaceId and
 * forwards to the daemon.
 *
 * The security property under test: this renderer-trusted path is a POSITIVE
 * allow-list of the five channel-mutating methods — it can NEVER be used to
 * invoke an arbitrary RPC (that would turn it into a general renderer→daemon
 * bypass of the enforcer), and it strips any caller-supplied senderPtyId so the
 * daemon never sees a forged anchor on this path.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

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

import * as electron from 'electron';
import { registerChannelLocalHandlers } from '../channelLocal.handler';
import { IPC } from '../../../../shared/constants';
import type { DaemonClient } from '../../../DaemonClient';

const handlers = (electron as unknown as { __handlers: Map<string, (...a: unknown[]) => unknown> }).__handlers;

function getHandler(channel: string): (...args: unknown[]) => unknown {
  const fn = handlers.get(channel);
  if (!fn) throw new Error(`no handler for ${channel}`);
  return fn;
}

const fakeEvent = {} as Electron.IpcMainInvokeEvent;

let rpc: ReturnType<typeof vi.fn>;
let cleanup: (() => void) | null = null;

/** A minimal DaemonClient stub exposing the single `rpc` method this handler
 *  uses. `connected` toggles the disconnected-path test. */
function installHandler(connected = true): void {
  rpc = vi.fn(async (method: string, params: Record<string, unknown>) => ({ ok: true, echo: { method, params } }));
  const dc = connected ? ({ rpc } as unknown as DaemonClient) : null;
  cleanup = registerChannelLocalHandlers(() => dc);
}

beforeEach(() => {
  handlers.clear();
});

afterEach(() => {
  cleanup?.();
  cleanup = null;
});

describe('channelLocal.handler — CHANNEL_MUTATE_LOCAL', () => {
  it('forwards a mutating method to the daemon with the renderer workspace stamped', async () => {
    installHandler();
    const handler = getHandler(IPC.CHANNEL_MUTATE_LOCAL);
    const result = await handler(fakeEvent, 'a2a.channel.post', {
      channelId: 'ch-1',
      text: 'hi',
      sender: { workspaceId: 'ws-ceo', memberId: 'local-ui', memberName: 'local-ui' },
      verifiedWorkspaceId: '  ws-ceo  ',
    });
    expect(rpc).toHaveBeenCalledTimes(1);
    const [method, params] = rpc.mock.calls[0];
    expect(method).toBe('a2a.channel.post');
    // Trimmed + stamped.
    expect((params as Record<string, unknown>).verifiedWorkspaceId).toBe('ws-ceo');
    expect(result).toMatchObject({ ok: true });
  });

  it('accepts all mutating methods (create/post/join/leave/archive/invite/kick/ack)', async () => {
    installHandler();
    const handler = getHandler(IPC.CHANNEL_MUTATE_LOCAL);
    for (const method of [
      'a2a.channel.create',
      'a2a.channel.post',
      'a2a.channel.join',
      'a2a.channel.leave',
      'a2a.channel.archive',
      'a2a.channel.invite',
      // kick is HUMANS-ONLY: it is allow-listed HERE (renderer IPC, pipe-unreachable)
      // and deliberately absent from the a2a.channel.* pipe router, so only a human
      // in the first-party GUI can eject another member.
      'a2a.channel.kick',
      'a2a.channel.ack',
    ]) {
      rpc.mockClear();
      const r = await handler(fakeEvent, method, { verifiedWorkspaceId: 'ws-ceo' });
      expect(rpc).toHaveBeenCalledTimes(1);
      expect(r).toMatchObject({ ok: true });
    }
  });

  it('REJECTS a non-channel RPC (cannot become a general daemon bypass)', async () => {
    installHandler();
    const handler = getHandler(IPC.CHANNEL_MUTATE_LOCAL);
    for (const method of ['pty.create', 'a2a.task.send', 'session.save', 'daemon.inbox.poll']) {
      const r = await handler(fakeEvent, method, { verifiedWorkspaceId: 'ws-ceo' });
      expect(r).toMatchObject({ ok: false, error: { code: 'NOT_AUTHORIZED' } });
    }
    expect(rpc).not.toHaveBeenCalled();
  });

  it('REJECTS channel READ methods (only mutating methods ride this path)', async () => {
    installHandler();
    const handler = getHandler(IPC.CHANNEL_MUTATE_LOCAL);
    for (const method of ['a2a.channel.list', 'a2a.channel.get', 'a2a.channel.getMessages', 'a2a.channel.getMembers']) {
      const r = await handler(fakeEvent, method, { verifiedWorkspaceId: 'ws-ceo' });
      expect(r).toMatchObject({ ok: false, error: { code: 'NOT_AUTHORIZED' } });
    }
    expect(rpc).not.toHaveBeenCalled();
  });

  it('REJECTS a missing / empty / non-string verifiedWorkspaceId without calling the daemon', async () => {
    installHandler();
    const handler = getHandler(IPC.CHANNEL_MUTATE_LOCAL);
    for (const params of [
      { channelId: 'ch-1' }, // missing
      { verifiedWorkspaceId: '' }, // empty
      { verifiedWorkspaceId: '   ' }, // whitespace-only
      { verifiedWorkspaceId: 42 }, // non-string
    ]) {
      const r = await handler(fakeEvent, 'a2a.channel.post', params);
      expect(r).toMatchObject({ ok: false, error: { code: 'NOT_AUTHORIZED' } });
    }
    expect(rpc).not.toHaveBeenCalled();
  });

  it('STRIPS any caller-supplied senderPtyId before forwarding (no forged anchor)', async () => {
    installHandler();
    const handler = getHandler(IPC.CHANNEL_MUTATE_LOCAL);
    await handler(fakeEvent, 'a2a.channel.post', {
      channelId: 'ch-1',
      text: 'hi',
      verifiedWorkspaceId: 'ws-ceo',
      senderPtyId: 'pty-forged',
    });
    const [, params] = rpc.mock.calls[0];
    expect(params as Record<string, unknown>).not.toHaveProperty('senderPtyId');
  });

  it('rejects a non-object params payload', async () => {
    installHandler();
    const handler = getHandler(IPC.CHANNEL_MUTATE_LOCAL);
    // No verifiedWorkspaceId can be read from a non-object, so it fails closed.
    const r = await handler(fakeEvent, 'a2a.channel.post', 'not-an-object');
    expect(r).toMatchObject({ ok: false, error: { code: 'NOT_AUTHORIZED' } });
    expect(rpc).not.toHaveBeenCalled();
  });

  it('throws when the daemon is not connected', async () => {
    installHandler(false);
    const handler = getHandler(IPC.CHANNEL_MUTATE_LOCAL);
    await expect(
      handler(fakeEvent, 'a2a.channel.post', { verifiedWorkspaceId: 'ws-ceo' }),
    ).rejects.toThrow(/[Dd]aemon/);
  });
});
