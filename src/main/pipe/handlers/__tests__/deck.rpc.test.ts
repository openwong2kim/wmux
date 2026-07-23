// Unit tests for deck.resolvePaneRoute (P3b codex P1, M1.5 confinement) —
// the commander brain's route resolution. Token-gated: only a live commander
// token (minted by main for the brain subprocess) may resolve a pane's
// owning workspace, and ONLY for panes inside the token's own workspace;
// everything else fails closed.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserWindow } from 'electron';
import { RpcRouter } from '../../RpcRouter';
import { registerDeckRpc } from '../deck.rpc';
import {
  mintCommanderToken,
  __resetCommanderTrustForTesting,
} from '../../../deck/commanderTrust';
import {
  grantReExamineLease,
  __resetReExamineLeasesForTesting,
} from '../../../deck/reExamineLease';

const { sendToRendererMock } = vi.hoisted(() => ({ sendToRendererMock: vi.fn() }));
vi.mock('../_bridge', () => ({ sendToRenderer: sendToRendererMock }));

// WP3 self-resolve gate reads three stores (mode / heartbeat TTL / decision).
// Mock the two config stores and the decision read/write; keep the pure helpers
// (isDecisionStale, renderDecisionBlock, raiseDecision) real via importActual so
// the gate's staleness math and requestDecision keep exercising real code.
type Decision = import('../../../deck/deckDecisionStore').WorkspaceDecision;
const {
  modeMock,
  ttlMock,
  decisionRef,
  resolveDecisionMock,
  raiseDecisionMock,
  replaceStaleDecisionMock,
} = vi.hoisted(() => ({
  modeMock: vi.fn<() => 'off' | 'assist' | 'auto'>(() => 'auto'),
  ttlMock: vi.fn<() => number>(() => 30 * 60_000),
  decisionRef: { current: null as Decision | null },
  resolveDecisionMock: vi.fn(),
  raiseDecisionMock: vi.fn(),
  replaceStaleDecisionMock: vi.fn(),
}));
vi.mock('../../../deck/deckAutonomyStore', () => ({
  loadWorkspaceMode: (_ws: string) => modeMock(),
}));
vi.mock('../../../deck/deckHeartbeatStore', () => ({
  loadDeckHeartbeat: () => ({ enabled: true, intervalMs: 180_000, decisionTtlMs: ttlMock() }),
}));
vi.mock('../../../deck/deckDecisionStore', async (orig) => {
  const actual = await orig<typeof import('../../../deck/deckDecisionStore')>();
  return {
    ...actual,
    loadWorkspaceDecision: (_ws: string) => decisionRef.current,
    resolveDecision: (ws: string, id: string, resolution: string) =>
      resolveDecisionMock(ws, id, resolution),
    raiseDecision: (ws: string, args: unknown) => raiseDecisionMock(ws, args),
    replaceStaleDecision: (ws: string, expectedId: string, ttlMs: number, args: unknown) =>
      replaceStaleDecisionMock(ws, expectedId, ttlMs, args),
  };
});

const fakeWindow = {} as BrowserWindow;

function setup(): RpcRouter {
  const router = new RpcRouter();
  registerDeckRpc(router, () => fakeWindow);
  return router;
}

