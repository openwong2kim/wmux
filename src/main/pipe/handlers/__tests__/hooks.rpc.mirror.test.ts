// WorkspaceMirror fast path for hooks.signal (WP2). The renderer pushes its
// full workspace tree to main on every structural/status change; the hook
// resolver consults that mirror FIRST, so a resolvable signal never touches the
// renderer `workspace.list` round-trip that a large-buffer flush storm starves.
//
// Two layers of coverage:
//   1. resolveWorkspacesForSignal (pure) — fresh mirror hits, stale/empty
//      fall-through to the pull cache.
//   2. registerHooksRpc (integration) — a fresh mirror routes a workspaceId-only
//      signal AND a cold-pull-cache signal with ZERO sendToRenderer calls.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserWindow } from 'electron';
import type { AgentSignal } from '../../../../../integrations/shared/signal-types';
import type { WorkspaceListEntry } from '../../../../shared/workspaceMirror';

const { sendToRendererMock, sendNotificationMock, broadcastMetadataUpdateMock } = vi.hoisted(() => ({
  sendToRendererMock: vi.fn(),
  sendNotificationMock: vi.fn(),
  broadcastMetadataUpdateMock: vi.fn(),
}));

vi.mock('../_bridge', () => ({ sendToRenderer: sendToRendererMock }));
vi.mock('../../../notification/sendNotification', () => ({ sendNotification: sendNotificationMock }));
vi.mock('../../../ipc/handlers/metadata.handler', () => ({ broadcastMetadataUpdate: broadcastMetadataUpdateMock }));
vi.mock('../../../notification/rendererNotificationReadiness', () => ({
  isRendererNotificationListenerReady: () => true,
}));

import { RpcRouter } from '../../RpcRouter';
import { eventBus } from '../../../events/EventBus';
import type { HookSignalRouter } from '../../../hooks/HookSignalRouter';
import {
  registerHooksRpc,
  resolveWorkspacesForSignal,
  STALE_TRUST_MS,
} from '../hooks.rpc';

function signal(overrides: Partial<AgentSignal>): AgentSignal {
  return {
    kind: 'agent.stop',
    agent: 'claude',
    cwd: '/repo',
    payload: {},
    ts: 1_700_000_000_000,
    ...overrides,
  };
}

const mirrorEntries = (): WorkspaceListEntry[] => [
  { id: 'ws-1', name: 'one', metadata: { cwd: '/repo' }, activePtyId: 'pty-1', ptyIds: ['pty-1'] },
];

// A mirror double: peek() returns a fixed snapshot (or null). Spy so we can
// assert the resolver read it.
function fakeMirror(peek: { entries: WorkspaceListEntry[]; ageMs: number } | null) {
  return { peek: vi.fn(() => peek) };
}

// A pull-cache double. get() is the round-trip; peek()/prime() are the env
// fast path. Spies reveal which tier the resolver used.
function fakeCache(opts: { peek?: { list: WorkspaceListEntry[]; ageMs: number } | null; get?: WorkspaceListEntry[] | null }) {
  return {
    get: vi.fn(async () => opts.get ?? null),
    peek: vi.fn(() => opts.peek ?? null),
    prime: vi.fn(() => { /* spy only */ }),
  };
}

