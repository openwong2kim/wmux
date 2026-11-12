// a2a.remote.spawn on main's pipe: who may ask, and what reaches the daemon.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { registerRemoteSpawnRpc } from '../remoteSpawn.rpc';
import { FanOutGuards, stampRemoteSpawnPane } from '../../../worktask/fanoutGuards';
import { setFanoutDepth } from '../../../worktask/fanoutWorkerPolicy';
import type { RpcContext } from '../../../../shared/rpc';

type Handler = (params: Record<string, unknown>, ctx?: RpcContext) => Promise<unknown>;

const HOST = '22222222-2222-4222-8222-222222222222';
const local = { origin: 'local' } as RpcContext;
const ask = { pc: 'DESK', agent: 'claude', root: 'web', sub: 'apps', prompt: 'fix the build', senderPtyId: 'pty-a' };

let handlers: Map<string, Handler>;
let dir: string;
let guards: FanOutGuards;
let daemon: { isConnected: boolean; a2aSpawnAsk: ReturnType<typeof vi.fn>; a2aSpawnOutgoing: ReturnType<typeof vi.fn> };

beforeEach(() => {
  handlers = new Map();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-remote-spawn-rpc-'));
  guards = new FanOutGuards({ dir, countLiveTasks: () => 0, ledgerTaskOwner: () => null });
  daemon = {
    isConnected: true,
    a2aSpawnAsk: vi.fn(async () => ({ ok: true })),
    a2aSpawnOutgoing: vi.fn(async () => ({ requests: [], places: [] })),
  };
  const router = { register: (m: string, h: Handler) => handlers.set(m, h) };
  registerRemoteSpawnRpc(router as never, () => null, {
    getDaemonClient: () => daemon as never,
    guards,
    resolveCaller: async (pty) => (pty === 'pty-a' ? { workspaceId: 'ws-a', paneId: 'pane-a' } : null),
  });
});

afterEach(async () => {
  fs.rmSync(dir, { recursive: true, force: true });
  await setFanoutDepth(1);
});

const call = (m: string, p: Record<string, unknown>, ctx: RpcContext = local) => handlers.get(m)!(p, ctx) as Promise<{ ok?: boolean; error?: { code: string } }>;

describe('a2a.remote.spawn', () => {
  it('asks with the caller\'s own pane, found here, and counts it per pane', async () => {
    expect(await call('a2a.remote.spawn', { ...ask, from: { workspaceId: 'ws-x', paneId: 'pane-x' } })).toEqual({ ok: true });
    expect(daemon.a2aSpawnAsk).toHaveBeenCalledWith({
      pc: 'DESK', agent: 'claude', folder: { root: 'web', sub: 'apps' }, text: 'fix the build',
      from: { kind: 'pane', workspaceId: 'ws-a', paneId: 'pane-a' }, callerKey: 'pane-a',
    });
  });

  it('refuses a remote caller, a brain or bot (no pane), and a caller it cannot place', async () => {
    expect((await call('a2a.remote.spawn', ask, { origin: 'remote' } as RpcContext)).error?.code).toBe('NOT_AUTHORIZED');
    expect((await call('a2a.remote.spawn', ask, { origin: 'local', commanderWorkspace: 'ws-a' } as RpcContext)).error?.code).toBe('NOT_AUTHORIZED');
    expect((await call('a2a.remote.spawn', { ...ask, senderPtyId: 'pty-nope' })).error?.code).toBe('NOT_AUTHORIZED');
    expect((await call('a2a.remote.spawn', { ...ask, senderPtyId: undefined })).error?.code).toBe('NOT_AUTHORIZED');
    expect(daemon.a2aSpawnAsk).not.toHaveBeenCalled();
  });

  it('depth 1: an agent another PC started, or a fan-out task, does not ask', async () => {
    stampRemoteSpawnPane({ workspaceId: 'ws-a', remoteSpawnOf: HOST }, guards);
    const res = (await call('a2a.remote.spawn', ask)) as { error: { code: string; message: string } };
    expect(res.error.code).toBe('NOT_AUTHORIZED');
    expect(res.error.message).toContain('another PC');
    expect(daemon.a2aSpawnAsk).not.toHaveBeenCalled();
  });

  it('with the depth setting at 2, an agent another PC started asks; one two levels down does not', async () => {
    await setFanoutDepth(2);
    stampRemoteSpawnPane({ workspaceId: 'ws-a', remoteSpawnOf: HOST }, guards);
    expect(await call('a2a.remote.spawn', ask)).toEqual({ ok: true });
    guards.markTask('ws-mid', 'ws-root');
    guards.markTask('ws-a', 'ws-mid');
    expect((await call('a2a.remote.spawn', ask)).error?.code).toBe('NOT_AUTHORIZED');
  });

  it('refuses a missing field before the daemon is asked', async () => {
    expect((await call('a2a.remote.spawn', { ...ask, agent: 'bash' })).error?.code).toBe('INVALID_ARGUMENT');
    expect((await call('a2a.remote.spawn', { ...ask, prompt: '  ' })).error?.code).toBe('INVALID_ARGUMENT');
    expect(daemon.a2aSpawnAsk).not.toHaveBeenCalled();
  });
});

describe('a2a.remote.spawnStatus', () => {
  it('reads one request or all of them', async () => {
    await call('a2a.remote.spawnStatus', { spawnId: 'sp-1' });
    await call('a2a.remote.spawnStatus', {});
    expect(daemon.a2aSpawnOutgoing.mock.calls).toEqual([['sp-1'], [undefined]]);
  });
});