describe('deck.resolvePaneRoute', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetCommanderTrustForTesting();
  });

  it('resolves a pane owned by the token workspace', async () => {
    const token = mintCommanderToken('ws-owner');
    sendToRendererMock.mockResolvedValue({ workspaceId: 'ws-owner' });

    const res = await setup().dispatch({
      id: '1',
      method: 'deck.resolvePaneRoute',
      params: { token, ptyId: 'pty-9' },
    });

    expect(res.ok).toBe(true);
    expect((res as { result: unknown }).result).toEqual({ workspaceId: 'ws-owner' });
    expect(sendToRendererMock).toHaveBeenCalledWith(
      expect.anything(),
      'input.findOwnerWorkspace',
      { ptyId: 'pty-9' },
    );
  });

  it("fails closed on a pane owned by ANOTHER workspace (M1.5 confinement)", async () => {
    const token = mintCommanderToken('ws-mine');
    sendToRendererMock.mockResolvedValue({ workspaceId: 'ws-other' });

    const res = await setup().dispatch({
      id: '1',
      method: 'deck.resolvePaneRoute',
      params: { token, ptyId: 'pty-9' },
    });

    expect(res.ok).toBe(false);
  });

  it('fails closed for a token minted with an empty workspace binding', async () => {
    const token = mintCommanderToken('');
    const res = await setup().dispatch({
      id: '1',
      method: 'deck.resolvePaneRoute',
      params: { token, ptyId: 'pty-9' },
    });
    expect(res.ok).toBe(false);
    expect(sendToRendererMock).not.toHaveBeenCalled();
  });

  it('rejects a missing/unknown token BEFORE consulting the renderer', async () => {
    mintCommanderToken('ws-1'); // a live token exists, but the caller presents another
    const router = setup();

    for (const params of [
      { ptyId: 'pty-9' },
      { token: 'guessed', ptyId: 'pty-9' },
      { token: 42, ptyId: 'pty-9' },
    ]) {
      const res = await router.dispatch({
        id: 'x',
        method: 'deck.resolvePaneRoute',
        params: params as Record<string, unknown>,
      });
      expect(res.ok).toBe(false);
    }
    expect(sendToRendererMock).not.toHaveBeenCalled();
  });

  it('fails closed on a missing ptyId and on an unowned pane', async () => {
    const token = mintCommanderToken('ws-1');
    const router = setup();

    const noPty = await router.dispatch({
      id: '1',
      method: 'deck.resolvePaneRoute',
      params: { token },
    });
    expect(noPty.ok).toBe(false);

    sendToRendererMock.mockResolvedValue({ workspaceId: null });
    const unowned = await router.dispatch({
      id: '2',
      method: 'deck.resolvePaneRoute',
      params: { token, ptyId: 'pty-ghost' },
    });
    expect(unowned.ok).toBe(false);
  });
});

// deck.resolveCommanderWorkspace — the brain's OWN sender identity (token→home
// workspace, no pane). This is what unblocks A2A tools for the orchestrator,
// which otherwise threw "Workspace identity unknown". Pure token lookup in
// main's trust registry: no renderer round-trip, fails closed without a live
// token.
describe('deck.resolveCommanderWorkspace', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetCommanderTrustForTesting();
  });

  it('returns the home workspace a live token is bound to, without touching the renderer', async () => {
    const token = mintCommanderToken('ws-home');
    const res = await setup().dispatch({
      id: '1',
      method: 'deck.resolveCommanderWorkspace',
      params: { token },
    });
    expect(res.ok).toBe(true);
    expect((res as { result: unknown }).result).toEqual({ workspaceId: 'ws-home' });
    expect(sendToRendererMock).not.toHaveBeenCalled();
  });

  it('fails closed for a missing, unknown, or non-string token', async () => {
    mintCommanderToken('ws-1'); // a live token exists; callers below present others
    const router = setup();
    for (const params of [{}, { token: 'guessed' }, { token: 42 }]) {
      const res = await router.dispatch({
        id: 'x',
        method: 'deck.resolveCommanderWorkspace',
        params: params as Record<string, unknown>,
      });
      expect(res.ok).toBe(false);
    }
  });

  it('fails closed for a token minted with an empty workspace binding', async () => {
    const token = mintCommanderToken('');
    const res = await setup().dispatch({
      id: '1',
      method: 'deck.resolveCommanderWorkspace',
      params: { token },
    });
    expect(res.ok).toBe(false);
  });

  it('stops resolving a token after it is revoked (dead brain cannot replay)', async () => {
    const { mintCommanderToken: mint, revokeCommanderToken } = await import(
      '../../../deck/commanderTrust'
    );
    const token = mint('ws-home');
    revokeCommanderToken(token);
    const res = await setup().dispatch({
      id: '1',
      method: 'deck.resolveCommanderWorkspace',
      params: { token },
    });
    expect(res.ok).toBe(false);
  });
});

