// The browser action cache is the one browser surface that is fail-closed in
// BOTH enforcement modes.
//
// Every other browser method falls back to the caller-supplied workspaceId
// while `mcp.mode` is 'shadow', which is the right trade there: the
// alternative is breaking automation that already works. It is the wrong trade
// for a store that shipped with this feature, because there is no working
// behaviour to preserve and the fallback would let any caller read and
// overwrite another workspace's recorded flows just by naming it.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserWindow } from 'electron';
import type { RpcContext } from '../../../../shared/rpc';
import { RpcRouter } from '../../RpcRouter';
import { registerBrowserRpc } from '../browser.rpc';
import {
  __resetWorkspaceClaimTrustForTesting,
} from '../../../workspace/workspaceClaimTrust';

vi.mock('electron', () => ({
  webContents: { fromId: vi.fn(() => null) },
  shell: { openExternal: vi.fn() },
}));

vi.mock('../_bridge', () => ({ sendToRenderer: vi.fn() }));

const CACHE_METHODS = [
  'browser.actionCache.list',
  'browser.actionCache.get',
  'browser.actionCache.put',
  'browser.actionCache.stats',
  'browser.actionCache.forget',
  // Promotion writes a permanent, hint-announced store, so it is held to the
  // same fail-closed scope rule as the cache rather than a weaker one.
  'browser.actionCache.promote',
  'browser.actionCache.demote',
  'browser.actionCache.promoted',
] as const;

function register(enforcementMode: 'shadow' | 'enforce'): RpcRouter {
  const router = new RpcRouter();
  const webviewCdpManager = {
    getTarget: vi.fn(() => null),
    listTargets: vi.fn(() => []),
    getCdpPort: vi.fn(() => 18800),
    waitForTarget: vi.fn(),
    ensureAwake: vi.fn(async () => null),
    setCaptureCleanup: vi.fn(),
    setCaptureAttach: vi.fn(),
    withAutomationLease: vi.fn(async (_s: string, fn: () => Promise<unknown>) => fn()),
    acquireRpcLease: vi.fn(() => 'lease-1'),
    renewRpcLease: vi.fn(() => true),
    releaseRpcLease: vi.fn(() => true),
  };
  registerBrowserRpc(
    router,
    (() => null) as unknown as () => BrowserWindow | null,
    webviewCdpManager as never,
    undefined,
    undefined,
    () => enforcementMode,
  );
  return router;
}

/** A wire caller that has claimed nothing — the 'legacy' lane. */
function legacyCtx(): RpcContext {
  return { origin: 'local', externalWire: true, clientName: 'some-plugin' };
}

/** The renderer. wmux itself, so it is trusted with the workspace it names. */
function operatorCtx(): RpcContext {
  return { origin: 'local', operator: true };
}

async function dispatch(
  router: RpcRouter,
  method: string,
  params: Record<string, unknown>,
  ctx: RpcContext | undefined,
) {
  // The dispatch options type is a discriminated union over the lane markers;
  // these fixtures name whole RpcContexts, which is the shape the handler sees.
  const res = await router.dispatch({ id: '1', method: method as never, params }, ctx as never);
  // RpcResponse is a discriminated union; every case here asserts on one side
  // or the other, so widen once here rather than narrowing at each call.
  return res as { ok: boolean; error?: string; result?: unknown };
}

beforeEach(() => {
  __resetWorkspaceClaimTrustForTesting();
});

describe('browser.actionCache.* — verified scope only', () => {
  for (const mode of ['shadow', 'enforce'] as const) {
    it(`refuses a legacy caller that names a workspace, in ${mode} mode`, async () => {
      const router = register(mode);
      for (const method of CACHE_METHODS) {
        const res = await dispatch(
          router,
          method,
          { workspaceId: 'ws-someone-else', name: 'flow' },
          legacyCtx(),
        );
        expect(res.error, `${method} accepted an unverified workspace in ${mode} mode`).toBeTruthy();
        expect(String(res.error)).toContain('could not be verified');
      }
    });
  }

  it('refuses a caller with no context at all', async () => {
    const router = register('shadow');
    const res = await dispatch(router, 'browser.actionCache.list', {}, undefined as never);
    expect(res.error).toBeTruthy();
  });

  it('serves the renderer operator, which is wmux itself', async () => {
    const router = register('shadow');
    const res = await dispatch(
      router,
      'browser.actionCache.list',
      { workspaceId: 'ws-1' },
      operatorCtx(),
    );
    expect(res.error).toBeFalsy();
    expect(res.result).toEqual({ traces: [] });
  });

  it('refuses the operator lane too when it names no workspace', async () => {
    // 'allowed' with no workspaceId is "any workspace", which is meaningless
    // for a per-workspace store — it would have to pick one.
    const router = register('shadow');
    const res = await dispatch(router, 'browser.actionCache.list', {}, operatorCtx());
    expect(res.error).toBeTruthy();
  });

  it('names the refusal so an agent is not left guessing', async () => {
    const router = register('enforce');
    const res = await dispatch(router, 'browser.actionCache.get', { name: 'flow' }, legacyCtx());
    expect(String(res.error)).toContain('browser.actionCache.get');
    expect(String(res.error)).toContain('never served on an unverified scope');
  });
});

describe('browser.actionCache.promote — the gate', () => {
  // These cases all stop before any file is written: promote resolves the
  // trace from the (empty) action cache first, so the store is never reached.
  it('refuses to promote a flow that was never recorded', async () => {
    const router = register('shadow');
    const res = await dispatch(
      router,
      'browser.actionCache.promote',
      { workspaceId: 'ws-1', name: 'never-saved' },
      operatorCtx(),
    );
    expect(res.error).toBeFalsy();
    expect(res.result).toMatchObject({ ok: false });
    expect(String((res.result as { reason: string }).reason)).toContain('no flow named');
  });

  it('refuses to demote a flow that is not promoted', async () => {
    const router = register('shadow');
    const res = await dispatch(
      router,
      'browser.actionCache.demote',
      { workspaceId: 'ws-1', name: 'never-promoted' },
      operatorCtx(),
    );
    expect(res.result).toMatchObject({ ok: false });
    expect(String((res.result as { reason: string }).reason)).toContain('not promoted');
  });

  it('lists nothing for a workspace that has promoted nothing', async () => {
    const router = register('shadow');
    const res = await dispatch(
      router,
      'browser.actionCache.promoted',
      { workspaceId: 'ws-nothing-here', urlKey: 'https://example.com/x' },
      operatorCtx(),
    );
    expect(res.result).toEqual({ promoted: [] });
  });
});
