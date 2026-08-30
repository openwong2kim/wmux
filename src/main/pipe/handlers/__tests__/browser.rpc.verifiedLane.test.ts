// #922 PR-B — the `verified` lane, and the owner's (c) ruling on `legacy`.
//
// Two changes to one table, with opposite blast radiuses:
//
//   verified  NEW. A wire caller that claimed a workspace is scoped to the one
//             it claimed. The binding comes from the registry main wrote at
//             claim time, so unlike `declared` the workspace is not something
//             the caller asserted. A stale claim is REFUSED, never demoted.
//
//   legacy    NARROWED, not closed. A legacy caller that NAMES a workspace is
//             unchanged byte for byte. One that names nothing used to reach the
//             workspace-blind "first registered surface" lookup; that case is
//             refused now. The grandfather itself stays — closing it belongs to
//             the shared deprecation clock (#1111).
//
// The four regressions this file exists to pin are called out by name below.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserWindow } from 'electron';
import type { RpcContext } from '../../../../shared/rpc';
import { RpcRouter } from '../../RpcRouter';
import { callerScope } from '../browser.rpc';
import { registerWorkspaceRpc } from '../workspace.rpc';
import {
  __resetWorkspaceClaimTrustForTesting,
  mintWorkspaceClaimToken,
} from '../../../workspace/workspaceClaimTrust';

const CLAIMED = 'ws-claimed';
const OTHER = 'ws-other';

/** A wire caller, the only kind either lane change applies to. */
function wireCtx(over: Partial<RpcContext> = {}): RpcContext {
  return { origin: 'local', externalWire: true, clientName: 'claude-code', ...over };
}

beforeEach(() => {
  __resetWorkspaceClaimTrustForTesting();
});

describe('callerScope — verified lane', () => {
  it('resolves an omitted workspaceId to the claimed workspace', () => {
    expect(
      callerScope(wireCtx({ workspaceClaim: { kind: 'bound', workspaceId: CLAIMED } }), {}),
    ).toEqual({ kind: 'scoped', lane: 'verified', workspaceId: CLAIMED });
  });

  it('accepts a caller naming the workspace it actually claimed', () => {
    expect(
      callerScope(wireCtx({ workspaceClaim: { kind: 'bound', workspaceId: CLAIMED } }), {
        workspaceId: CLAIMED,
      }),
    ).toEqual({ kind: 'scoped', lane: 'verified', workspaceId: CLAIMED });
  });

  it('refuses a caller naming a workspace it did not claim', () => {
    expect(
      callerScope(wireCtx({ workspaceClaim: { kind: 'bound', workspaceId: CLAIMED } }), {
        workspaceId: OTHER,
      }),
    ).toEqual({
      kind: 'rejected',
      lane: 'verified',
      reason: 'verified-workspace-mismatch',
      requestedWorkspaceId: OTHER,
      verifiedWorkspaceId: CLAIMED,
    });
  });

  // ── REGRESSION 4 of 4: a stale claim must not become a `declared` caller ──
  it('refuses a stale claim instead of demoting it to declared', () => {
    // The caller's workspace closed, so its token no longer resolves. Falling
    // through to `declared` would hand it back the freedom to name ANY
    // workspace — strictly less confined than before it ever claimed.
    expect(
      callerScope(wireCtx({ workspaceClaim: { kind: 'stale' } }), { workspaceId: OTHER }),
    ).toEqual({
      kind: 'rejected',
      lane: 'verified',
      reason: 'verified-claim-stale',
      requestedWorkspaceId: OTHER,
    });
  });

  it('refuses a stale claim that names nothing, too', () => {
    expect(callerScope(wireCtx({ workspaceClaim: { kind: 'stale' } }), {})).toEqual({
      kind: 'rejected',
      lane: 'verified',
      reason: 'verified-claim-stale',
    });
  });

  it('outranks declared — the claim answers, not the name', () => {
    // Without the lane this would be `{ scoped, declared, ws-other }`.
    const decision = callerScope(
      wireCtx({ workspaceClaim: { kind: 'bound', workspaceId: CLAIMED } }),
      { workspaceId: OTHER },
    );
    expect(decision.kind).toBe('rejected');
    expect(decision.lane).toBe('verified');
  });

  it('ranks below pinned — a commander token still wins', () => {
    const decision = callerScope(
      wireCtx({
        commanderWorkspace: 'ws-brain',
        workspaceClaim: { kind: 'bound', workspaceId: CLAIMED },
      }),
      {},
    );
    expect(decision).toEqual({ kind: 'scoped', lane: 'pinned', workspaceId: 'ws-brain' });
  });

  it('leaves a caller that never claimed exactly where it was', () => {
    expect(callerScope(wireCtx(), { workspaceId: OTHER })).toEqual({
      kind: 'scoped',
      lane: 'declared',
      workspaceId: OTHER,
    });
    expect(callerScope(wireCtx(), {})).toEqual({
      kind: 'rejected',
      lane: 'declared',
      reason: 'workspace-unresolved',
    });
  });
});

