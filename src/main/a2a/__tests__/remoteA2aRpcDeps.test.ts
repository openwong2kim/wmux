import { describe, expect, it, vi } from 'vitest';
import { daemonRemoteA2aRpcDeps } from '../remoteA2aRpcDeps';

describe('daemonRemoteA2aRpcDeps', () => {
  it('maps each hook to its daemon RPC', async () => {
    const rpc = vi.fn(async (method: string) => (method === 'a2a.remote.targets' ? { targets: [{ alias: 'a/b/c' }] } : { ok: true, taskId: 'rt-x' }));
    const deps = daemonRemoteA2aRpcDeps(() => ({ rpc }));
    expect(await deps.listTargets()).toEqual([{ alias: 'a/b/c' }]);
    expect(await deps.reply({ taskId: 'rt-x', workspaceId: 'ws', text: 't' })).toEqual({ ok: true, taskId: 'rt-x' });
    expect(rpc).toHaveBeenLastCalledWith('a2a.remote.reply', { taskId: 'rt-x', workspaceId: 'ws', text: 't' });
  });

  it('without a daemon: no targets, every op unavailable; a refusal keeps its code', async () => {
    const none = daemonRemoteA2aRpcDeps(() => null);
    expect(await none.listTargets()).toEqual([]);
    expect(await none.state({ taskId: 'rt-x', state: 'working' })).toEqual({ ok: false, error: 'unavailable' });
    const refusing = daemonRemoteA2aRpcDeps(() => ({ rpc: async () => ({ ok: false, error: 'link-not-active' }) }));
    expect(await refusing.sendTask({ linkId: 'l', from: { workspaceId: 'w', name: 'w', paneId: 'p' }, title: '', text: 't' }))
      .toEqual({ ok: false, error: 'link-not-active' });
  });
});
