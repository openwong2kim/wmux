// Pane-ancestry gate, end to end through the RpcRouter and the real handlers.
//
// Two panes: A (shell pid 1000, pty-A) and B (shell pid 2000, pty-B). A caller
// whose process tree runs under B but whose request claims pane A — the shape
// of a command that inherited A's environment from a shared background server
// — must be refused on every write path before the handler runs.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserWindow } from 'electron';
import { RpcRouter } from '../../RpcRouter';
import { registerA2aChannelRpc } from '../a2a.channel.rpc';
import { registerA2aRpc } from '../a2a.rpc';
import { registerInputRpc } from '../input.rpc';
import { CallerTableResolver, createPaneAncestryGate, daemonLiveShellPid } from '../../../pty/callerAncestry';
import type { ClaudeWorker } from '../../../a2a/ClaudeWorker';
import type { DaemonClient } from '../../../DaemonClient';
import type { PTYManager } from '../../../pty/PTYManager';

const { sendToRendererMock } = vi.hoisted(() => ({ sendToRendererMock: vi.fn() }));
vi.mock('../_bridge', () => ({ sendToRenderer: sendToRendererMock }));
vi.mock('../../../workspace/ptyOwnership', () => ({
  resolvePtyOwnerWorkspace: vi.fn(async (_w: unknown, ptyId: string) =>
    ptyId === 'pty-A' ? 'ws-A' : ptyId === 'pty-B' ? 'ws-B' : null),
}));

const fakeWindow = {} as BrowserWindow;

const SESSIONS = [
  { id: 'pty-A', pid: 1000, state: 'attached' },
  { id: 'pty-B', pid: 2000, state: 'attached' },
];
// 3000 → 2500 → 2000 (pane B's shell) → 1
// 4000 → 1               (detached: setsid / nohup / a shared background server)
const TABLE = new Map<number, number>([
  [3000, 2500], [2500, 2000], [2000, 1], [1000, 1], [4000, 1],
]);

function setup(opts: { snapshot?: () => Promise<{ ppidByPid: Map<number, number>; listeners: [] }>; gate?: boolean } = {}) {
  const daemonRpc = vi.fn(async (method: string, _params?: unknown) => {
    if (method === 'daemon.listSessions') return SESSIONS;
    return { ok: true, message: { seq: 1 } };
  });
  const daemon = { rpc: daemonRpc } as unknown as DaemonClient;
  const router = new RpcRouter();
  const worker = { execute: vi.fn(), cancel: vi.fn(), isFull: false, stop: vi.fn() } as unknown as ClaudeWorker;
  const resolver = new CallerTableResolver(opts.snapshot ?? (async () => ({ ppidByPid: TABLE, listeners: [] })));
  registerA2aRpc(router, () => fakeWindow, worker, { getDaemonClient: () => daemon, tableResolver: resolver });
  registerA2aChannelRpc(router, () => daemon, () => fakeWindow);
  registerInputRpc(router, {} as PTYManager, () => fakeWindow);
  if (opts.gate !== false) {
    router.setPaneAncestryGate(createPaneAncestryGate({
      resolver,
      liveShellPid: daemonLiveShellPid(() => daemon.rpc('daemon.listSessions', {})),
    }));
  }
  return { router, daemonRpc };
}

const WRITES: Array<{ method: string; params: Record<string, unknown> }> = [
  { method: 'a2a.channel.post', params: { channelId: 'ch-1', text: 'hi', sender: { memberId: 'pty-A', workspaceId: 'ws-A' } } },
  { method: 'a2a.task.send', params: { workspaceId: 'ws-A', message: 'do it', to: 'ws-B' } },
  { method: 'input.send', params: { workspaceId: 'ws-A', ptyId: 'pty-B', text: 'rm -rf x' } },
  { method: 'input.sendKey', params: { workspaceId: 'ws-A', ptyId: 'pty-B', key: 'enter' } },
];

function handlerSideEffects(daemonRpc: ReturnType<typeof vi.fn>): string[] {
  const daemonCalls = daemonRpc.mock.calls.map((c) => c[0] as string).filter((m) => m !== 'daemon.listSessions');
  const rendererCalls = sendToRendererMock.mock.calls.map((c) => c[1] as string);
  return [...daemonCalls, ...rendererCalls];
}

