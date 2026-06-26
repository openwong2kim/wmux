import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserWindow } from 'electron';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { RpcRouter } from '../../RpcRouter';
import { registerA2aRpc } from '../a2a.rpc';
import type { ClaudeWorker } from '../../../a2a/ClaudeWorker';

// Hoisted handles so the module mocks can read values set per-test.
const { sendToRendererMock, dirRef } = vi.hoisted(() => ({
  sendToRendererMock: vi.fn(),
  dirRef: { current: '' as string },
}));

vi.mock('../_bridge', () => ({
  sendToRenderer: sendToRendererMock,
}));

vi.mock('../../../../shared/constants', () => ({
  getPidMapDir: () => dirRef.current,
}));

const fakeWindow = {} as BrowserWindow;

function makeWorker(): ClaudeWorker {
  return {
    execute: vi.fn().mockResolvedValue(undefined),
    cancel: vi.fn().mockReturnValue(true),
    isFull: false,
    stop: vi.fn(),
  } as unknown as ClaudeWorker;
}

function setupRouter(): RpcRouter {
  const router = new RpcRouter();
  registerA2aRpc(router, () => fakeWindow, makeWorker());
  return router;
}

async function resolveIdentity(router: RpcRouter): Promise<Record<string, string>> {
  const res = await router.dispatch({ id: 'r1', method: 'a2a.resolve.identity', params: {} });
  expect(res.ok).toBe(true);
  return (res as { result: { mappings: Record<string, string> } }).result.mappings;
}

function listFiles(): string[] {
  return fs.existsSync(dirRef.current) ? fs.readdirSync(dirRef.current).sort() : [];
}

