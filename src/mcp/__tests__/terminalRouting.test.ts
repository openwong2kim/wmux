import { describe, it, expect, vi } from 'vitest';
import { resolveTerminalRoute, resolveCommanderRoute } from '../terminalRouting';
import type { PidMapLookup, TerminalRoutingDeps } from '../terminalRouting';
import type { PinnedRoute } from '../paneResolver';

/**
 * Build deps with sane defaults. `lookups` is a queue consumed one per call to
 * lookupPidMapWorkspace (last entry repeats if the queue drains, so a single
 * terminal status doesn't need padding). sleep is a no-op spy by default so
 * grace loops don't actually wait.
 */
function makeDeps(
  lookups: PidMapLookup[],
  overrides: Partial<TerminalRoutingDeps> = {},
): { deps: TerminalRoutingDeps; spies: Record<string, ReturnType<typeof vi.fn>> } {
  const queue = [...lookups];
  const lookupPidMapWorkspace = vi.fn(async () =>
    queue.length > 1 ? (queue.shift() as PidMapLookup) : queue[0],
  );
  let cache = '';
  const cacheVerifiedWorkspaceId = vi.fn((wsId: string) => {
    cache = wsId;
  });
  const getCachedVerifiedWorkspaceId = vi.fn(() => cache);
  const claimPinnedRoute = vi.fn(async (): Promise<PinnedRoute> => ({
    ptyId: 'pty-claimed',
    workspaceId: 'ws-claimed',
  }));
  const getPinnedRoute = vi.fn((): PinnedRoute | null => null);
  const sleep = vi.fn(async () => undefined);

  const deps: TerminalRoutingDeps = {
    lookupPidMapWorkspace,
    getCachedVerifiedWorkspaceId,
    cacheVerifiedWorkspaceId,
    getPinnedRoute,
    claimPinnedRoute,
    sleep,
    graceDelayMs: 1,
    ...overrides,
  };
  return {
    deps,
    spies: {
      lookupPidMapWorkspace,
      cacheVerifiedWorkspaceId,
      getCachedVerifiedWorkspaceId,
      claimPinnedRoute,
      getPinnedRoute,
      sleep,
    },
  };
}

