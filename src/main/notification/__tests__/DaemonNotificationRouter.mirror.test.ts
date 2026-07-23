import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { DaemonClient } from '../../DaemonClient';
import { eventBus } from '../../events/EventBus';

// WP2: resolveWorkspaceIdForPty consults the main-side WorkspaceMirror before
// its cached `workspace.list` round-trip. A ptyId that still belongs to an open
// pane resolves off the mirror with no renderer IPC; a mirror miss (empty/stale,
// or a ptyId absent from the snapshot) falls back to the cached round-trip.
vi.mock('../../pipe/handlers/_bridge', () => ({ sendToRenderer: vi.fn() }));

import { sendToRenderer } from '../../pipe/handlers/_bridge';
import { DaemonNotificationRouter } from '../DaemonNotificationRouter';
import { WorkspaceMirror } from '../../workspace/WorkspaceMirror';
import { STALE_TRUST_MS } from '../../pipe/handlers/hooks.rpc';
import type { WorkspaceMirrorPushPayload } from '../../../shared/workspaceMirror';

const sendToRendererMock = vi.mocked(sendToRenderer);

const FIXTURE_WORKSPACE_LIST = [
  { id: 'ws-1', name: 'Workspace 1', activePtyId: 'pty-a', ptyIds: ['pty-a', 'pty-b'] },
  { id: 'ws-2', name: 'Workspace 2', activePtyId: 'pty-c', ptyIds: ['pty-c'] },
];

function pushPayload(): WorkspaceMirrorPushPayload {
  return {
    ts: 0,
    entries: [
      { id: 'ws-1', name: 'Workspace 1', metadata: { cwd: '/a' }, activePtyId: 'pty-a', ptyIds: ['pty-a', 'pty-b'] },
      { id: 'ws-2', name: 'Workspace 2', metadata: { cwd: '/b' }, activePtyId: 'pty-c', ptyIds: ['pty-c'] },
    ],
    fleets: [],
  };
}

function makeRouter(now: () => number, mirror: WorkspaceMirror) {
  const fakeDaemon = { on: vi.fn(), off: vi.fn() } as unknown as DaemonClient;
  const router = new DaemonNotificationRouter(fakeDaemon, () => null, undefined, now, () => mirror);
  return { router };
}

function resolve(router: DaemonNotificationRouter, ptyId: string): Promise<string | null> {
  return (router as unknown as {
    resolveWorkspaceIdForPty(ptyId: string): Promise<string | null>;
  }).resolveWorkspaceIdForPty(ptyId);
}

describe('DaemonNotificationRouter — WorkspaceMirror fast path', () => {
  beforeEach(() => {
    sendToRendererMock.mockReset();
    sendToRendererMock.mockResolvedValue(FIXTURE_WORKSPACE_LIST);
    eventBus.reset();
  });

  afterEach(() => {
    eventBus.reset();
  });

  it('mirror hit resolves the ptyId with NO renderer round-trip', async () => {
    let t = 1_000_000;
    const mirror = new WorkspaceMirror(() => t);
    mirror.setSnapshot(pushPayload()); // fresh
    const { router } = makeRouter(() => t, mirror);

    expect(await resolve(router, 'pty-a')).toBe('ws-1');
    expect(await resolve(router, 'pty-c')).toBe('ws-2');
    expect(sendToRendererMock).not.toHaveBeenCalled(); // served off the mirror
  });

  it('mirror miss (ptyId absent from snapshot) falls back to the cached round-trip', async () => {
    let t = 1_000_000;
    const mirror = new WorkspaceMirror(() => t);
    mirror.setSnapshot(pushPayload());
    const { router } = makeRouter(() => t, mirror);

    // 'pty-a' is in the mirror; 'pty-z' is not — only the miss hits the renderer.
    expect(await resolve(router, 'pty-a')).toBe('ws-1');
    expect(sendToRendererMock).not.toHaveBeenCalled();

    expect(await resolve(router, 'pty-z')).toBeNull(); // not in FIXTURE either
    expect(sendToRendererMock).toHaveBeenCalledTimes(1); // fell through to pull
  });

  it('empty mirror (never populated) uses the cached round-trip', async () => {
    let t = 1_000_000;
    const mirror = new WorkspaceMirror(() => t); // never setSnapshot
    const { router } = makeRouter(() => t, mirror);

    expect(await resolve(router, 'pty-a')).toBe('ws-1');
    expect(sendToRendererMock).toHaveBeenCalledTimes(1);
  });

  it('stale mirror (older than STALE_TRUST_MS) falls back to the cached round-trip', async () => {
    let t = 1_000_000;
    const mirror = new WorkspaceMirror(() => t);
    mirror.setSnapshot(pushPayload()); // stamped at t
    t += STALE_TRUST_MS + 1; // now stale
    const { router } = makeRouter(() => t, mirror);

    expect(await resolve(router, 'pty-a')).toBe('ws-1');
    expect(sendToRendererMock).toHaveBeenCalledTimes(1);
  });

  it('mirror hit does not populate/consume the pull cache — invalidate stays a pull-path concern', async () => {
    let t = 1_000_000;
    const mirror = new WorkspaceMirror(() => t);
    mirror.setSnapshot(pushPayload());
    const { router } = makeRouter(() => t, mirror);

    await resolve(router, 'pty-a'); // mirror hit, no fetch
    router.invalidateWorkspaceCache(); // no-op for the pull cache (still empty)
    await resolve(router, 'pty-c'); // mirror hit again
    expect(sendToRendererMock).not.toHaveBeenCalled();
  });
});
