import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RpcRouter } from '../../RpcRouter';

// The handler reaches the renderer twice: once to resolve the caller's pane
// (input.findOwnerWorkspace via _bridge) and once to broadcast the metadata
// payload (metadata.handler → window.webContents.send). Mock both seams so the
// scoping decision is observable without Electron.
vi.mock('../_bridge', () => ({ sendToRenderer: vi.fn() }));
vi.mock('../../../ipc/handlers/metadata.handler', () => ({
  broadcastMetadataUpdate: vi.fn(),
}));

import { registerMetaRpc } from '../meta.rpc';
import { sendToRenderer } from '../_bridge';
import { broadcastMetadataUpdate } from '../../../ipc/handlers/metadata.handler';

const win = { isDestroyed: () => false } as never;
const getWindow = () => win;

function setup(): RpcRouter {
  const router = new RpcRouter();
  registerMetaRpc(router, getWindow);
  return router;
}

/** The payload the renderer would receive, or null when nothing was sent. */
function sentPayload(): Record<string, unknown> | null {
  const mock = vi.mocked(broadcastMetadataUpdate);
  if (mock.mock.calls.length === 0) return null;
  return mock.mock.calls.at(-1)![1] as unknown as Record<string, unknown>;
}

/** Resolve senderPtyId 'pty-<x>' → workspace 'ws-<x>'; anything else is unknown. */
function ownerResolver(known: Record<string, string>): void {
  vi.mocked(sendToRenderer).mockImplementation(
    async (_win: unknown, method: string, params?: unknown) => {
      if (method !== 'input.findOwnerWorkspace') return null;
      const ptyId = (params as { ptyId?: string } | undefined)?.ptyId ?? '';
      const workspaceId = known[ptyId];
      return workspaceId ? { workspaceId } : null;
    },
  );
}

describe('meta.rpc — U8 workspace scoping', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ownerResolver({ 'pty-a': 'ws-a', 'pty-b': 'ws-b' });
  });

  describe('external callers (agents / MCP)', () => {
    it('scopes meta.setStatus to the senderPtyId-resolved workspace', async () => {
      const router = setup();
      const res = await router.dispatch({
        id: '1',
        method: 'meta.setStatus',
        params: { text: 'building', senderPtyId: 'pty-b' },
      });
      expect(res.ok).toBe(true);
      expect(sentPayload()).toMatchObject({ status: 'building', workspaceId: 'ws-b' });
    });

    it('IGNORES a forged workspaceId and uses the resolved one (the U8 core)', async () => {
      const router = setup();
      await router.dispatch({
        id: '2',
        method: 'meta.setStatus',
        params: { text: 'owned', senderPtyId: 'pty-a', workspaceId: 'ws-victim' },
      });
      expect(sentPayload()).toMatchObject({ workspaceId: 'ws-a' });
      expect(sentPayload()!['workspaceId']).not.toBe('ws-victim');
    });

    it('scopes meta.setProgress the same way and clamps the value', async () => {
      const router = setup();
      await router.dispatch({
        id: '3',
        method: 'meta.setProgress',
        params: { value: 250, senderPtyId: 'pty-b', workspaceId: 'ws-victim' },
      });
      expect(sentPayload()).toMatchObject({ progress: 100, workspaceId: 'ws-b' });
    });

    it('clamps a negative progress to 0', async () => {
      const router = setup();
      await router.dispatch({
        id: '4',
        method: 'meta.setProgress',
        params: { value: -5, senderPtyId: 'pty-a' },
      });
      expect(sentPayload()).toMatchObject({ progress: 0, workspaceId: 'ws-a' });
    });

    // FAIL-CLOSED. The renderer applies a workspace-less payload to
    // `activeWorkspaceId` (useNotificationListener: payloadWsId ??
    // state.activeWorkspaceId), so returning `undefined` here would write into
    // whichever workspace the human is looking at. These four cases must
    // therefore be refused, and nothing may reach the renderer.
    it('REFUSES an external caller that sends no senderPtyId', async () => {
      const router = setup();
      const res = await router.dispatch({
        id: '5',
        method: 'meta.setStatus',
        params: { text: 'unscoped' },
      });
      expect(res.ok).toBe(false);
      expect(broadcastMetadataUpdate).not.toHaveBeenCalled();
    });

    it('REFUSES an external caller whose senderPtyId does not resolve', async () => {
      const router = setup();
      const res = await router.dispatch({
        id: '6',
        method: 'meta.setStatus',
        params: { text: 'ghost', senderPtyId: 'pty-nowhere' },
      });
      expect(res.ok).toBe(false);
      expect(broadcastMetadataUpdate).not.toHaveBeenCalled();
    });

    it('REFUSES an unscoped caller even when it supplies a workspaceId', async () => {
      const router = setup();
      const res = await router.dispatch({
        id: '7',
        method: 'meta.setProgress',
        params: { value: 50, workspaceId: 'ws-victim' },
      });
      expect(res.ok).toBe(false);
      expect(broadcastMetadataUpdate).not.toHaveBeenCalled();
    });

    it('REFUSES when the renderer resolution throws', async () => {
      vi.mocked(sendToRenderer).mockRejectedValue(new Error('renderer gone'));
      const router = setup();
      const res = await router.dispatch({
        id: '8',
        method: 'meta.setStatus',
        params: { text: 'x', senderPtyId: 'pty-a' },
      });
      expect(res.ok).toBe(false);
      expect(broadcastMetadataUpdate).not.toHaveBeenCalled();
    });
  });

  describe('first-party caller (renderer bridge)', () => {
    it('honours the caller-supplied workspaceId without any pane resolution', async () => {
      const router = setup();
      const res = await router.dispatch(
        { id: '9', method: 'meta.setStatus', params: { text: 'ok', workspaceId: 'ws-chosen' } },
        { firstParty: true },
      );
      expect(res.ok).toBe(true);
      expect(sentPayload()).toMatchObject({ status: 'ok', workspaceId: 'ws-chosen' });
      // The trusted operator surface must not pay for a renderer round-trip.
      expect(sendToRenderer).not.toHaveBeenCalled();
    });

    it('keeps the active-workspace default for a first-party call with no workspaceId', async () => {
      const router = setup();
      const res = await router.dispatch(
        { id: '10', method: 'meta.setProgress', params: { value: 42 } },
        { firstParty: true },
      );
      expect(res.ok).toBe(true);
      expect(sentPayload()).toMatchObject({ progress: 42 });
      expect(sentPayload()!['workspaceId']).toBeUndefined();
    });
  });

  describe('param validation (unchanged)', () => {
    it('rejects a non-string text', async () => {
      const router = setup();
      const res = await router.dispatch(
        { id: '11', method: 'meta.setStatus', params: { text: 5 } },
        { firstParty: true },
      );
      expect(res.ok).toBe(false);
    });

    it('rejects a non-number value', async () => {
      const router = setup();
      const res = await router.dispatch(
        { id: '12', method: 'meta.setProgress', params: { value: 'high' } },
        { firstParty: true },
      );
      expect(res.ok).toBe(false);
    });
  });
});