// deck.resolveDecision — the WP3 brain self-resolve of a STALE pending decision.
// Server-enforced 3-condition gate: mode must be 'auto', the decision must be
// stale (age > TTL), and the resolution must be substantive (>= 20 chars). Each
// failing condition alone rejects with its OWN error string.
describe('deck.resolveDecision (WP3 self-resolve gate)', () => {
  const TTL = 30 * 60_000;
  const GOOD_RESOLUTION = 'Per CLAUDE.md: PRs never bump the version, so no bump.';

  const stalePending = (id = 'dec-1'): Decision => ({
    id,
    question: 'Bump version?',
    options: [],
    context: '',
    status: 'pending',
    raisedAt: Date.now() - TTL - 60_000, // an hour-ish old → stale
  });

  const resolve = (
    router: RpcRouter,
    params: Record<string, unknown>,
  ): Promise<{ ok: boolean; result?: unknown; error?: unknown }> =>
    router.dispatch({ id: '1', method: 'deck.resolveDecision', params }) as Promise<{
      ok: boolean;
      result?: unknown;
      error?: unknown;
    }>;

  beforeEach(() => {
    vi.clearAllMocks();
    __resetCommanderTrustForTesting();
    __resetReExamineLeasesForTesting();
    // Restore the "all conditions pass" defaults after clearAllMocks. The
    // re-examine lease (round-5 gate 0) is granted so the mode/TTL/substance
    // conditions below are each exercised in isolation.
    grantReExamineLease('ws-1', 'dec-1');
    modeMock.mockReturnValue('auto');
    ttlMock.mockReturnValue(TTL);
    decisionRef.current = stalePending();
    resolveDecisionMock.mockImplementation(
      async (_ws: string, id: string, resolution: string) => {
        const cur = decisionRef.current;
        if (!cur || cur.id !== id || cur.status !== 'pending') return null;
        const next: Decision = { ...cur, status: 'resolved', resolution, resolvedAt: Date.now() };
        decisionRef.current = next;
        return next;
      },
    );
  });

  it('resolves when ALL three conditions hold, and the pending clears', async () => {
    const token = mintCommanderToken('ws-1');
    const res = await resolve(setup(), { token, id: 'dec-1', resolution: GOOD_RESOLUTION });
    expect(res.ok).toBe(true);
    expect((res.result as { ok: boolean; id: string })).toEqual({ ok: true, id: 'dec-1' });
    expect(resolveDecisionMock).toHaveBeenCalledWith('ws-1', 'dec-1', GOOD_RESOLUTION);
    expect(decisionRef.current?.status).toBe('resolved');
  });

  it('rejects a non-auto workspace with mode_not_auto (mode condition alone)', async () => {
    modeMock.mockReturnValue('assist');
    const token = mintCommanderToken('ws-1');
    const res = await resolve(setup(), { token, id: 'dec-1', resolution: GOOD_RESOLUTION });
    expect((res.result as { ok: boolean; error: string })).toEqual({
      ok: false,
      error: 'mode_not_auto',
    });
    expect(resolveDecisionMock).not.toHaveBeenCalled();
    expect(decisionRef.current?.status).toBe('pending');
  });

  it('rejects a fresh (not-yet-stale) decision with not_stale (age condition alone)', async () => {
    decisionRef.current = { ...stalePending(), raisedAt: Date.now() }; // age ~0
    const token = mintCommanderToken('ws-1');
    const res = await resolve(setup(), { token, id: 'dec-1', resolution: GOOD_RESOLUTION });
    expect((res.result as { ok: boolean; error: string })).toEqual({
      ok: false,
      error: 'not_stale',
    });
    expect(resolveDecisionMock).not.toHaveBeenCalled();
  });

  it('rejects a too-short resolution with insufficient_basis (substance condition alone)', async () => {
    const token = mintCommanderToken('ws-1');
    const res = await resolve(setup(), { token, id: 'dec-1', resolution: 'yes' });
    expect((res.result as { ok: boolean; error: string })).toEqual({
      ok: false,
      error: 'insufficient_basis',
    });
    expect(resolveDecisionMock).not.toHaveBeenCalled();
  });

  it('rejects a call OUTSIDE a live re-examine turn with no_reexamine_lease (round-5 gate 0)', async () => {
    __resetReExamineLeasesForTesting(); // no re-examine turn is running
    const token = mintCommanderToken('ws-1');
    const res = await resolve(setup(), { token, id: 'dec-1', resolution: GOOD_RESOLUTION });
    expect((res.result as { ok: boolean; error: string })).toEqual({
      ok: false,
      error: 'no_reexamine_lease',
    });
    expect(resolveDecisionMock).not.toHaveBeenCalled();
  });

  it('rejects a lease for a DIFFERENT decision id (lease is decision-scoped)', async () => {
    __resetReExamineLeasesForTesting();
    grantReExamineLease('ws-1', 'dec-other'); // re-examine running, but for another decision
    const token = mintCommanderToken('ws-1');
    const res = await resolve(setup(), { token, id: 'dec-1', resolution: GOOD_RESOLUTION });
    expect((res.result as { ok: boolean; error: string })).toEqual({
      ok: false,
      error: 'no_reexamine_lease',
    });
    expect(resolveDecisionMock).not.toHaveBeenCalled();
  });

  it('rejects a mismatched / absent pending decision id with not_pending', async () => {
    const token = mintCommanderToken('ws-1');
    const wrongId = await resolve(setup(), { token, id: 'other', resolution: GOOD_RESOLUTION });
    expect((wrongId.result as { error: string }).error).toBe('not_pending');

    decisionRef.current = null;
    const none = await resolve(setup(), { token, id: 'dec-1', resolution: GOOD_RESOLUTION });
    expect((none.result as { error: string }).error).toBe('not_pending');
  });

  it('throws (fails closed) without a live commander token', async () => {
    const token = mintCommanderToken('ws-1');
    const router = setup();
    for (const params of [
      { id: 'dec-1', resolution: GOOD_RESOLUTION }, // no token
      { token: 'guessed', id: 'dec-1', resolution: GOOD_RESOLUTION },
      { token, id: '', resolution: GOOD_RESOLUTION }, // live token but missing id
    ]) {
      const res = await resolve(router, params);
      expect(res.ok).toBe(false);
    }
  });
});