describe('resolveWorkspacesForSignal — mirror fast path (WP2)', () => {
  it('fresh mirror resolves a workspaceId-only signal → mirror hit, NO pull', async () => {
    const mirror = fakeMirror({ entries: mirrorEntries(), ageMs: 500 });
    const cache = fakeCache({ get: mirrorEntries() });
    const { workspaces, fetchMs, fastPathed } = await resolveWorkspacesForSignal(
      signal({ workspaceId: 'ws-1', cwd: '/nomatch' }),
      cache,
      mirror,
    );
    expect(workspaces?.[0]?.id).toBe('ws-1'); // served off the mirror
    expect(fetchMs).toBe(0);
    expect(fastPathed).toBe(true); // counted as absorbed, not degraded
    expect(cache.get).not.toHaveBeenCalled();
    expect(cache.peek).not.toHaveBeenCalled(); // never fell through to the pull tier
  });

  it('fresh mirror resolves an exact-ptyId signal against a COLD pull cache → NO pull', async () => {
    const mirror = fakeMirror({ entries: mirrorEntries(), ageMs: 100 });
    const cache = fakeCache({ peek: null, get: null }); // pull cache never fetched
    const { workspaces, fetchMs, fastPathed } = await resolveWorkspacesForSignal(
      signal({ ptyId: 'pty-1', workspaceId: 'ws-1', cwd: '/repo' }),
      cache,
      mirror,
    );
    expect(workspaces?.[0]?.id).toBe('ws-1');
    expect(fetchMs).toBe(0);
    expect(fastPathed).toBe(true);
    expect(cache.get).not.toHaveBeenCalled();
  });

  it('ptyId ABSENT from a fresh mirror (push lag) → mirror rejected, falls to pull', async () => {
    // A just-created pane whose renderer push hasn't landed: pty-NEW is not in
    // the mirror, but its workspaceId resolves to ws-1's activePtyId (pty-1 — a
    // DIFFERENT pane). The exact-id guard must reject rather than fast-path that
    // misroute; a fresh pull would contain the new pane.
    const mirror = fakeMirror({ entries: mirrorEntries(), ageMs: 100 });
    const cache = fakeCache({ peek: null, get: mirrorEntries() });
    const { fastPathed } = await resolveWorkspacesForSignal(
      signal({ ptyId: 'pty-NEW', workspaceId: 'ws-1', cwd: '/repo' }),
      cache,
      mirror,
    );
    expect(cache.get).toHaveBeenCalledTimes(1); // renderer fetch (pull) invoked
    expect(fastPathed).toBe(false);
  });

  it('ptyId PRESENT in a fresh mirror → mirror serves, NO pull', async () => {
    const mirror = fakeMirror({ entries: mirrorEntries(), ageMs: 100 });
    const cache = fakeCache({ peek: null, get: null });
    const { workspaces, fastPathed } = await resolveWorkspacesForSignal(
      signal({ ptyId: 'pty-1', workspaceId: 'ws-1', cwd: '/repo' }),
      cache,
      mirror,
    );
    expect(workspaces?.[0]?.id).toBe('ws-1');
    expect(fastPathed).toBe(true);
    expect(cache.get).not.toHaveBeenCalled(); // spy not called — mirror served
  });

  it('stale mirror (ageMs > STALE_TRUST_MS) falls through to the pull cache', async () => {
    const mirror = fakeMirror({ entries: mirrorEntries(), ageMs: STALE_TRUST_MS + 1 });
    const cache = fakeCache({ peek: null, get: mirrorEntries() });
    const { fetchMs, fastPathed } = await resolveWorkspacesForSignal(
      signal({ workspaceId: 'ws-1', cwd: '/repo' }),
      cache,
      mirror,
    );
    expect(cache.get).toHaveBeenCalledTimes(1); // authoritative fetch
    expect(fastPathed).toBe(false);
    expect(fetchMs).toBeGreaterThanOrEqual(0);
  });

  it('empty mirror (peek null) falls through to the pull cache', async () => {
    const mirror = fakeMirror(null);
    const cache = fakeCache({ peek: null, get: mirrorEntries() });
    const { fastPathed } = await resolveWorkspacesForSignal(
      signal({ workspaceId: 'ws-1', cwd: '/repo' }),
      cache,
      mirror,
    );
    expect(mirror.peek).toHaveBeenCalledTimes(1);
    expect(cache.get).toHaveBeenCalledTimes(1);
    expect(fastPathed).toBe(false);
  });

  it('mirror that cannot place the signal falls through (ptyId absent, cwd no match)', async () => {
    const mirror = fakeMirror({ entries: mirrorEntries(), ageMs: 100 });
    const cache = fakeCache({ peek: null, get: mirrorEntries() });
    const { fastPathed } = await resolveWorkspacesForSignal(
      signal({ ptyId: 'pty-unknown', cwd: '/nomatch' }),
      cache,
      mirror,
    );
    expect(cache.get).toHaveBeenCalledTimes(1);
    expect(fastPathed).toBe(false);
  });

  it('with NO mirror injected, behaves exactly as the pre-WP2 pull path', async () => {
    const cache = fakeCache({ peek: null, get: mirrorEntries() });
    const { workspaces } = await resolveWorkspacesForSignal(
      signal({ workspaceId: 'ws-1', cwd: '/repo' }),
      cache,
    );
    expect(cache.get).toHaveBeenCalledTimes(1);
    expect(workspaces?.[0]?.id).toBe('ws-1');
  });
});