describe('resolveTerminalRoute', () => {
  it('① cache hit: uses cached ws, no lookup, no claim', async () => {
    const { deps, spies } = makeDeps([{ status: 'miss' }], {
      getCachedVerifiedWorkspaceId: () => 'ws-cached',
    });
    const route = await resolveTerminalRoute(deps);
    expect(route).toEqual({ workspaceId: 'ws-cached', ptyId: undefined });
    expect(spies.lookupPidMapWorkspace).not.toHaveBeenCalled();
    expect(spies.claimPinnedRoute).not.toHaveBeenCalled();
  });

  it('cache hit preserves an explicit ptyId passthrough', async () => {
    const { deps } = makeDeps([{ status: 'miss' }], {
      getCachedVerifiedWorkspaceId: () => 'ws-cached',
    });
    const route = await resolveTerminalRoute(deps, 'pty-x');
    expect(route).toEqual({ workspaceId: 'ws-cached', ptyId: 'pty-x' });
  });

  it('② first-party hit, ptyId omitted: returns ws and caches it', async () => {
    const { deps, spies } = makeDeps([{ status: 'hit', wsId: 'ws-fp' }]);
    const route = await resolveTerminalRoute(deps);
    expect(route).toEqual({ workspaceId: 'ws-fp', ptyId: undefined });
    expect(spies.cacheVerifiedWorkspaceId).toHaveBeenCalledWith('ws-fp');
    expect(spies.claimPinnedRoute).not.toHaveBeenCalled();
  });

  it('③ first-party hit, explicit ptyId: passes ptyId through (main asserts)', async () => {
    const { deps } = makeDeps([{ status: 'hit', wsId: 'ws-fp' }]);
    const route = await resolveTerminalRoute(deps, 'pty-1');
    expect(route).toEqual({ workspaceId: 'ws-fp', ptyId: 'pty-1' });
  });

  it('R2: a fresh hit beats an existing pin (bounds false-claim blast radius)', async () => {
    const pin: PinnedRoute = { ptyId: 'pty-claimed', workspaceId: 'ws-claimed' };
    const { deps, spies } = makeDeps([{ status: 'hit', wsId: 'ws-real' }], {
      getPinnedRoute: () => pin,
    });
    const route = await resolveTerminalRoute(deps);
    expect(route).toEqual({ workspaceId: 'ws-real', ptyId: undefined });
    expect(spies.claimPinnedRoute).not.toHaveBeenCalled();
  });

  it('R1: stale cache (getter returns "") re-resolves via the PID map', async () => {
    // Simulates callRpc → invalidateWorkspaceId clearing workspaceResolved: the
    // getter returns '' even though a stale id lingers, so we must re-resolve.
    const { deps, spies } = makeDeps([{ status: 'hit', wsId: 'ws-fresh' }], {
      getCachedVerifiedWorkspaceId: () => '',
    });
    const route = await resolveTerminalRoute(deps);
    expect(route.workspaceId).toBe('ws-fresh');
    expect(spies.lookupPidMapWorkspace).toHaveBeenCalled();
  });

  it('④ external miss, ptyId omitted: claims a dedicated route', async () => {
    const { deps, spies } = makeDeps([{ status: 'miss' }]);
    const route = await resolveTerminalRoute(deps);
    expect(route).toEqual({ workspaceId: 'ws-claimed', ptyId: 'pty-claimed' });
    expect(spies.claimPinnedRoute).toHaveBeenCalledTimes(1);
  });

  it('④b external miss, ptyId omitted, pin exists: reuses pin without claiming', async () => {
    const pin: PinnedRoute = { ptyId: 'pty-pinned', workspaceId: 'ws-pinned' };
    const { deps, spies } = makeDeps([{ status: 'miss' }], {
      getPinnedRoute: () => pin,
    });
    const route = await resolveTerminalRoute(deps);
    expect(route).toEqual({ workspaceId: 'ws-pinned', ptyId: 'pty-pinned' });
    expect(spies.claimPinnedRoute).not.toHaveBeenCalled();
  });

  it('⑤ external miss, explicit ptyId, pin exists: pinned ws + explicit ptyId, no claim', async () => {
    // The foreign-ptyId attack lands here: pinned ws ≠ victim ws, so the
    // main-side assert rejects the victim ptyId. A legit pane in the claimed
    // ws passes.
    const pin: PinnedRoute = { ptyId: 'pty-pinned', workspaceId: 'ws-pinned' };
    const { deps, spies } = makeDeps([{ status: 'miss' }], {
      getPinnedRoute: () => pin,
    });
    const route = await resolveTerminalRoute(deps, 'pty-victim');
    expect(route).toEqual({ workspaceId: 'ws-pinned', ptyId: 'pty-victim' });
    expect(spies.claimPinnedRoute).not.toHaveBeenCalled();
  });

  it('⑥ external miss, explicit ptyId, NO pin: fails closed without claiming', async () => {
    const { deps, spies } = makeDeps([{ status: 'miss' }]);
    await expect(resolveTerminalRoute(deps, 'pty-victim')).rejects.toThrow(
      /cannot target an explicit ptyId before claiming/,
    );
    expect(spies.claimPinnedRoute).not.toHaveBeenCalled();
  });

  it('⑦ rpc-down twice then hit: grace recovers, no claim', async () => {
    const { deps, spies } = makeDeps([
      { status: 'rpc-down' },
      { status: 'rpc-down' },
      { status: 'hit', wsId: 'ws-recovered' },
    ]);
    const route = await resolveTerminalRoute(deps);
    expect(route.workspaceId).toBe('ws-recovered');
    expect(spies.sleep).toHaveBeenCalledTimes(2);
    expect(spies.claimPinnedRoute).not.toHaveBeenCalled();
  });

  it('⑧ rpc-down exhausted: throws retryable, no claim', async () => {
    const { deps, spies } = makeDeps([{ status: 'rpc-down' }], {
      rpcDownGraceAttempts: 3,
    });
    await expect(resolveTerminalRoute(deps)).rejects.toThrow(
      /not reachable.*[Rr]etry/,
    );
    expect(spies.claimPinnedRoute).not.toHaveBeenCalled();
    // 3 attempts → 2 sleeps then throw on the 3rd.
    expect(spies.sleep).toHaveBeenCalledTimes(2);
  });

  it('⑨ empty-map exhausted, ptyId omitted: treated as external → claim', async () => {
    const { deps, spies } = makeDeps([{ status: 'empty-map' }], {
      emptyMapGraceAttempts: 2,
    });
    const route = await resolveTerminalRoute(deps);
    expect(route).toEqual({ workspaceId: 'ws-claimed', ptyId: 'pty-claimed' });
    expect(spies.claimPinnedRoute).toHaveBeenCalledTimes(1);
  });

  it('empty-map recovers to hit within grace: no claim', async () => {
    const { deps, spies } = makeDeps([
      { status: 'empty-map' },
      { status: 'hit', wsId: 'ws-late' },
    ]);
    const route = await resolveTerminalRoute(deps);
    expect(route.workspaceId).toBe('ws-late');
    expect(spies.claimPinnedRoute).not.toHaveBeenCalled();
  });

  it('empty-map exhausted, explicit ptyId, no pin: fails closed (parity with ⑥)', async () => {
    const { deps, spies } = makeDeps([{ status: 'empty-map' }], {
      emptyMapGraceAttempts: 2,
    });
    await expect(resolveTerminalRoute(deps, 'pty-victim')).rejects.toThrow(
      /cannot target an explicit ptyId before claiming/,
    );
    expect(spies.claimPinnedRoute).not.toHaveBeenCalled();
  });

  it('⑪ miss is decided immediately — lookup called exactly once, no sleep', async () => {
    const { deps, spies } = makeDeps([{ status: 'miss' }]);
    await resolveTerminalRoute(deps);
    expect(spies.lookupPidMapWorkspace).toHaveBeenCalledTimes(1);
    expect(spies.sleep).not.toHaveBeenCalled();
  });

  it('⑩ never returns an empty workspaceId (hit/claim/pin all non-empty)', async () => {
    for (const scenario of [
      { lookups: [{ status: 'hit', wsId: 'ws-a' }] as PidMapLookup[], pin: null, pty: undefined },
      { lookups: [{ status: 'miss' }] as PidMapLookup[], pin: null, pty: undefined },
      {
        lookups: [{ status: 'miss' }] as PidMapLookup[],
        pin: { ptyId: 'p', workspaceId: 'ws-pin' } as PinnedRoute,
        pty: 'pe',
      },
    ]) {
      const { deps } = makeDeps(scenario.lookups, {
        getPinnedRoute: () => scenario.pin,
      });
      const route = await resolveTerminalRoute(deps, scenario.pty);
      expect(route.workspaceId).toBeTruthy();
      expect(typeof route.workspaceId).toBe('string');
    }
  });
});