describe('callerScope — legacy lane after ruling (c)', () => {
  const legacy = (params: Record<string, unknown>) =>
    callerScope({ origin: 'local', externalWire: true }, params);

  // ── REGRESSION 1 of 4: a NAMED legacy caller is byte-identical ────────────
  it('is unchanged for a legacy caller that names a workspace', () => {
    // Same kind, same lane, same workspaceId as before the ruling. This is the
    // half (c) deliberately does not touch.
    expect(legacy({ workspaceId: OTHER })).toEqual({
      kind: 'allowed',
      lane: 'legacy',
      workspaceId: OTHER,
    });
  });

  // ── REGRESSION 2 of 4: an OMITTED legacy caller is refused, by name ───────
  it('refuses a legacy caller that names nothing, with the new reason', () => {
    expect(legacy({})).toEqual({
      kind: 'rejected',
      lane: 'legacy',
      reason: 'legacy-workspace-unresolved',
    });
  });

  it('keeps the grandfather — the lane still ALLOWS, it just requires a scope', () => {
    // If (c) had closed the lane this would be a rejection regardless of params,
    // and it would have started a second deprecation clock (#1111 is the first).
    expect(legacy({ workspaceId: OTHER }).kind).toBe('allowed');
  });

  it('treats a blank workspaceId as naming nothing', () => {
    expect(legacy({ workspaceId: '' })).toEqual({
      kind: 'rejected',
      lane: 'legacy',
      reason: 'legacy-workspace-unresolved',
    });
  });
});

// ── Through the registered handlers ────────────────────────────────────────

const { sendToRendererMock } = vi.hoisted(() => ({ sendToRendererMock: vi.fn() }));
vi.mock('../_bridge', () => ({ sendToRenderer: sendToRendererMock }));

