// F26 — the fan-out's renderer spawn port: how long it waits, and what it does
// with a reply that lands after it gave up.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../pipe/handlers/_bridge', () => ({ sendToRenderer: vi.fn() }));

import { spawnTaskWorkspace, SPAWN_TIMEOUT_MS } from '../createFanOutService';
import { WSL_RPC_TIMEOUT_MS } from '../../../shared/wsl';

type Send = NonNullable<Parameters<typeof spawnTaskWorkspace>[2]>['send'];

function deferredSend() {
  let answer!: (v: unknown) => void;
  let fail!: (e: unknown) => void;
  const spawnReply = new Promise<unknown>((res, rej) => {
    answer = res;
    fail = rej;
  });
  const send = vi.fn<(win: unknown, method: string, params?: unknown, opts?: { timeoutMs?: number }) => Promise<unknown>>(
    async (_win, method) => {
      if (method === 'fanout.spawnWorkspace') return spawnReply;
      if (method === 'workspace.close') return { ok: true };
      throw new Error(`unexpected ${method}`);
    },
  );
  return { send: send as unknown as Send & typeof send, answer, fail };
}

const getWindow = () => null;

describe('spawnTaskWorkspace', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('waits longer than pty:create may spend on a WSL pane', () => {
    // A shorter give-up abandons a spawn whose WSL cwd probe is still running.
    expect(SPAWN_TIMEOUT_MS).toBeGreaterThan(WSL_RPC_TIMEOUT_MS);
  });

  it('returns the renderer reply that arrives in time', async () => {
    const { send, answer } = deferredSend();
    const p = spawnTaskWorkspace(getWindow, { name: 't' }, { send, giveUpMs: 1_000 });
    answer({ workspaceId: 'ws-1', ptyId: 'p-1' });
    await expect(p).resolves.toEqual({ workspaceId: 'ws-1', ptyId: 'p-1' });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(send.mock.calls.map((c) => c[1])).toEqual(['fanout.spawnWorkspace']);
  });

  it('gives up at the deadline and closes a workspace that comes up afterwards', async () => {
    const { send, answer } = deferredSend();
    const p = spawnTaskWorkspace(getWindow, { name: 't' }, { send, giveUpMs: 1_000 });
    const message = p.then(() => 'resolved', (e: unknown) => (e as Error).message);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await message).toBe('RPC timeout: fanout.spawnWorkspace (1000ms)');

    // The late success: the fan-out already reported the task as not started.
    answer({ workspaceId: 'ws-late', ptyId: 'p-late' });
    await vi.advanceTimersByTimeAsync(0);
    expect(send).toHaveBeenCalledWith(getWindow, 'workspace.close', { id: 'ws-late', force: true });
  });

  it('closes nothing when the late reply is a failure', async () => {
    const { send, answer } = deferredSend();
    const caught = spawnTaskWorkspace(getWindow, {}, { send, giveUpMs: 1_000 }).catch((e: Error) => e);
    await vi.advanceTimersByTimeAsync(1_000);
    await caught;
    answer({ error: 'fanout.spawnWorkspace: PTY create failed — WSL could not open …' });
    await vi.advanceTimersByTimeAsync(0);
    expect(send.mock.calls.map((c) => c[1])).toEqual(['fanout.spawnWorkspace']);
  });

  it('keeps listening past the give-up for the late reply', () => {
    const { send } = deferredSend();
    void spawnTaskWorkspace(getWindow, {}, { send, giveUpMs: 1_000, lateReplyMs: 60_000 }).catch(() => undefined);
    expect(send.mock.calls[0][3]).toEqual({ timeoutMs: 61_000 });
  });

  it('passes a renderer error through before the deadline', async () => {
    const { send, fail } = deferredSend();
    const p = spawnTaskWorkspace(getWindow, {}, { send, giveUpMs: 1_000 });
    fail(new Error('BrowserWindow is not available'));
    await expect(p).rejects.toThrow('BrowserWindow is not available');
  });
});
