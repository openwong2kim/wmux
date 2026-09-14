import { beforeEach, describe, expect, it, vi } from 'vitest';

/*
 * One resolved surface for the whole operation.
 *
 * A call that omits surfaceId used to leave every lane to decide for itself,
 * and they disagreed: the Playwright engine took the workspace's NEWEST
 * surface, while main's automation lease and the RPC fallback resolved the
 * workspace's OLDEST live session (WebviewCdpManager.getTarget with no
 * surfaceId returns the first). So one call could lease one tab and drive
 * another, and two connections in one workspace shared both.
 *
 * requireBrowserTargetScope now resolves the surface ONCE, per connection, and
 * freezes it into the scope every lane reads — including the cache and dedupe
 * keys derived from it.
 */

const { mockSendRpc } = vi.hoisted(() => ({ mockSendRpc: vi.fn() }));
vi.mock('../../wmux-client', () => ({
  sendRpc: (...args: unknown[]) => mockSendRpc(...args),
}));

import { createConnectionScope, runInConnectionScope } from '../../connectionScope';
import { requireBrowserTargetScope, sendScopedBrowserRpc } from '../browserScope';
import { browserScopeKey } from '../snapshot';
import { snapshotSurfaceKey } from '../snapshotCache';
import {
  __resetSurfaceRoutingForTesting,
  getOpenerKey,
  noteOpenedSurface,
} from '../surfaceRouting';

const deps = { resolveWorkspaceId: async () => 'ws-1' };

/** A main that reports these targets to every caller of the workspace. */
function mainWith(targets: Array<{ surfaceId: string; opener?: 'mine' | 'other' }>) {
  mockSendRpc.mockImplementation((method: string) =>
    method === 'browser.cdp.info'
      ? Promise.resolve({ targetsScoped: true, targets })
      : Promise.resolve({ ok: true }),
  );
}

beforeEach(() => {
  mockSendRpc.mockReset();
  __resetSurfaceRoutingForTesting();
});

describe('requireBrowserTargetScope default resolution', () => {
  it('pins the resolved surface into the scope every lane reads', async () => {
    const connection = createConnectionScope();
    runInConnectionScope(connection, () => noteOpenedSurface('ws-1', 'surf-mine'));
    mainWith([{ surfaceId: 'surf-theirs', opener: 'other' }, { surfaceId: 'surf-mine', opener: 'mine' }]);

    const scope = await runInConnectionScope(connection, () => requireBrowserTargetScope(deps));

    expect(scope).toEqual({ workspaceId: 'ws-1', surfaceId: 'surf-mine' });

    // The lease and the RPC fallback ride on the same scope, so both now name
    // the surface the page lane resolved instead of main's own default.
    mockSendRpc.mockClear();
    await sendScopedBrowserRpc('browser.lease.acquire', scope);
    await sendScopedBrowserRpc('browser.evaluate', scope, { expression: '1' });
    expect(mockSendRpc).toHaveBeenNthCalledWith(1, 'browser.lease.acquire', {
      workspaceId: 'ws-1',
      surfaceId: 'surf-mine',
    });
    expect(mockSendRpc).toHaveBeenNthCalledWith(2, 'browser.evaluate', {
      expression: '1',
      workspaceId: 'ws-1',
      surfaceId: 'surf-mine',
    });
  });

  it('gives two connections on two tabs different cache and dedupe keys', async () => {
    const a = createConnectionScope();
    const b = createConnectionScope();
    runInConnectionScope(a, () => noteOpenedSurface('ws-1', 'surf-a'));
    runInConnectionScope(b, () => noteOpenedSurface('ws-1', 'surf-b'));
    mainWith([{ surfaceId: 'surf-a', opener: 'mine' }, { surfaceId: 'surf-b', opener: 'mine' }]);

    const scopeA = await runInConnectionScope(a, () => requireBrowserTargetScope(deps));
    const scopeB = await runInConnectionScope(b, () => requireBrowserTargetScope(deps));

    expect(scopeA.surfaceId).toBe('surf-a');
    expect(scopeB.surfaceId).toBe('surf-b');
    // Snapshot baselines, frame refs and the replay ring are all keyed off the
    // scope, so a resolved surface is what keeps one agent's baseline from
    // being diffed against the other agent's page.
    expect(browserScopeKey(scopeA)).not.toBe(browserScopeKey(scopeB));
    expect(snapshotSurfaceKey(scopeA.workspaceId, scopeA.surfaceId)).not.toBe(
      snapshotSurfaceKey(scopeB.workspaceId, scopeB.surfaceId),
    );
  });

  it('leaves an explicit surfaceId untouched and asks nothing', async () => {
    mainWith([{ surfaceId: 'surf-mine' }]);

    const scope = await requireBrowserTargetScope(deps, 'surf-explicit');

    expect(scope).toEqual({ workspaceId: 'ws-1', surfaceId: 'surf-explicit' });
    // No routing round trip: the caller already said where it wants to go.
    expect(mockSendRpc).not.toHaveBeenCalled();
  });

  it('marks the scope when every live surface belongs to somebody else', async () => {
    mainWith([{ surfaceId: 'surf-theirs', opener: 'other' }]);

    const scope = await requireBrowserTargetScope(deps);

    // Not merely "no surface": the markers say routing RAN and found only
    // other connections' tabs, which is what makes an unnamed RPC wrong rather
    // than vague. The lanes read them — the page lane to skip re-asking, the
    // RPC lane to open its own surface or refuse.
    expect(scope).toEqual({ workspaceId: 'ws-1', noSurface: true, foreignSurfaces: 1 });
  });

  it('uses this connection\'s pin when routing cannot reach main', async () => {
    // Swallowing a routing failure into "no surface" would silently restore
    // the pre-fix behavior — permanently, on a build with CDP disabled. The
    // pin is what this connection already knows, so it answers instead, and
    // the replay ring's scope key stays continuous across the hiccup.
    const connection = createConnectionScope();
    runInConnectionScope(connection, () => noteOpenedSurface('ws-1', 'surf-mine'));
    mockSendRpc.mockRejectedValue(new Error('pipe closed'));

    await expect(
      runInConnectionScope(connection, () => requireBrowserTargetScope(deps)),
    ).resolves.toEqual({ workspaceId: 'ws-1', surfaceId: 'surf-mine' });
  });

  it('stays unpinned — never refuses — when routing cannot reach main and it has no pin', async () => {
    // Resolution is routing, not a gate: tools that never needed a live
    // surface (browser_replay note, promote, demote) must not start failing
    // because the control plane hiccuped. The engine's own selection, which
    // fails closed, still decides for the tools that do need a page.
    mockSendRpc.mockRejectedValue(new Error('pipe closed'));

    await expect(requireBrowserTargetScope(deps)).resolves.toEqual({ workspaceId: 'ws-1' });
  });

  it('still refuses an empty workspace identity', async () => {
    await expect(
      requireBrowserTargetScope({ resolveWorkspaceId: async () => '' }),
    ).rejects.toThrow('WORKSPACE_SCOPE_UNRESOLVED');
  });
});