describe('pane-ancestry gate — a caller under pane B claiming pane A', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sendToRendererMock.mockResolvedValue({ ok: true });
  });

  for (const { method, params } of WRITES) {
    it(`refuses ${method} before the handler runs`, async () => {
      const { router, daemonRpc } = setup();
      const res = await router.dispatch({
        id: 'w', method: method as never, params: { ...params, senderPtyId: 'pty-A', callerPid: 3000 },
      });
      expect(res.ok).toBe(false);
      expect((res as { error: string }).error).toMatch(/^NOT_AUTHORIZED: .*outside its pane's process tree/);
      expect(handlerSideEffects(daemonRpc)).toEqual([]);
    });
  }

  it('lets the same caller act as its own pane (B), and strips callerPid before the handler', async () => {
    const { router, daemonRpc } = setup();
    const res = await router.dispatch({
      id: 'ok', method: 'a2a.channel.post',
      params: { channelId: 'ch-1', text: 'hi', sender: { memberId: 'pty-B', workspaceId: 'ws-B' }, senderPtyId: 'pty-B', callerPid: 3000 },
    });
    expect(res.ok).toBe(true);
    const post = daemonRpc.mock.calls.find((c) => c[0] === 'a2a.channel.post');
    expect(post).toBeDefined();
    expect(post![1]).not.toHaveProperty('callerPid');
    expect(post![1]).toMatchObject({ verifiedWorkspaceId: 'ws-B' });
  });

  it('refuses a detached caller (setsid / nohup / shared server) with the relaunch hint', async () => {
    const { router } = setup();
    const res = await router.dispatch({
      id: 'd', method: 'a2a.channel.post',
      params: { channelId: 'ch-1', text: 'hi', senderPtyId: 'pty-A', callerPid: 4000 },
    });
    expect(res.ok).toBe(false);
    expect((res as { error: string }).error).toContain('codex --no-daemon');
  });

  it('refuses a claimed pane whose session is dead', async () => {
    const { router } = setup();
    const res = await router.dispatch({
      id: 'x', method: 'a2a.task.send',
      params: { workspaceId: 'ws-A', message: 'm', to: 'ws-B', senderPtyId: 'pty-gone', callerPid: 3000 },
    });
    expect(res.ok).toBe(false);
  });

  it('checks callerPtyId as well as senderPtyId', async () => {
    const { router, daemonRpc } = setup();
    const res = await router.dispatch({
      id: 'c', method: 'input.send',
      params: { workspaceId: 'ws-B', ptyId: 'pty-B', text: 'x', senderPtyId: 'pty-B', callerPtyId: 'pty-A', callerPid: 3000 },
    });
    expect(res.ok).toBe(false);
    expect(handlerSideEffects(daemonRpc)).toEqual([]);
  });
});

describe('pane-ancestry gate — unverifiable and legacy callers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sendToRendererMock.mockResolvedValue({ ok: true });
  });

  it('refuses with a retryable error when no process table can be read (win32, both reads fail)', async () => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', { value: 'win32' });
    try {
      let reads = 0;
      const { router, daemonRpc } = setup({ snapshot: async () => { reads++; throw new Error('native snapshot unavailable'); } });
      const res = await router.dispatch({
        id: 'u', method: 'a2a.channel.post',
        params: { channelId: 'ch-1', text: 'hi', senderPtyId: 'pty-B', callerPid: 3000 },
      });
      expect(reads).toBe(2);
      expect(res.ok).toBe(false);
      expect((res as { error: string }).error).toContain('retry');
      expect(handlerSideEffects(daemonRpc)).toEqual([]);
    } finally {
      Object.defineProperty(process, 'platform', platform);
    }
  });

  it('verifies from the retry when only the first read fails (win32)', async () => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', { value: 'win32' });
    try {
      let reads = 0;
      const { router } = setup({
        snapshot: async () => {
          if (reads++ === 0) throw new Error('native snapshot unavailable');
          return { ppidByPid: TABLE, listeners: [] };
        },
      });
      const res = await router.dispatch({
        id: 'r', method: 'a2a.channel.post',
        params: { channelId: 'ch-1', text: 'hi', senderPtyId: 'pty-B', callerPid: 3000 },
      });
      expect(res.ok).toBe(true);
    } finally {
      Object.defineProperty(process, 'platform', platform);
    }
  });

  it('leaves a request without callerPid unchanged (older clients)', async () => {
    const { router, daemonRpc } = setup();
    const res = await router.dispatch({
      id: 'l', method: 'a2a.channel.post',
      params: { channelId: 'ch-1', text: 'hi', senderPtyId: 'pty-A' },
    });
    expect(res.ok).toBe(true);
    expect(daemonRpc.mock.calls.some((c) => c[0] === 'a2a.channel.post')).toBe(true);
  });
});
