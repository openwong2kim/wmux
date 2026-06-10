import { beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import type { BrowserWindow } from 'electron';
import { RpcRouter } from '../../RpcRouter';
import { registerInputRpc } from '../input.rpc';
import type { PTYManager } from '../../../pty/PTYManager';

// Mock the renderer bridge so we can drive input.findOwnerWorkspace (the
// ownership oracle assertWorkspaceOwnsPty consults) and input.readScreen (the
// viewport read) without a real BrowserWindow.
const { sendToRendererMock } = vi.hoisted(() => ({ sendToRendererMock: vi.fn() }));
vi.mock('../_bridge', () => ({ sendToRenderer: sendToRendererMock }));

const fakeWindow = {} as BrowserWindow;
const fakePty = {} as PTYManager;

function setup(): RpcRouter {
  const router = new RpcRouter();
  registerInputRpc(router, fakePty, () => fakeWindow);
  return router;
}

// Regression guard for issue #163: input.readScreen was the lone terminal-IO
// handler missing assertWorkspaceOwnsPty, letting a caller that names another
// workspace + a foreign ptyId read that workspace's viewport.
describe('input.readScreen — cross-workspace ownership (issue #163)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('rejects an explicit-ptyId read owned by a different workspace, before any viewport read', async () => {
    sendToRendererMock.mockImplementation((_w: unknown, method: string) => {
      if (method === 'input.findOwnerWorkspace') {
        // The ptyId genuinely belongs to the victim ws (the crux of the bug).
        return Promise.resolve({ workspaceId: 'ws-victim' });
      }
      return Promise.resolve({ ptyId: 'daemon-victim', text: 'SECRET' });
    });

    const res = await setup().dispatch({
      id: '1',
      method: 'input.readScreen',
      params: { workspaceId: 'ws-attacker', ptyId: 'daemon-victim' },
    });

    expect(res.ok).toBe(false);
    // The ownership check ran...
    expect(sendToRendererMock).toHaveBeenCalledWith(
      expect.anything(),
      'input.findOwnerWorkspace',
      { ptyId: 'daemon-victim' },
    );
    // ...and the viewport read never happened (assert-before-read).
    expect(sendToRendererMock).not.toHaveBeenCalledWith(
      expect.anything(),
      'input.readScreen',
      expect.anything(),
    );
  });

  it('allows a read when the caller workspace owns the ptyId', async () => {
    sendToRendererMock.mockImplementation(
      (_w: unknown, method: string, params?: { ptyId?: string }) => {
        if (method === 'input.findOwnerWorkspace') return Promise.resolve({ workspaceId: 'ws-A' });
        return Promise.resolve({ ptyId: params?.ptyId ?? 'daemon-A', text: 'mine' });
      },
    );

    const res = await setup().dispatch({
      id: '2',
      method: 'input.readScreen',
      params: { workspaceId: 'ws-A', ptyId: 'daemon-A' },
    });

    expect(res.ok).toBe(true);
    expect(sendToRendererMock).toHaveBeenCalledWith(
      expect.anything(),
      'input.readScreen',
      expect.objectContaining({ ptyId: 'daemon-A' }),
    );
  });

  it('skips the ownership check for internal callers that pass no workspaceId (CLI/UI)', async () => {
    sendToRendererMock.mockImplementation(
      (_w: unknown, method: string, params?: { ptyId?: string }) => {
        if (method === 'input.findOwnerWorkspace') {
          return Promise.reject(new Error('findOwnerWorkspace must not be called for internal callers'));
        }
        return Promise.resolve({ ptyId: params?.ptyId ?? 'daemon-A', text: 'cli' });
      },
    );

    const res = await setup().dispatch({
      id: '3',
      method: 'input.readScreen',
      params: { ptyId: 'daemon-A' },
    });

    expect(res.ok).toBe(true);
    expect(sendToRendererMock).not.toHaveBeenCalledWith(
      expect.anything(),
      'input.findOwnerWorkspace',
      expect.anything(),
    );
  });

  it('reads the caller workspace active pane when ptyId is omitted, independent of UI focus', async () => {
    // Regression guard (PR review): the renderer scopes the active-pane lookup
    // to params.workspaceId, so a legit caller naming its own ws must read its
    // own active pane even when the user's UI focus is on another workspace.
    // Resolving via a workspaceId-less resolveActivePtyId would read the
    // UI-focused pane and wrongly reject this caller.
    sendToRendererMock.mockImplementation((_w: unknown, method: string) => {
      if (method === 'input.readScreen') return Promise.resolve({ ptyId: 'daemon-self', text: 'mine' });
      if (method === 'input.findOwnerWorkspace') return Promise.resolve({ workspaceId: 'ws-self' });
      return Promise.resolve(null);
    });

    const res = await setup().dispatch({
      id: '4',
      method: 'input.readScreen',
      params: { workspaceId: 'ws-self' },
    });

    expect(res.ok).toBe(true);
    // the read forwarded workspaceId so the renderer scopes the lookup to it,
    // not to a focus-based default.
    expect(sendToRendererMock).toHaveBeenCalledWith(
      expect.anything(),
      'input.readScreen',
      expect.objectContaining({ workspaceId: 'ws-self' }),
    );
  });
});

// Source-level invariant lock (issue #163, requested in the issue). All four
// terminal-IO RPC handlers must call assertWorkspaceOwnsPty before delegating
// to the renderer. input.readScreen was the one that silently skipped it; this
// pins parity so a future handler can't regress the same way. Keys off source
// text rather than behavior so it catches a NEW handler that forgets the check.
describe('input.rpc — assertWorkspaceOwnsPty parity (source invariant)', () => {
  const rawSrc = fs.readFileSync(path.join(__dirname, '..', 'input.rpc.ts'), 'utf-8');
  const src = rawSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

  // Slice a single router.register('name', ...) block, bounded by the next
  // router.register( (or end of file for the last one).
  function handlerBlock(method: string): string {
    const start = src.indexOf(`router.register('${method}'`);
    expect(start, `handler ${method} must exist`).toBeGreaterThan(0);
    const next = src.indexOf('router.register(', start + method.length + 20);
    return src.slice(start, next > start ? next : src.length);
  }

  for (const method of ['input.send', 'input.sendKey', 'input.readScreen', 'terminal.readEvents']) {
    it(`${method} calls assertWorkspaceOwnsPty`, () => {
      expect(handlerBlock(method)).toMatch(/assertWorkspaceOwnsPty\(/);
    });
  }
});