describe('RpcRouter — resolving the claim onto the context', () => {
  let router: RpcRouter;
  let seen: RpcContext | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    __resetWorkspaceClaimTrustForTesting();
    seen = undefined;
    router = new RpcRouter();
    router.register('workspace.list', async (_p, ctx) => {
      seen = ctx;
      return [];
    });
  });

  it('stamps a live token as a bound claim', async () => {
    const token = mintWorkspaceClaimToken(CLAIMED);
    await router.dispatch(
      { id: '1', method: 'workspace.list', params: {}, workspaceToken: token! },
      { externalWire: true },
    );
    expect(seen?.workspaceClaim).toEqual({ kind: 'bound', workspaceId: CLAIMED });
  });

  it('stamps an unresolvable token as stale rather than dropping it', async () => {
    await router.dispatch(
      { id: '2', method: 'workspace.list', params: {}, workspaceToken: 'not-a-token' },
      { externalWire: true },
    );
    expect(seen?.workspaceClaim).toEqual({ kind: 'stale' });
  });

  it('leaves the context untouched when no token is presented', async () => {
    await router.dispatch(
      { id: '3', method: 'workspace.list', params: {} },
      { externalWire: true },
    );
    expect(seen?.workspaceClaim).toBeUndefined();
  });

  it('does not refuse other methods on a stale claim, so the caller can re-claim', async () => {
    // A blanket rejection would strand the MCP server: its claim goes stale
    // exactly when its workspace closes, and recovering means calling
    // mcp.claimWorkspace again. Lanes refuse; dispatch does not.
    const res = await router.dispatch(
      { id: '4', method: 'workspace.list', params: {}, workspaceToken: 'dead' },
      { externalWire: true },
    );
    expect(res.ok).toBe(true);
  });

  it('recovers end to end: a new claim replaces a dead one', async () => {
    registerWorkspaceRpc(router, () => ({}) as BrowserWindow);
    // registerWorkspaceRpc owns `workspace.list` too, so re-register the spy
    // over it — this test cares about the CONTEXT, not the real list result.
    router.register('workspace.list', async (_p, ctx) => {
      seen = ctx;
      return [];
    });
    sendToRendererMock.mockResolvedValue({ ptyId: 'p', workspaceId: 'ws-fresh' });

    const claim = await router.dispatch(
      { id: '5', method: 'mcp.claimWorkspace', params: {}, workspaceToken: 'dead' },
      { externalWire: true },
    );
    const fresh = (claim as { result?: Record<string, unknown> }).result?.['workspaceToken'];
    expect(typeof fresh).toBe('string');

    await router.dispatch(
      { id: '6', method: 'workspace.list', params: {}, workspaceToken: fresh as string },
      { externalWire: true },
    );
    expect(seen?.workspaceClaim).toEqual({ kind: 'bound', workspaceId: 'ws-fresh' });
  });
});

describe('the null demotion, end to end', () => {
  // The hole review found in PR-A, exercised through the whole chain rather
  // than at the registry alone. `null` passes a `!== undefined` gate, so if the
  // lookup answered "never claimed" nothing would be stamped and the caller
  // would land in `declared` — free to name any workspace, one JSON keyword
  // after having its claim revoked. Two independent guards now stop it: the
  // registry maps every non-absent value to `stale`, and dispatch treats
  // anything that is not a live binding as stale regardless.
  let router: RpcRouter;
  let seen: RpcContext | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    __resetWorkspaceClaimTrustForTesting();
    seen = undefined;
    router = new RpcRouter();
    router.register('workspace.list', async (_p, ctx) => {
      seen = ctx;
      return [];
    });
  });

  it.each([
    ['null', null],
    ['a number', 7],
    ['an object', {}],
    ['an empty string', ''],
  ])('stamps %s as a stale claim, never as unclaimed', async (_label, token) => {
    await router.dispatch(
      {
        id: 'n',
        method: 'workspace.list',
        params: {},
        workspaceToken: token as unknown as string,
      },
      { externalWire: true },
    );
    expect(seen?.workspaceClaim).toEqual({ kind: 'stale' });
  });

  it('refuses the browser lane for a null token instead of scoping it to what it names', async () => {
    // The payoff: the revoked holder cannot get back to naming a workspace.
    const decision = callerScope(
      wireCtx({ workspaceClaim: { kind: 'stale' } }),
      { workspaceId: OTHER },
    );
    expect(decision).toEqual({
      kind: 'rejected',
      lane: 'verified',
      reason: 'verified-claim-stale',
      requestedWorkspaceId: OTHER,
    });
  });

  it('still leaves a genuinely absent token unclaimed', async () => {
    // The other half must not regress: a caller that never claimed keeps the
    // behaviour it always had, which is what makes this safe to ship.
    await router.dispatch(
      { id: 'n2', method: 'workspace.list', params: {} },
      { externalWire: true },
    );
    expect(seen?.workspaceClaim).toBeUndefined();
  });
});