// ─── 3-way review regression coverage ────────────────────────────────────────

// Lost-clock polarity guard: isDecisionStale treats raisedAt<=0 as "stale
// immediately" (conservative for the heartbeat — wake early), but for the
// SELF-RESOLVE gate that polarity is dangerous (resolve early). The RPC must
// fail CLOSED on a lost clock: without a trustworthy age the TTL cannot be
// proven elapsed, so the decision stays human-only.
describe('deck.resolveDecision — lost-clock polarity guard', () => {
  const TTL = 30 * 60_000;
  const GOOD_RESOLUTION = 'Per deck-policy.md: worktree rule settles this question.';

  beforeEach(() => {
    vi.clearAllMocks();
    __resetCommanderTrustForTesting();
    __resetReExamineLeasesForTesting();
    grantReExamineLease('ws-1', 'dec-0'); // gate 0 satisfied — the polarity is under test
    modeMock.mockReturnValue('auto');
    ttlMock.mockReturnValue(TTL);
  });

  it('rejects raisedAt=0 (sanitize fallback) with not_stale even though isDecisionStale says stale', async () => {
    decisionRef.current = {
      id: 'dec-0',
      question: 'Where?',
      options: [],
      context: '',
      status: 'pending',
      raisedAt: 0, // lost clock — reads as epoch-old to isDecisionStale
    };
    const router = new RpcRouter();
    registerDeckRpc(router, () => fakeWindow);
    const token = mintCommanderToken('ws-1');
    const res = (await router.dispatch({
      id: '1',
      method: 'deck.resolveDecision',
      params: { token, id: 'dec-0', resolution: GOOD_RESOLUTION },
    })) as { ok: boolean; result?: unknown };
    expect((res.result as { ok: boolean; error: string })).toEqual({
      ok: false,
      error: 'not_stale',
    });
    expect(resolveDecisionMock).not.toHaveBeenCalled();
  });
});