// ─── Commander-brain routing (P3b, codex P1) ─────────────────────────────────

describe('resolveCommanderRoute', () => {
  it('resolves the true owning workspace for a live token + explicit ptyId', async () => {
    const sendRpc = vi.fn(async () => ({ workspaceId: 'ws-owner' }));
    const route = await resolveCommanderRoute({
      token: 'tok',
      explicitPtyId: 'pty-9',
      sendRpc,
    });
    expect(route).toEqual({ workspaceId: 'ws-owner', ptyId: 'pty-9' });
    expect(sendRpc).toHaveBeenCalledWith('deck.resolvePaneRoute', {
      token: 'tok',
      ptyId: 'pty-9',
    });
  });

  it('returns null without a token or without an explicit ptyId — no RPC fired', async () => {
    const sendRpc = vi.fn();
    expect(
      await resolveCommanderRoute({ token: undefined, explicitPtyId: 'p', sendRpc }),
    ).toBeNull();
    expect(
      await resolveCommanderRoute({ token: 'tok', explicitPtyId: undefined, sendRpc }),
    ).toBeNull();
    expect(sendRpc).not.toHaveBeenCalled();
  });

  it('falls back to null when the RPC rejects (stale token) or returns no workspace', async () => {
    expect(
      await resolveCommanderRoute({
        token: 'stale',
        explicitPtyId: 'p',
        sendRpc: vi.fn(async () => {
          throw new Error('not a live commander session');
        }),
      }),
    ).toBeNull();
    expect(
      await resolveCommanderRoute({
        token: 'tok',
        explicitPtyId: 'p',
        sendRpc: vi.fn(async () => ({ workspaceId: '' })),
      }),
    ).toBeNull();
  });
});
