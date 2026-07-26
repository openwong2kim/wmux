import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';

const broadcastMetadataUpdate = vi.fn();
const updateBranch = vi.fn();
const removeBranch = vi.fn();
const removeCwd = vi.fn();
const updatePorts = vi.fn();
const removePorts = vi.fn();
const updateWorktree = vi.fn();
const removeWorktree = vi.fn();
const getCwd = vi.fn();
const removePaneLocation = vi.fn();
const target = {
  sessionId: 'pty-1',
  location: { domain: 'host' as const, cwd: 'D:\\repo', shell: 'pwsh.exe' },
};
const getPaneCommandTarget = vi.fn();

vi.mock('../../ipc/handlers/metadata.handler', () => ({
  broadcastMetadataUpdate: (...args: unknown[]) => broadcastMetadataUpdate(...args),
  updateBranch: (...args: unknown[]) => updateBranch(...args),
  removeBranch: (...args: unknown[]) => removeBranch(...args),
  removeCwd: (...args: unknown[]) => removeCwd(...args),
  updatePorts: (...args: unknown[]) => updatePorts(...args),
  removePorts: (...args: unknown[]) => removePorts(...args),
  updateWorktree: (...args: unknown[]) => updateWorktree(...args),
  removeWorktree: (...args: unknown[]) => removeWorktree(...args),
  getCwd: (...args: unknown[]) => getCwd(...args),
  getPaneCommandTarget: (...args: unknown[]) => getPaneCommandTarget(...args),
  removePaneLocation: (...args: unknown[]) => removePaneLocation(...args),
}));

const prGet = vi.fn();
vi.mock('../PrStatusCache', () => ({
  prStatusCache: { get: (...args: unknown[]) => prGet(...args) },
}));

import { WorkspaceContextRouter } from '../WorkspaceContextRouter';
import type { DaemonClient } from '../../DaemonClient';

function makeRouter() {
  const client = new EventEmitter();
  const router = new WorkspaceContextRouter(client as unknown as DaemonClient, () => null);
  router.start();
  return { client, router };
}

async function flush(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
}

beforeEach(() => {
  vi.clearAllMocks();
  prGet.mockResolvedValue(null);
  getCwd.mockReturnValue('D:\\repo');
  getPaneCommandTarget.mockReturnValue(target);
});

describe('WorkspaceContextRouter', () => {
  it('folds context.git into branch caches + metadata broadcast and clears the stale PR', async () => {
    const { client } = makeRouter();
    client.emit('session:git', { sessionId: 'pty-1', data: { branch: 'main', isWorktree: false } });
    expect(updateBranch).toHaveBeenCalledWith('pty-1', 'main');
    expect(updateWorktree).toHaveBeenCalledWith('pty-1', false);
    expect(broadcastMetadataUpdate).toHaveBeenCalledWith(null, {
      ptyId: 'pty-1',
      gitBranch: 'main',
      gitIsWorktree: false,
      pr: null,
    });
    await flush();
  });

  it('broadcasts the resolved PR after a branch change', async () => {
    const pr = { number: 9, state: 'open', checks: 'passing', url: 'u' };
    prGet.mockResolvedValue(pr);
    const { client } = makeRouter();
    client.emit('session:git', { sessionId: 'pty-1', data: { branch: 'feat', isWorktree: true } });
    await flush();
    expect(prGet).toHaveBeenCalledWith(target, 'feat');
    expect(broadcastMetadataUpdate).toHaveBeenCalledWith(null, { ptyId: 'pty-1', pr });
  });

  it('drops a PR response that raced a newer branch switch', async () => {
    let resolveFirst!: (v: unknown) => void;
    prGet
      .mockReturnValueOnce(new Promise((r) => { resolveFirst = r; }))
      .mockResolvedValueOnce(null);
    const { client } = makeRouter();
    client.emit('session:git', { sessionId: 'pty-1', data: { branch: 'old', isWorktree: false } });
    client.emit('session:git', { sessionId: 'pty-1', data: { branch: 'new', isWorktree: false } });
    broadcastMetadataUpdate.mockClear();
    resolveFirst({ number: 1, state: 'open', checks: null, url: 'u' });
    await flush();
    // The stale 'old' PR must not have been broadcast.
    const prCalls = broadcastMetadataUpdate.mock.calls.filter(
      (c) => (c[1] as { pr?: unknown }).pr && Object.keys(c[1] as object).length === 2,
    );
    expect(prCalls).toHaveLength(0);
  });

  it('clearing a branch (left the repo) removes the branch cache and skips PR lookup', async () => {
    const { client } = makeRouter();
    client.emit('session:git', { sessionId: 'pty-1', data: { branch: null, isWorktree: false } });
    expect(removeBranch).toHaveBeenCalledWith('pty-1');
    expect(broadcastMetadataUpdate).toHaveBeenCalledWith(null, {
      ptyId: 'pty-1',
      gitBranch: '',
      gitIsWorktree: false,
      pr: null,
    });
    await flush();
    expect(prGet).not.toHaveBeenCalled();
  });

  it('folds context.ports into a deduped numeric port list', () => {
    const { client } = makeRouter();
    client.emit('session:ports', {
      sessionId: 'pty-1',
      data: { ports: [{ port: 3000, pid: 10 }, { port: 3000, pid: 11 }, { port: 8080, pid: 12 }] },
    });
    expect(updatePorts).toHaveBeenCalledWith('pty-1', [3000, 8080]);
    expect(broadcastMetadataUpdate).toHaveBeenCalledWith(null, {
      ptyId: 'pty-1',
      listeningPorts: [3000, 8080],
    });
  });

  it('ignores malformed payloads without throwing', () => {
    const { client } = makeRouter();
    client.emit('session:git', { sessionId: 'pty-1', data: null });
    client.emit('session:ports', { sessionId: 'pty-1', data: { ports: 'nope' } });
    expect(broadcastMetadataUpdate).not.toHaveBeenCalled();
  });

  it('session end clears every per-PTY cache (daemon mode has no poll prune)', () => {
    const { client } = makeRouter();
    client.emit('session:died', { sessionId: 'pty-1' });
    expect(removeCwd).toHaveBeenCalledWith('pty-1');
    expect(removeBranch).toHaveBeenCalledWith('pty-1');
    expect(removeWorktree).toHaveBeenCalledWith('pty-1');
    expect(removePorts).toHaveBeenCalledWith('pty-1');
    expect(removePaneLocation).toHaveBeenCalledWith('pty-1');
  });

  it('stop() detaches all listeners', () => {
    const { client, router } = makeRouter();
    router.stop();
    client.emit('session:git', { sessionId: 'pty-1', data: { branch: 'main', isWorktree: false } });
    expect(broadcastMetadataUpdate).not.toHaveBeenCalled();
  });
});
