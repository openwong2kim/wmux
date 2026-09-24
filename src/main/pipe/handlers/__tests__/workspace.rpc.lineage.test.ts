// Depth-1 lineage inheritance: a workspace created FROM a fan-out task
// workspace is itself a task of the same owner, so "open a new workspace and
// fan out from there" does not step around the one-level limit — and every
// uncertain case fails closed instead of creating an unstamped workspace.

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserWindow } from 'electron';
import { RpcRouter } from '../../RpcRouter';
import { registerWorkspaceRpc } from '../workspace.rpc';
import { registerFanOutRpc } from '../fanout.rpc';
import { FanOutGuards } from '../../../worktask/fanoutGuards';
import type { FanOutService } from '../../../worktask/FanOutService';

const { sendToRendererMock } = vi.hoisted(() => ({ sendToRendererMock: vi.fn() }));
vi.mock('../_bridge', () => ({ sendToRenderer: sendToRendererMock }));

const fakeWindow = {} as BrowserWindow;
const PTY_TO_WS: Record<string, string> = {
  'pty-worker': 'ws-task',
  'pty-plain': 'ws-plain',
  'pty-in-new': 'ws-new',
};

function setup(): { router: RpcRouter; guards: FanOutGuards } {
  const guards = new FanOutGuards({
    dir: fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-ws-lineage-')),
    countLiveTasks: () => 0,
    ledgerTaskOwner: () => null,
  });
  guards.markTask('ws-task', 'ws-brain');
  const router = new RpcRouter();
  registerWorkspaceRpc(router, () => fakeWindow, {
    guards,
    resolveCallerWorkspace: async (pty) => PTY_TO_WS[pty] ?? null,
  });
  return { router, guards };
}

/** The router's error envelope carries the handler's message as a string. */
function errorOf(res: unknown): string {
  const e = (res as { ok?: boolean; error?: unknown }).error;
  expect((res as { ok?: boolean }).ok).toBe(false);
  return typeof e === 'string' ? e : JSON.stringify(e ?? '');
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('workspace creation inherits the fan-out lineage stamp', () => {
  it('workspace.new from a task pane stamps the new workspace with the same owner', async () => {
    sendToRendererMock.mockResolvedValue({ id: 'ws-new', name: 'x' });
    const { router, guards } = setup();
    await router.dispatch({ id: '1', method: 'workspace.new', params: { name: 'x', senderPtyId: 'pty-worker' } });
    expect(guards.fanoutOwnerOf('ws-new')).toBe('ws-brain');
  });

  it('a workspace created from an ordinary pane stays unstamped', async () => {
    sendToRendererMock.mockResolvedValue({ id: 'ws-new', name: 'x' });
    const { router, guards } = setup();
    await router.dispatch({ id: '1', method: 'workspace.new', params: { senderPtyId: 'pty-plain' } });
    expect(guards.fanoutOwnerOf('ws-new')).toBeNull();
  });

  it('mcp.claimWorkspace as the MCP client really sends it ({ name } only) has no pane to inherit from', async () => {
    sendToRendererMock.mockResolvedValue({ ptyId: 'p', workspaceId: 'ws-claimed', workspaceName: 'MCP' });
    const { router, guards } = setup();
    await router.dispatch({ id: '1', method: 'mcp.claimWorkspace', params: { name: 'MCP' } });
    expect(guards.fanoutOwnerOf('ws-claimed')).toBeNull();
  });

  it('refuses, before creating anything, when a stated senderPtyId does not resolve', async () => {
    const { router } = setup();
    const res = await router.dispatch({ id: '1', method: 'workspace.new', params: { senderPtyId: 'pty-gone' } });
    expect(errorOf(res)).toMatch(/does not resolve/);
    expect(sendToRendererMock).not.toHaveBeenCalled();
  });

  it('closes the new workspace and fails when a task caller cannot stamp it', async () => {
    sendToRendererMock.mockResolvedValue({ id: 'ws-new', name: 'x' });
    const { router, guards } = setup();
    vi.spyOn(guards, 'markTask').mockImplementation(() => {
      throw new Error('disk full');
    });
    const res = await router.dispatch({ id: '1', method: 'workspace.new', params: { senderPtyId: 'pty-worker' } });
    expect(errorOf(res)).toMatch(/could not be stamped/);
    expect(sendToRendererMock).toHaveBeenCalledWith(expect.anything(), 'workspace.close', { id: 'ws-new' });
  });

  it('end to end: a workspace a worker created cannot fan out', async () => {
    const { router, guards } = setup();
    sendToRendererMock.mockImplementation(async (_w: unknown, method: string, p?: Record<string, unknown>) => {
      if (method === 'workspace.new') return { id: 'ws-new', name: 'x' };
      if (method === 'input.findOwnerWorkspace') return { workspaceId: PTY_TO_WS[String(p?.ptyId)] ?? null };
      throw new Error(`unexpected renderer call ${method}`);
    });
    await router.dispatch({ id: '1', method: 'workspace.new', params: { senderPtyId: 'pty-worker' } });
    const service = { start: vi.fn(), statusOf: () => ({ state: 'unknown' }) } as unknown as FanOutService;
    const handlers = new Map<string, (p: Record<string, unknown>, c?: unknown) => Promise<unknown>>();
    registerFanOutRpc(
      { register: (m: string, h: (p: Record<string, unknown>, c?: unknown) => Promise<unknown>) => handlers.set(m, h) } as unknown as RpcRouter,
      service,
      () => null,
      { guards, workerPermissionMode: () => 'auto', requireApproval: () => false },
    );
    const res = (await handlers.get('task.fanout.start')!(
      { idempotencyKey: 'k', senderPtyId: 'pty-in-new', titles: ['t'] },
      { origin: 'local' },
    )) as { ok: boolean; error: { code: string; message: string } };
    expect(res.ok).toBe(false);
    expect(res.error.code).toBe('NOT_AUTHORIZED');
    expect(res.error.message).toMatch(/fan-out task of ws-brain/);
  });
});