// Stale replace: the re-examine prompt offers "re-raise a sharper question,
// which replaces this one". That contract only exists for a STALE pending
// decision — a fresh pending one still refuses a second raise (no stacking).
describe('deck.requestDecision — stale replace', () => {
  const TTL = 30 * 60_000;

  const pendingAgedMs = (ageMs: number): Decision => ({
    id: 'dec-old',
    question: 'Old question?',
    options: [],
    context: '',
    status: 'pending',
    raisedAt: Date.now() - ageMs,
  });

  const request = (
    router: RpcRouter,
    params: Record<string, unknown>,
  ): Promise<{ ok: boolean; result?: unknown }> =>
    router.dispatch({ id: '1', method: 'deck.requestDecision', params }) as Promise<{
      ok: boolean;
      result?: unknown;
    }>;

  beforeEach(() => {
    vi.clearAllMocks();
    __resetCommanderTrustForTesting();
    ttlMock.mockReturnValue(TTL);
    raiseDecisionMock.mockImplementation(async (_ws: string, args: { question: string }) => ({
      id: 'dec-new',
      question: args.question,
      options: [],
      context: '',
      status: 'pending' as const,
      raisedAt: Date.now(),
    }));
  });

  it('refuses a second raise while a FRESH decision is pending (no stacking)', async () => {
    decisionRef.current = pendingAgedMs(60_000); // 1 min old — fresh
    const token = mintCommanderToken('ws-1');
    const res = await request(setup(), { token, question: 'Sharper question?' });
    expect((res.result as { ok: boolean; error: string; id: string })).toEqual({
      ok: false,
      error: 'decision_pending',
      id: 'dec-old',
    });
    expect(raiseDecisionMock).not.toHaveBeenCalled();
  });

  it('REPLACES a STALE pending decision via the CAS (never last-writer-wins raise)', async () => {
    decisionRef.current = pendingAgedMs(TTL + 60_000); // past the TTL — stale
    replaceStaleDecisionMock.mockResolvedValue({
      id: 'dec-new',
      question: 'Sharper question?',
      options: [],
      context: '',
      status: 'pending' as const,
      raisedAt: Date.now(),
    });
    const token = mintCommanderToken('ws-1');
    const res = await request(setup(), { token, question: 'Sharper question?' });
    expect((res.result as { ok: boolean; id: string })).toEqual({ ok: true, id: 'dec-new' });
    // The replace must go through the CAS, NOT the last-writer-wins raise —
    // raiseDecision would overwrite a concurrent human resolve (round 2 P1).
    expect(replaceStaleDecisionMock).toHaveBeenCalledWith(
      'ws-1',
      'dec-old',
      TTL,
      expect.objectContaining({ question: 'Sharper question?' }),
    );
    expect(raiseDecisionMock).not.toHaveBeenCalled();
  });

  it('refuses when the CAS loses (human resolved concurrently) — answer preserved', async () => {
    decisionRef.current = pendingAgedMs(TTL + 60_000); // stale at check time
    replaceStaleDecisionMock.mockResolvedValue(null); // ...but the human's resolve won the write
    const token = mintCommanderToken('ws-1');
    const res = await request(setup(), { token, question: 'Sharper question?' });
    expect((res.result as { ok: boolean; error: string; id: string })).toEqual({
      ok: false,
      error: 'decision_pending',
      id: 'dec-old',
    });
    expect(raiseDecisionMock).not.toHaveBeenCalled();
  });
});