// ─── Integration: registerHooksRpc honours the injected mirror ───────────────

function fakeWindow(): BrowserWindow {
  return {
    isDestroyed: () => false,
    webContents: { send: vi.fn() },
  } as unknown as BrowserWindow;
}

function stubHookRouter(): HookSignalRouter {
  return {
    recordHook: () => 'emit',
    recordDetector: vi.fn(),
    touchAuthority: vi.fn(),
    isGovernedFor: vi.fn().mockReturnValue(false),
    getLatencyMeter: () => ({
      recordSignal: vi.fn(),
      recordWorkspaceMatch: vi.fn(),
      onStatsChange: () => vi.fn(),
      getStats: () => ({}),
    }),
  } as unknown as HookSignalRouter;
}

describe('registerHooksRpc — mirror short-circuits the renderer round-trip', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    eventBus.reset();
    // If anything DID fall through to the pull path, this resolves it — so the
    // ZERO-call assertion below can only pass because the mirror served first.
    sendToRendererMock.mockResolvedValue(mirrorEntries());
  });

  afterEach(() => {
    eventBus.reset();
  });

  async function dispatch(s: AgentSignal, getMirror: () => { peek: () => { entries: WorkspaceListEntry[]; ageMs: number } | null }) {
    const router = new RpcRouter();
    registerHooksRpc(router, () => fakeWindow(), stubHookRouter(), undefined, undefined, getMirror);
    return router.dispatch({
      id: '1',
      method: 'hooks.signal',
      params: s as unknown as Record<string, unknown>,
    });
  }

  it('(a) workspaceId-only signal resolves off a fresh mirror with ZERO sendToRenderer calls', async () => {
    const mirror = fakeMirror({ entries: mirrorEntries(), ageMs: 100 });
    const res = await dispatch(signal({ workspaceId: 'ws-1', cwd: '/nomatch' }), () => mirror);
    expect(res.ok).toBe(true);
    expect(sendToRendererMock).not.toHaveBeenCalled();
    // The lifecycle tee still fired for the resolved pane.
    const { events } = eventBus.poll(0, { types: ['agent.lifecycle'] });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ ptyId: 'pty-1', workspaceId: 'ws-1' });
  });

  it('(b) cold-pull-cache signal resolves off the mirror with ZERO sendToRenderer calls', async () => {
    const mirror = fakeMirror({ entries: mirrorEntries(), ageMs: 100 });
    // pty-1 is present in the mirror; the pull cache has never been primed.
    const res = await dispatch(signal({ ptyId: 'pty-1', workspaceId: 'ws-1', cwd: '/repo' }), () => mirror);
    expect(res.ok).toBe(true);
    expect(sendToRendererMock).not.toHaveBeenCalled();
  });

  it('stale mirror forces the renderer round-trip (falls back to workspace.list)', async () => {
    const mirror = fakeMirror({ entries: mirrorEntries(), ageMs: STALE_TRUST_MS + 1 });
    const res = await dispatch(signal({ workspaceId: 'ws-1', cwd: '/repo' }), () => mirror);
    expect(res.ok).toBe(true);
    expect(sendToRendererMock).toHaveBeenCalled();
  });
});
