import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { DaemonClient } from '../../DaemonClient';
import { eventBus } from '../../events/EventBus';

// Mock the renderer IPC layer so we can count workspace.list round-trips
// without spinning up an Electron BrowserWindow. The mock returns a fixed
// shape; each call increments the spy counter so cache hits are observable.
vi.mock('../../pipe/handlers/_bridge', () => ({
  sendToRenderer: vi.fn(),
}));

// Imported after vi.mock so the module sees the mocked dependency.
import { sendToRenderer } from '../../pipe/handlers/_bridge';
import { DaemonNotificationRouter } from '../DaemonNotificationRouter';

const sendToRendererMock = vi.mocked(sendToRenderer);

const FIXTURE_WORKSPACE_LIST = [
  { id: 'ws-1', name: 'Workspace 1', activePtyId: 'pty-a', ptyIds: ['pty-a', 'pty-b'] },
  { id: 'ws-2', name: 'Workspace 2', activePtyId: 'pty-c', ptyIds: ['pty-c'] },
];

function makeRouter(now: () => number) {
  const fakeDaemon = {
    on: vi.fn(),
    off: vi.fn(),
  } as unknown as DaemonClient;
  const router = new DaemonNotificationRouter(fakeDaemon, () => null, undefined, now);
  return { router, fakeDaemon };
}

// Accessor for the private resolveWorkspaceIdForPty so the test can exercise
// the cache without needing to round-trip through emitDetectorLifecycle (which
// would also drag in EventBus + ledger surface unrelated to the cache).
function resolve(router: DaemonNotificationRouter, ptyId: string): Promise<string | null> {
  return (router as unknown as {
    resolveWorkspaceIdForPty(ptyId: string): Promise<string | null>;
  }).resolveWorkspaceIdForPty(ptyId);
}

describe('DaemonNotificationRouter workspace.list cache', () => {
  beforeEach(() => {
    sendToRendererMock.mockReset();
    sendToRendererMock.mockResolvedValue(FIXTURE_WORKSPACE_LIST);
    eventBus.reset();
  });

  afterEach(() => {
    eventBus.reset();
  });

  it('first lookup fetches workspace.list; second lookup within TTL is served from cache', async () => {
    let t = 1_000_000;
    const { router } = makeRouter(() => t);

    expect(await resolve(router, 'pty-a')).toBe('ws-1');
    expect(sendToRendererMock).toHaveBeenCalledTimes(1);

    // 500ms later — still inside the 2s TTL.
    t += 500;
    expect(await resolve(router, 'pty-c')).toBe('ws-2');
    expect(sendToRendererMock).toHaveBeenCalledTimes(1);
  });

  it('refetches once the TTL window has elapsed', async () => {
    let t = 1_000_000;
    const { router } = makeRouter(() => t);

    expect(await resolve(router, 'pty-a')).toBe('ws-1');
    expect(sendToRendererMock).toHaveBeenCalledTimes(1);

    // 2_001ms after the cached fetch — strictly outside the 2s window.
    t += 2_001;
    expect(await resolve(router, 'pty-a')).toBe('ws-1');
    expect(sendToRendererMock).toHaveBeenCalledTimes(2);
  });

  it('invalidateWorkspaceCache() forces the next lookup to refetch', async () => {
    const t = 1_000_000;
    const { router } = makeRouter(() => t);

    await resolve(router, 'pty-a');
    expect(sendToRendererMock).toHaveBeenCalledTimes(1);

    router.invalidateWorkspaceCache();
    await resolve(router, 'pty-a');
    expect(sendToRendererMock).toHaveBeenCalledTimes(2);
  });

  it('workspace.metadata.changed EventBus emit invalidates the cache via start() subscription', async () => {
    let t = 1_000_000;
    const { router } = makeRouter(() => t);

    router.start();
    try {
      await resolve(router, 'pty-a');
      expect(sendToRendererMock).toHaveBeenCalledTimes(1);

      eventBus.emit({
        type: 'workspace.metadata.changed',
        workspaceId: 'ws-1',
        metadata: {} as never,
        patch: {},
      });

      // Within TTL but cache was wiped — should refetch.
      t += 100;
      await resolve(router, 'pty-a');
      expect(sendToRendererMock).toHaveBeenCalledTimes(2);
    } finally {
      router.stop();
    }
  });

  it('unrelated EventBus emits (e.g. pane.created) do not invalidate the cache', async () => {
    let t = 1_000_000;
    const { router } = makeRouter(() => t);

    router.start();
    try {
      await resolve(router, 'pty-a');
      expect(sendToRendererMock).toHaveBeenCalledTimes(1);

      eventBus.emit({ type: 'pane.created', workspaceId: 'ws-1', paneId: 'pane-x' });

      t += 100;
      await resolve(router, 'pty-a');
      // Still 1 — pane.created should not have wiped the cache.
      expect(sendToRendererMock).toHaveBeenCalledTimes(1);
    } finally {
      router.stop();
    }
  });

  it('stop() drops the cache so a restarted router does not serve stale entries', async () => {
    let t = 1_000_000;
    const { router } = makeRouter(() => t);

    await resolve(router, 'pty-a');
    expect(sendToRendererMock).toHaveBeenCalledTimes(1);

    router.stop();
    // Even within TTL, post-stop lookup must refetch.
    t += 100;
    await resolve(router, 'pty-a');
    expect(sendToRendererMock).toHaveBeenCalledTimes(2);
  });

  it('IPC failure does not poison the cache — next call retries', async () => {
    let t = 1_000_000;
    const { router } = makeRouter(() => t);

    sendToRendererMock.mockRejectedValueOnce(new Error('renderer detached'));
    expect(await resolve(router, 'pty-a')).toBeNull();
    expect(sendToRendererMock).toHaveBeenCalledTimes(1);

    sendToRendererMock.mockResolvedValueOnce(FIXTURE_WORKSPACE_LIST);
    t += 100;
    expect(await resolve(router, 'pty-a')).toBe('ws-1');
    expect(sendToRendererMock).toHaveBeenCalledTimes(2);
  });
});