describe('a2a.resolve.identity — live ownership resolution', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dirRef.current = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-pidmap-'));
  });

  afterEach(() => {
    try {
      fs.rmSync(dirRef.current, { recursive: true, force: true });
    } catch {
      /* best-effort cleanup */
    }
  });

  it('maps a PID→ptyId entry to the CURRENT owning workspace (not a frozen id)', async () => {
    // pid-map stores PID(filename) → ptyId(content). The renderer reports the
    // live owner, which may differ from whatever workspace existed at create.
    fs.writeFileSync(path.join(dirRef.current, '1111'), 'daemon-aaaa');
    sendToRendererMock.mockImplementation(
      (_w: unknown, method: string, params: { ptyId: string }) => {
        if (method === 'input.findOwnerWorkspace' && params.ptyId === 'daemon-aaaa') {
          return Promise.resolve({ workspaceId: 'ws-live-current' });
        }
        return Promise.resolve({ workspaceId: null });
      },
    );

    const mappings = await resolveIdentity(setupRouter());

    expect(mappings).toEqual({ '1111': 'ws-live-current' });
    expect(sendToRendererMock).toHaveBeenCalledWith(
      expect.anything(),
      'input.findOwnerWorkspace',
      { ptyId: 'daemon-aaaa' },
    );
  });

  it('omits a ptyId whose pane no longer exists (owner === null) without deleting the file', async () => {
    // A dead/recycled current-format entry resolves to null and is excluded from
    // the map — so it can never produce a ghost. It is left on disk (harmless);
    // accretion is bounded at the write boundary, not on this read hot-path.
    fs.writeFileSync(path.join(dirRef.current, '2222'), 'daemon-gone');
    sendToRendererMock.mockResolvedValue({ workspaceId: null });

    const mappings = await resolveIdentity(setupRouter());

    expect(mappings).toEqual({});
    expect(listFiles()).toEqual(['2222']); // not pruned on the read path
  });

  it('DROPS legacy PID→workspaceId entries (ws- prefix) and deletes the file', async () => {
    // Legacy entries have no ptyId anchor, cannot be live-resolved, and on a
    // recycled PID surface as a ghost workspace. They must be purged, not passed
    // through (the old passthrough behavior was the root cause of the ghost bug).
    fs.writeFileSync(path.join(dirRef.current, '3333'), 'ws-legacy-frozen');

    const mappings = await resolveIdentity(setupRouter());

    expect(mappings).toEqual({});
    expect(sendToRendererMock).not.toHaveBeenCalled();
    expect(listFiles()).toEqual([]); // file purged
  });

  it('skips an entry when the renderer lookup throws (early boot / reload)', async () => {
    fs.writeFileSync(path.join(dirRef.current, '4444'), 'daemon-bbbb');
    sendToRendererMock.mockRejectedValue(new Error('renderer not ready'));

    const mappings = await resolveIdentity(setupRouter());

    expect(mappings).toEqual({});
    // Not pruned: a renderer error is not proof the entry is stale.
    expect(listFiles()).toEqual(['4444']);
  });

  it('resolves a mix of live, legacy, and dead-owner entries in one pass', async () => {
    fs.writeFileSync(path.join(dirRef.current, '10'), 'daemon-live');
    fs.writeFileSync(path.join(dirRef.current, '20'), 'ws-legacy');
    fs.writeFileSync(path.join(dirRef.current, '30'), 'daemon-dead');
    sendToRendererMock.mockImplementation(
      (_w: unknown, _method: string, params: { ptyId: string }) =>
        Promise.resolve({
          workspaceId: params.ptyId === 'daemon-live' ? 'ws-A' : null,
        }),
    );

    const mappings = await resolveIdentity(setupRouter());

    // Legacy '20' is dropped; '30' resolves to null (dead owner) and is omitted.
    expect(mappings).toEqual({ '10': 'ws-A' });
    expect(listFiles()).toEqual(['10', '30']); // legacy file purged, others kept
  });

  it('purges multiple legacy files in one pass without any renderer call', async () => {
    fs.writeFileSync(path.join(dirRef.current, '40'), 'ws-old-a');
    fs.writeFileSync(path.join(dirRef.current, '50'), 'ws-old-b');
    fs.writeFileSync(path.join(dirRef.current, '60'), 'ws-old-c');

    const mappings = await resolveIdentity(setupRouter());

    expect(mappings).toEqual({});
    expect(sendToRendererMock).not.toHaveBeenCalled();
    expect(listFiles()).toEqual([]);
  });

  it('returns an empty map when no pid-map dir exists', async () => {
    fs.rmSync(dirRef.current, { recursive: true, force: true });

    const mappings = await resolveIdentity(setupRouter());

    expect(mappings).toEqual({});
  });

  it('exposes pane-level entries (pid + ptyId + workspaceId) alongside mappings — X4 CLI', async () => {
    fs.writeFileSync(path.join(dirRef.current, '70'), 'daemon-pane');
    fs.writeFileSync(path.join(dirRef.current, '80'), 'daemon-dead');
    sendToRendererMock.mockImplementation(
      (_w: unknown, _method: string, params: { ptyId: string }) =>
        Promise.resolve({
          workspaceId: params.ptyId === 'daemon-pane' ? 'ws-X' : null,
        }),
    );

    const res = await setupRouter().dispatch({
      id: 'r2',
      method: 'a2a.resolve.identity',
      params: {},
    });
    expect(res.ok).toBe(true);
    const result = (res as { result: { mappings: Record<string, string>; entries: unknown } }).result;

    // mappings stays verbatim for existing MCP clients (additive change)
    expect(result.mappings).toEqual({ '70': 'ws-X' });
    // entries carries the immutable ptyId anchor; dead-owner entries excluded
    expect(result.entries).toEqual([{ pid: '70', ptyId: 'daemon-pane', workspaceId: 'ws-X' }]);
  });

  it('returns empty entries alongside empty mappings when the dir is missing', async () => {
    fs.rmSync(dirRef.current, { recursive: true, force: true });

    const res = await setupRouter().dispatch({
      id: 'r3',
      method: 'a2a.resolve.identity',
      params: {},
    });
    expect(res.ok).toBe(true);
    expect((res as { result: { entries: unknown } }).result.entries).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// PROPER fix — server-side process-tree walk (callerPid) + snapshot-backed prune
// ---------------------------------------------------------------------------

type ResolveResult = {
  mappings: Record<string, string>;
  entries: Array<{ pid: string; ptyId: string; workspaceId: string }>;
  resolved: { workspaceId: string; ptyId: string } | null;
};

// Inject a fake process snapshot so the walk + prune run without spawning the
// real Win32_Process PowerShell. `listeners` is irrelevant to identity.
function setupRouterWithSnapshot(ppidByPid: Map<number, number>): RpcRouter {
  const router = new RpcRouter();
  registerA2aRpc(router, () => fakeWindow, makeWorker(), {
    snapshot: async () => ({ ppidByPid, listeners: [] }),
  });
  return router;
}

async function dispatchResolve(router: RpcRouter, params: Record<string, unknown>): Promise<ResolveResult> {
  const res = await router.dispatch({ id: 'rp', method: 'a2a.resolve.identity', params });
  expect(res.ok).toBe(true);
  return (res as { result: ResolveResult }).result;
}

describe('a2a.resolve.identity — server-side walk (callerPid)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dirRef.current = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-pidmap-walk-'));
  });
  afterEach(() => {
    try { fs.rmSync(dirRef.current, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  it('walks callerPid up the tree to the owning shell anchor and returns resolved', async () => {
    // Measured live shape: Codex MCP(39876) → codex(25020) → node(40452) → shell(49076).
    fs.writeFileSync(path.join(dirRef.current, '49076'), 'daemon-shell');
    sendToRendererMock.mockImplementation(
      (_w: unknown, method: string, p: { ptyId: string }) =>
        Promise.resolve({
          workspaceId: method === 'input.findOwnerWorkspace' && p.ptyId === 'daemon-shell' ? 'ws-live' : null,
        }),
    );
    const ppidByPid = new Map<number, number>([
      [39876, 25020], [25020, 40452], [40452, 49076], [49076, 57454],
    ]);

    const result = await dispatchResolve(setupRouterWithSnapshot(ppidByPid), { callerPid: 39876 });

    expect(result.resolved).toEqual({ workspaceId: 'ws-live', ptyId: 'daemon-shell' });
    // entries still surfaced verbatim (legacy client-walk fallback stays intact)
    expect(result.entries).toEqual([{ pid: '49076', ptyId: 'daemon-shell', workspaceId: 'ws-live' }]);
  });

  it('returns resolved=null when the callerPid chain reaches no anchor', async () => {
    fs.writeFileSync(path.join(dirRef.current, '49076'), 'daemon-shell');
    sendToRendererMock.mockResolvedValue({ workspaceId: 'ws-live' });
    // 49076 is live (in snapshot) but NOT on the caller's chain → walk misses it.
    const ppidByPid = new Map<number, number>([[11111, 22222], [22222, 1], [49076, 57454]]);

    const result = await dispatchResolve(setupRouterWithSnapshot(ppidByPid), { callerPid: 11111 });

    expect(result.resolved).toBeNull();
    expect(result.entries).toEqual([{ pid: '49076', ptyId: 'daemon-shell', workspaceId: 'ws-live' }]);
  });

  it('omits resolved (null) for a legacy call with no callerPid — and takes no snapshot', async () => {
    fs.writeFileSync(path.join(dirRef.current, '70'), 'daemon-pane');
    sendToRendererMock.mockResolvedValue({ workspaceId: 'ws-X' });

    // setupRouter() wires the REAL defaultSnapshot; the absent callerPid must
    // mean getProcessSnapshot is never reached (no PowerShell spawn in this test).
    const result = await dispatchResolve(setupRouter(), {});

    expect(result.resolved).toBeNull();
    expect(result.mappings).toEqual({ '70': 'ws-X' });
  });

  it('takes a fresh snapshot when the coalesced one predates the caller (missing callerPid)', async () => {
    // A coalesced snapshot triggered by an EARLIER burst handshake can predate
    // this caller, so callerPid is absent from it → the walk would silently miss.
    // The handler must then take one fresh snapshot that does contain it.
    fs.writeFileSync(path.join(dirRef.current, '49076'), 'daemon-shell');
    sendToRendererMock.mockResolvedValue({ workspaceId: 'ws-live' });
    let calls = 0;
    const stale = new Map<number, number>([[12345, 1]]); // lacks callerPid 39876
    const fresh = new Map<number, number>([[39876, 25020], [25020, 49076], [49076, 57454]]);
    const router = new RpcRouter();
    registerA2aRpc(router, () => fakeWindow, makeWorker(), {
      snapshot: async () => ({ ppidByPid: calls++ === 0 ? stale : fresh, listeners: [] }),
    });

    const result = await dispatchResolve(router, { callerPid: 39876 });

    expect(calls).toBe(2); // coalesced (stale, missing callerPid) → one fresh refresh
    expect(result.resolved).toEqual({ workspaceId: 'ws-live', ptyId: 'daemon-shell' });
  });

  it('does NOT retry a failed snapshot before fallback (graceful degradation, single attempt)', async () => {
    // A failed snapshot must not trigger a second ~8s attempt: stacked timeouts
    // would blow past the client RPC deadline and lose even the legacy mappings.
    fs.writeFileSync(path.join(dirRef.current, '49076'), 'daemon-shell');
    sendToRendererMock.mockResolvedValue({ workspaceId: 'ws-live' });
    let calls = 0;
    const router = new RpcRouter();
    registerA2aRpc(router, () => fakeWindow, makeWorker(), {
      snapshot: async () => { calls++; throw new Error('powershell unavailable'); },
    });

    const result = await dispatchResolve(router, { callerPid: 39876 });

    expect(calls).toBe(1);                                   // failed snapshot → NO retry
    expect(result.resolved).toBeNull();                      // no server walk
    expect(result.mappings).toEqual({ '49076': 'ws-live' }); // legacy fallback preserved
  });

  it('skips the snapshot wait when there are no live anchors (empty-map → no stall)', async () => {
    // The walk can never hit with zero entries, so the handler must NOT block on
    // the snapshot. We feed a snapshot that never resolves: if it were awaited,
    // dispatchResolve would hang; completing fast proves the skip.
    fs.writeFileSync(path.join(dirRef.current, '49076'), 'daemon-shell');
    sendToRendererMock.mockResolvedValue({ workspaceId: null }); // → no live entries
    let releaseSnap!: () => void;
    const hung = new Promise<{ ppidByPid: Map<number, number>; listeners: [] }>((r) => {
      releaseSnap = () => r({ ppidByPid: new Map(), listeners: [] });
    });
    const router = new RpcRouter();
    registerA2aRpc(router, () => fakeWindow, makeWorker(), { snapshot: () => hung });

    const result = await dispatchResolve(router, { callerPid: 39876 });

    expect(result.resolved).toBeNull();
    expect(result.entries).toEqual([]);
    expect(result.mappings).toEqual({});
    releaseSnap(); // release the floated snapshot so nothing dangles
    await hung;
  });

  it('never matches callerPid itself — a recycled-PID collision must not mis-route', async () => {
    // The MCP's OWN pid (49076) collides with a still-live anchor (the OS recycled
    // an old shell's number onto this MCP). Walking from the caller would wrongly
    // resolve to that pane; starting at the parent must not.
    fs.writeFileSync(path.join(dirRef.current, '49076'), 'daemon-shell');
    sendToRendererMock.mockResolvedValue({ workspaceId: 'ws-live' });
    const ppidByPid = new Map<number, number>([[49076, 50000], [50000, 1]]); // parent chain unanchored

    const result = await dispatchResolve(setupRouterWithSnapshot(ppidByPid), { callerPid: 49076 });

    expect(result.resolved).toBeNull(); // self-pid is never treated as our own anchor
  });
});
