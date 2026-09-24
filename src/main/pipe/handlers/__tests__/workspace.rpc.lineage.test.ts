// Depth-1 lineage inheritance: a workspace created FROM a fan-out task
// workspace is itself a task of the same owner, so "open a new workspace and
// fan out from there" does not step around the one-level limit.

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserWindow } from 'electron';
import { RpcRouter } from '../../RpcRouter';
import { registerWorkspaceRpc } from '../workspace.rpc';
import { FanOutGuards } from '../../../worktask/fanoutGuards';

const { sendToRendererMock } = vi.hoisted(() => ({ sendToRendererMock: vi.fn() }));
vi.mock('../_bridge', () => ({ sendToRenderer: sendToRendererMock }));

const fakeWindow = {} as BrowserWindow;
const PTY_TO_WS: Record<string, string> = { 'pty-worker': 'ws-task', 'pty-plain': 'ws-plain' };

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

  it('mcp.claimWorkspace from a task pane is stamped too', async () => {
    sendToRendererMock.mockResolvedValue({ ptyId: 'p', workspaceId: 'ws-claimed', workspaceName: 'MCP' });
    const { router, guards } = setup();
    await router.dispatch({ id: '1', method: 'mcp.claimWorkspace', params: { senderPtyId: 'pty-worker' } });
    expect(guards.fanoutOwnerOf('ws-claimed')).toBe('ws-brain');
  });

  it('a workspace created from an ordinary pane stays unstamped', async () => {
    sendToRendererMock.mockResolvedValue({ id: 'ws-new', name: 'x' });
    const { router, guards } = setup();
    await router.dispatch({ id: '1', method: 'workspace.new', params: { senderPtyId: 'pty-plain' } });
    expect(guards.fanoutOwnerOf('ws-new')).toBeNull();
  });
});
