import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserWindow } from 'electron';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { RpcRouter } from '../../RpcRouter';
import { registerA2aRpc } from '../a2a.rpc';
import { SNAPSHOT_DEADLINE_MS } from '../../../pty/portWatch';
import type { ClaudeWorker } from '../../../a2a/ClaudeWorker';
import type { DaemonClient } from '../../../DaemonClient';
import { createHash } from 'node:crypto';
import {
  __resetWorkspaceClaimTrustForTesting,
  lookupWorkspaceClaim,
} from '../../../workspace/workspaceClaimTrust';
import { resetClaimChecks, setBrokerIdentitySource, setClaimStartTimeSource } from '../peerPidShadow';

// Claims are taken only from the process they name (peerPidShadow.checkClaim).
// These tests are about the walk, so each dispatch comes from the claimed pid
// itself, with a start time that still matches.
beforeEach(() => {
  resetClaimChecks();
  setClaimStartTimeSource(() => 1n);
});

/** The connection a call naming `params`' pid would come over: from that process. */
function fromClaimedPid(params: Record<string, unknown>): Parameters<RpcRouter['dispatch']>[1] {
  const pid = params.callerPid ?? params.codexCallerPid;
  return typeof pid === 'number' ? { externalWire: true, peerPid: pid, peerStartedAt: '1' } : undefined;
}

// Hoisted handles so the module mocks can read values set per-test.
const { sendToRendererMock, dirRef, accountsRef } = vi.hoisted(() => ({
  sendToRendererMock: vi.fn(),
  dirRef: { current: '' as string },
  accountsRef: { current: [] as Array<{ vendor: string; configDir: string }> },
}));

vi.mock('../../../account/accountStore', () => ({
  getAccountStore: () => ({ listAccounts: () => accountsRef.current }),
}));

vi.mock('../_bridge', () => ({
  sendToRenderer: sendToRendererMock,
}));

// Spread the real module: replacing it wholesale makes this test break the
// moment anything in the import graph reaches for another export (IPC, and
// friends). Only getPidMapDir needs redirecting.
vi.mock('../../../../shared/constants', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../shared/constants')>()),
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
// Creation times default to unreadable, so fake pids never reach the real process table.
function setupRouterWithSnapshot(
  ppidByPid: Map<number, number>,
  createdAt: (pid: number) => bigint | null = () => null,
  classifyCodexCaller: (pid: number) => Promise<'shared-server' | 'other' | 'unknown'> = async () => 'shared-server',
): RpcRouter {
  const router = new RpcRouter();
  registerA2aRpc(router, () => fakeWindow, makeWorker(), {
    snapshot: async () => ({ ppidByPid, listeners: [] }),
    createdAt,
    classifyCodexCaller,
  });
  return router;
}

async function dispatchResolve(router: RpcRouter, params: Record<string, unknown>): Promise<ResolveResult> {
  const res = await router.dispatch({ id: 'rp', method: 'a2a.resolve.identity', params }, fromClaimedPid(params));
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
      // The single-caller ancestry read is its own fallback (tested below);
      // here it finds nothing, so only the snapshot's retry policy is measured.
      readAncestry: async () => null,
    });

    const result = await dispatchResolve(router, { callerPid: 39876 });

    expect(calls).toBe(1);                                   // failed snapshot → NO retry
    expect(result.resolved).toBeNull();                      // no server walk
    expect(result.mappings).toEqual({ '49076': 'ws-live' }); // legacy fallback preserved
  });

  it('a snapshot that never settles falls back, then frees the coalesced slot after its deadline', async () => {
    // A ps/lsof child stuck in the kernel never settles its snapshot. The
    // handshake still answers through its failure path, and once the snapshot
    // deadline passes a later handshake starts a fresh one instead of joining
    // the stuck promise forever.
    vi.useFakeTimers();
    try {
      fs.writeFileSync(path.join(dirRef.current, '49076'), 'daemon-shell');
      sendToRendererMock.mockResolvedValue({ workspaceId: 'ws-live' });
      let calls = 0;
      const fresh = new Map<number, number>([[39876, 25020], [25020, 49076], [49076, 57454]]);
      const router = new RpcRouter();
      registerA2aRpc(router, () => fakeWindow, makeWorker(), {
        snapshot: () => {
          calls++;
          if (calls > 1) return Promise.resolve({ ppidByPid: fresh, listeners: [] });
          return new Promise<never>(() => { /* never settles */ });
        },
        readAncestry: async () => null,
      });

      const first = dispatchResolve(router, { callerPid: 39876 });
      await vi.advanceTimersByTimeAsync(SNAPSHOT_DEADLINE_MS);
      const firstResult = await first;
      expect(firstResult.resolved).toBeNull();                      // no server walk
      expect(firstResult.mappings).toEqual({ '49076': 'ws-live' }); // legacy fallback preserved
      expect(calls).toBe(1);

      const second = dispatchResolve(router, { callerPid: 39876 });
      await vi.advanceTimersByTimeAsync(SNAPSHOT_DEADLINE_MS);
      const secondResult = await second;
      expect(calls).toBe(2); // the stuck snapshot no longer holds the slot
      expect(secondResult.resolved).toEqual({ workspaceId: 'ws-live', ptyId: 'daemon-shell' });
    } finally {
      vi.useRealTimers();
    }
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

  it('stops at a reused parent pid: a self-updated Codex app-server is not adopted by a newer pane', async () => {
    // The app-server (20000) updated itself: its parent, the old update loop
    // (30000), exited, and Windows gave 30000 to a pane shell opened later.
    // The ppid table still says 20000 → 30000.
    fs.writeFileSync(path.join(dirRef.current, '30000'), 'daemon-new-pane');
    sendToRendererMock.mockResolvedValue({ workspaceId: 'ws-other' });
    const ppidByPid = new Map<number, number>([[10000, 20000], [20000, 30000], [30000, 40000]]);
    const created: Record<number, bigint> = { 10000: 300n, 20000: 200n, 30000: 900n, 40000: 50n };
    const createdAt = (pid: number) => created[pid] ?? null;

    const result = await dispatchResolve(setupRouterWithSnapshot(ppidByPid, createdAt), { callerPid: 10000 });
    expect(result.resolved).toBeNull();

    // The same chain with a parent older than its child resolves as before.
    created[30000] = 100n;
    const intact = await dispatchResolve(setupRouterWithSnapshot(ppidByPid, createdAt), { callerPid: 10000 });
    expect(intact.resolved).toEqual({ workspaceId: 'ws-other', ptyId: 'daemon-new-pane' });
  });

  it('checks the caller → parent edge too', async () => {
    // The MCP's own parent died and its pid went to a newer pane shell.
    fs.writeFileSync(path.join(dirRef.current, '20000'), 'daemon-new-pane');
    sendToRendererMock.mockResolvedValue({ workspaceId: 'ws-other' });
    const ppidByPid = new Map<number, number>([[10000, 20000], [20000, 1]]);
    const created: Record<number, bigint> = { 10000: 300n, 20000: 900n };

    const result = await dispatchResolve(setupRouterWithSnapshot(ppidByPid, (pid) => created[pid] ?? null), { callerPid: 10000 });
    expect(result.resolved).toBeNull();
  });
});

describe('a2a.resolve.identity — a reconnect between the connection check and the mint', () => {
  // The check that the entries' client is still installed is awaited, and an
  // await yields even when it answers at once. These tests queue the swap to
  // client B inside that very gap: the first getDaemonClient() call after the
  // armed point (the confirmation's own check) schedules it.
  const sessions = [{ id: 'daemon-shell', pid: 49076, state: 'attached' }];
  let current: DaemonClient;
  let armed: boolean;
  let a: { client: DaemonClient; rpc: ReturnType<typeof vi.fn> };
  let b: { client: DaemonClient; rpc: ReturnType<typeof vi.fn> };

  function client(onWslLive?: () => void) {
    const rpc = vi.fn(async (method: string) => {
      if (method === 'daemon.listSessions') return sessions;
      if (method === 'session.wslAgentLive') { onWslLive?.(); return { live: true }; }
      throw new Error(`unexpected ${method}`);
    });
    return { client: { isConnected: true, rpc } as unknown as DaemonClient, rpc };
  }

  function router(opts: { ppidByPid: Map<number, number>; armOnWalk?: boolean; armOnCodexCheck?: boolean }): RpcRouter {
    const r = new RpcRouter();
    registerA2aRpc(r, () => fakeWindow, makeWorker(), {
      snapshot: async () => ({ ppidByPid: opts.ppidByPid, listeners: [] }),
      // Called during the walk, after the snapshot: the next client lookup is the confirmation's.
      createdAt: () => { if (opts.armOnWalk) armed = true; return null; },
      classifyCodexCaller: async () => { if (opts.armOnCodexCheck) armed = true; return 'shared-server'; },
      getDaemonClient: () => {
        const c = current;
        if (armed) {
          armed = false;
          queueMicrotask(() => { current = b.client; });
        }
        return c;
      },
    });
    return r;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    __resetWorkspaceClaimTrustForTesting();
    dirRef.current = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-pidmap-gap-'));
    fs.writeFileSync(path.join(dirRef.current, '49076'), 'daemon-shell');
    sendToRendererMock.mockImplementation(
      (_w: unknown, method: string, p: { ptyId: string }) =>
        Promise.resolve({
          workspaceId: method === 'input.findOwnerWorkspace' && p.ptyId === 'daemon-shell' ? 'ws-live' : null,
        }),
    );
    armed = false;
    a = client(() => { armed = true; });
    b = client();
    current = a.client;
  });
  afterEach(() => {
    try { fs.rmSync(dirRef.current, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  it('the walk: no pane token', async () => {
    const r = router({ ppidByPid: new Map([[39876, 49076], [49076, 1]]), armOnWalk: true });
    const result = (await dispatchResolve(r, { callerPid: 39876 })) as ResolveResult & { workspaceToken?: string };

    expect(current).toBe(b.client); // the swap did land
    expect(result.workspaceToken).toBeUndefined();
    expect(result.resolved).toBeNull();
  });

  it('the hinted pane: no token', async () => {
    // The walk misses, so the hinted pane is attested (the WSL answer arms the swap).
    const r = router({ ppidByPid: new Map([[39876, 1]]) });
    const result = (await dispatchResolve(r, { callerPid: 39876, hintedPtyId: 'daemon-shell' })) as {
      hintedPane?: { live: boolean; workspaceToken?: string };
    };

    expect(current).toBe(b.client);
    expect(result.hintedPane).toEqual({ live: true });
  });

  it('the Codex thread: no thread claim', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-codex-home-gap-'));
    const threadId = '019a0000-0000-7000-8000-0000000000aa';
    const digest = (v: string) => createHash('sha256').update(v).digest('hex');
    const dir = path.join(home, 'wmux-thread-owners');
    fs.mkdirSync(dir, { recursive: true });
    const suffix = process.env.WMUX_DATA_SUFFIX || '';
    const env = {
      WMUX_PTY_ID: 'daemon-shell', WMUX_WORKSPACE_ID: 'ws-frozen', WMUX_SURFACE_ID: '', WMUX_DATA_SUFFIX: suffix,
      WMUX_PIPE_NAME: '', WMUX_HOOKS_TO_MAIN: '',
    };
    fs.writeFileSync(path.join(dir, `thread-${digest(threadId)}.json`), JSON.stringify({ version: 1, id: threadId, env, nonce: 'n1' }));
    fs.writeFileSync(path.join(dir, `pane-${digest(JSON.stringify([suffix, 'daemon-shell']))}.json`), JSON.stringify({ id: threadId, nonce: 'n1' }));
    const previous = process.env.CODEX_HOME;
    process.env.CODEX_HOME = home;
    try {
      // Control: without the swap the same call gets its thread claim.
      const control = (await dispatchResolve(router({ ppidByPid: new Map() }), { codexThreadId: threadId, codexCallerPid: 4242 })) as {
        threadClaim?: unknown;
      };
      expect(control.threadClaim).toMatchObject({ ptyId: 'daemon-shell' });

      const r = router({ ppidByPid: new Map(), armOnCodexCheck: true });
      const result = (await dispatchResolve(r, { codexThreadId: threadId, codexCallerPid: 4242 })) as { threadClaim?: unknown };

      expect(current).toBe(b.client);
      expect(result.threadClaim).toBeUndefined();
    } finally {
      if (previous === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previous;
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('a2a.resolve.identity — pane claims from main\'s own answers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetWorkspaceClaimTrustForTesting();
    dirRef.current = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-pidmap-claim-'));
    fs.writeFileSync(path.join(dirRef.current, '49076'), 'daemon-shell');
    sendToRendererMock.mockImplementation(
      (_w: unknown, method: string, p: { ptyId: string }) =>
        Promise.resolve({
          workspaceId: method === 'input.findOwnerWorkspace' && p.ptyId === 'daemon-shell' ? 'ws-live' : null,
        }),
    );
  });
  afterEach(() => {
    try { fs.rmSync(dirRef.current, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  it('mints a pane claim for a walk hit, bound to the walked workspace and pane', async () => {
    const ppidByPid = new Map<number, number>([[39876, 49076], [49076, 1]]);
    const result = (await dispatchResolve(setupRouterWithSnapshot(ppidByPid), { callerPid: 39876 })) as ResolveResult & {
      workspaceToken?: string;
    };
    expect(typeof result.workspaceToken).toBe('string');
    expect(lookupWorkspaceClaim(result.workspaceToken)).toEqual({ kind: 'bound', workspaceId: 'ws-live', ptyId: 'daemon-shell' });
  });

  it('reads the caller\'s own ancestry when the process snapshot fails', async () => {
    const readAncestry = vi.fn(async () => new Map<number, number>([[39876, 25020], [25020, 49076]]));
    const router = new RpcRouter();
    registerA2aRpc(router, () => fakeWindow, makeWorker(), {
      snapshot: async () => { throw new Error('Win32_Process query failed'); },
      createdAt: () => null,
      readAncestry,
    });

    const result = (await dispatchResolve(router, { callerPid: 39876 })) as ResolveResult & { workspaceToken?: string };

    expect(readAncestry).toHaveBeenCalledWith(39876, expect.any(Number));
    expect(result.resolved).toEqual({ workspaceId: 'ws-live', ptyId: 'daemon-shell' });
    expect(typeof result.workspaceToken).toBe('string');
  });

  it('mints a thread claim from the Codex thread owner record, for that thread\'s pane only', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-codex-home-'));
    const threadId = '019a0000-0000-7000-8000-0000000000aa';
    const digest = (v: string) => createHash('sha256').update(v).digest('hex');
    const dir = path.join(home, 'wmux-thread-owners');
    fs.mkdirSync(dir, { recursive: true });
    const suffix = process.env.WMUX_DATA_SUFFIX || '';
    const env = {
      WMUX_PTY_ID: 'daemon-shell', WMUX_WORKSPACE_ID: 'ws-frozen', WMUX_SURFACE_ID: '', WMUX_DATA_SUFFIX: suffix,
      WMUX_PIPE_NAME: '', WMUX_HOOKS_TO_MAIN: '',
    };
    fs.writeFileSync(path.join(dir, `thread-${digest(threadId)}.json`), JSON.stringify({ version: 1, id: threadId, env, nonce: 'n1' }));
    fs.writeFileSync(path.join(dir, `pane-${digest(JSON.stringify([suffix, 'daemon-shell']))}.json`), JSON.stringify({ id: threadId, nonce: 'n1' }));
    const previous = process.env.CODEX_HOME;
    process.env.CODEX_HOME = home;
    try {
      const router = setupRouterWithSnapshot(new Map());
      const hit = (await dispatchResolve(router, { codexThreadId: threadId, codexCallerPid: 4242 })) as ResolveResult & {
        threadClaim?: { workspaceId: string; ptyId: string; workspaceToken: string };
      };
      // The LIVE owner workspace, never the id frozen in the record.
      expect(hit.threadClaim).toMatchObject({ workspaceId: 'ws-live', ptyId: 'daemon-shell' });
      expect(lookupWorkspaceClaim(hit.threadClaim?.workspaceToken)).toMatchObject({ kind: 'bound', workspaceId: 'ws-live' });

      const miss = (await dispatchResolve(router, { codexThreadId: '019a0000-0000-7000-8000-0000000000bb', codexCallerPid: 4242 })) as {
        threadClaim?: unknown;
      };
      expect(miss.threadClaim).toBeUndefined();

      // Only a caller main sees running under a shared Codex app-server gets
      // one: a different parent, or no caller pid at all, gets none.
      const notCodex = setupRouterWithSnapshot(new Map(), () => null, async () => 'other');
      const other = (await dispatchResolve(notCodex, { codexThreadId: threadId, codexCallerPid: 4242 })) as { threadClaim?: unknown };
      expect(other.threadClaim).toBeUndefined();
      const noPid = (await dispatchResolve(router, { codexThreadId: threadId })) as { threadClaim?: unknown };
      expect(noPid.threadClaim).toBeUndefined();
    } finally {
      if (previous === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previous;
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('a2a.resolve.identity — accounts and the pane the env names', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetWorkspaceClaimTrustForTesting();
    accountsRef.current = [];
    dirRef.current = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-pidmap-hint-'));
    fs.writeFileSync(path.join(dirRef.current, '49076'), 'daemon-shell');
    sendToRendererMock.mockImplementation(
      (_w: unknown, method: string, p: { ptyId: string }) =>
        Promise.resolve({
          workspaceId: method === 'input.findOwnerWorkspace' && p.ptyId === 'daemon-shell' ? 'ws-live' : null,
        }),
    );
  });
  afterEach(() => {
    accountsRef.current = [];
    try { fs.rmSync(dirRef.current, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  function routerWithDaemon(wslLive: boolean | 'throws'): { router: RpcRouter; rpc: ReturnType<typeof vi.fn> } {
    const rpc = vi.fn(async () => {
      if (wslLive === 'throws') throw new Error('daemon down');
      return { live: wslLive };
    });
    const router = new RpcRouter();
    // One client for the whole connection, as main installs it.
    const client = { rpc } as unknown as DaemonClient;
    registerA2aRpc(router, () => fakeWindow, makeWorker(), {
      snapshot: async () => ({ ppidByPid: new Map([[39876, 1]]), listeners: [] }),
      createdAt: () => null,
      getDaemonClient: () => client,
    });
    return { router, rpc };
  }

  it('reports a hinted name that is no live pane (a scheduled run\'s auto- session) as not live', async () => {
    const { router, rpc } = routerWithDaemon(true);
    const result = (await dispatchResolve(router, { callerPid: 39876, hintedPtyId: 'auto-run-1' })) as { hintedPane?: unknown };
    expect(result.hintedPane).toEqual({ live: false });
    // The pid-map check may list sessions; the WSL attestation must not run.
    expect(rpc).not.toHaveBeenCalledWith('session.wslAgentLive', expect.anything(), expect.anything());
  });

  it('attests a live pane only when the daemon follows a live WSL agent in it', async () => {
    const attested = routerWithDaemon(true);
    const yes = (await dispatchResolve(attested.router, { callerPid: 39876, hintedPtyId: 'daemon-shell' })) as {
      hintedPane?: { live: boolean; workspaceId?: string; workspaceToken?: string };
    };
    expect(attested.rpc).toHaveBeenCalledWith('session.wslAgentLive', { sessionId: 'daemon-shell' }, expect.anything());
    expect(yes.hintedPane).toMatchObject({ live: true, workspaceId: 'ws-live' });
    expect(lookupWorkspaceClaim(yes.hintedPane?.workspaceToken)).toEqual({ kind: 'bound', workspaceId: 'ws-live', ptyId: 'daemon-shell' });

    for (const answer of [false, 'throws'] as const) {
      const { router } = routerWithDaemon(answer);
      const no = (await dispatchResolve(router, { callerPid: 39876, hintedPtyId: 'daemon-shell' })) as { hintedPane?: unknown };
      expect(no.hintedPane).toEqual({ live: true });
    }
  });

  it('finds a Codex thread\'s owner record under a registered Codex account\'s home', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-codex-account-'));
    accountsRef.current = [{ vendor: 'codex', configDir: home }];
    const threadId = '019a0000-0000-7000-8000-0000000000cc';
    const digest = (v: string) => createHash('sha256').update(v).digest('hex');
    const dir = path.join(home, 'wmux-thread-owners');
    fs.mkdirSync(dir, { recursive: true });
    const suffix = process.env.WMUX_DATA_SUFFIX || '';
    const env = {
      WMUX_PTY_ID: 'daemon-shell', WMUX_WORKSPACE_ID: 'ws-frozen', WMUX_SURFACE_ID: '', WMUX_DATA_SUFFIX: suffix,
      WMUX_PIPE_NAME: '', WMUX_HOOKS_TO_MAIN: '',
    };
    fs.writeFileSync(path.join(dir, `thread-${digest(threadId)}.json`), JSON.stringify({ version: 1, id: threadId, env, nonce: 'n2' }));
    fs.writeFileSync(path.join(dir, `pane-${digest(JSON.stringify([suffix, 'daemon-shell']))}.json`), JSON.stringify({ id: threadId, nonce: 'n2' }));
    try {
      const result = (await dispatchResolve(setupRouterWithSnapshot(new Map()), { codexThreadId: threadId, codexCallerPid: 4242 })) as {
        threadClaim?: { workspaceId: string; ptyId: string };
      };
      expect(result.threadClaim).toMatchObject({ workspaceId: 'ws-live', ptyId: 'daemon-shell' });
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('a2a.resolve.identity — scheduled runs with a browser identity', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    __resetWorkspaceClaimTrustForTesting();
    dirRef.current = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-pidmap-run-'));
    const { setRunIdentityTransport, __setRunIdentityStoreDirForTest, recordRunIdentity } = await import('../../../automation/runIdentity');
    __setRunIdentityStoreDirForTest(fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-runid-')));
    await recordRunIdentity({ automationId: 'a1', boundRevision: 2, workspaceId: 'ws-1', paneId: 'pane-a', profileId: 'pa', hosts: [], fingerprint: '0'.repeat(64), mode: 'approval' });
    setRunIdentityTransport({
      rpc: async (method: string) =>
        method === 'automation.identityRuns' ? { runs: [{ ptyId: 'auto-r1', pid: 49076, automationId: 'a1', revision: 2 }] } : null,
    });
  });
  afterEach(async () => {
    const { setRunIdentityTransport, __setRunIdentityStoreDirForTest } = await import('../../../automation/runIdentity');
    setRunIdentityTransport(null);
    __setRunIdentityStoreDirForTest(null);
    try { fs.rmSync(dirRef.current, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  it("walks to a live identity run's shell and hands back a browser-only claim", async () => {
    const ppidByPid = new Map<number, number>([[39876, 25020], [25020, 49076], [49076, 1]]);
    const res = await router(ppidByPid);
    expect(res.resolved).toEqual({ workspaceId: 'ws-1', ptyId: 'auto-r1' });
    expect(res.entries).toEqual([]);
    expect(lookupWorkspaceClaim(res.workspaceToken)).toEqual({ kind: 'bound', workspaceId: 'ws-1', ptyId: 'auto-r1', browserOnly: true });
  });

  it('a caller whose connection is another process gets no run claim', async () => {
    const r = setupRouterWithSnapshot(new Map<number, number>([[39876, 25020], [25020, 49076], [49076, 1]]));
    const res = await r.dispatch({ id: 'rp', method: 'a2a.resolve.identity', params: { callerPid: 39876 } }, { externalWire: true, peerPid: 11111, peerStartedAt: '1' });
    const result = (res as { result: ResolveResult & { workspaceToken?: string } }).result;
    expect(result.resolved).toBeNull();
    expect(result.workspaceToken).toBeUndefined();
  });

  it('a run claim is neither minted nor refreshed when the caller changed before the mint', async () => {
    // A claim already held for the run's PTY, which a mint for another
    // workspace would delete.
    const { claimTokenForRun } = await import('../../../workspace/workspaceClaimTrust');
    const held = claimTokenForRun('ws-other', 'auto-r1');
    let reads = 0;
    setClaimStartTimeSource(() => (reads++ === 0 ? 1n : 2n));
    const res = await router(new Map<number, number>([[39876, 25020], [25020, 49076], [49076, 1]]));
    expect(reads).toBeGreaterThan(1);
    expect(res.resolved).toBeNull();
    expect(res.workspaceToken).toBeUndefined();
    expect(lookupWorkspaceClaim(held)).toEqual({ kind: 'bound', workspaceId: 'ws-other', ptyId: 'auto-r1', browserOnly: true });
  });

  it('a caller under no identity run gets no claim', async () => {
    const res = await router(new Map<number, number>([[11111, 22222], [22222, 1], [49076, 1]]), 11111);
    expect(res.resolved).toBeNull();
    expect(res.workspaceToken).toBeUndefined();
  });

  it('a pane anchor wins: the run list is only read when no pane owns the caller', async () => {
    fs.writeFileSync(path.join(dirRef.current, '25020'), 'daemon-shell');
    sendToRendererMock.mockResolvedValue({ workspaceId: 'ws-pane' });
    const res = await router(new Map<number, number>([[39876, 25020], [25020, 49076], [49076, 1]]));
    expect(res.resolved).toEqual({ workspaceId: 'ws-pane', ptyId: 'daemon-shell' });
    const claim = lookupWorkspaceClaim(res.workspaceToken);
    expect(claim).toMatchObject({ kind: 'bound', ptyId: 'daemon-shell' });
    expect(claim).not.toHaveProperty('browserOnly');
  });

  it("a run's terminal opened in a pane keeps the run claim: the run wins over its own pane anchor", async () => {
    const { noteRunForIdentity, resetIdentityRuns } = await import('../../../automation/runIdentity');
    noteRunForIdentity({ ptyId: 'auto-r1', state: 'running', hasBrowserIdentity: true } as never);
    try {
      // The opened terminal anchors the run's shell in a new workspace.
      fs.writeFileSync(path.join(dirRef.current, '49076'), 'auto-r1');
      sendToRendererMock.mockResolvedValue({ workspaceId: 'ws-opened' });
      const res = await router(new Map<number, number>([[39876, 25020], [25020, 49076], [49076, 1]]));
      expect(res.resolved).toEqual({ workspaceId: 'ws-1', ptyId: 'auto-r1' });
      expect(lookupWorkspaceClaim(res.workspaceToken)).toEqual({ kind: 'bound', workspaceId: 'ws-1', ptyId: 'auto-r1', browserOnly: true });
    } finally {
      resetIdentityRuns([]);
    }
  });

  async function router(ppidByPid: Map<number, number>, callerPid = 39876) {
    const r = setupRouterWithSnapshot(ppidByPid);
    const res = await r.dispatch({ id: 'rp', method: 'a2a.resolve.identity', params: { callerPid } }, fromClaimedPid({ callerPid }));
    expect(res.ok).toBe(true);
    return (res as { result: ResolveResult & { workspaceToken?: string } }).result;
  }
});

describe('a2a.resolve.identity — a pid-map hit must be the session\'s current shell', () => {
  // Live repro (F23): after a daemon restart the old pane daemon-04f1c884
  // runs a new shell (13632), but its file for the earlier shell 6780 was
  // still there. Windows gave 6780 to a new worker's claude.exe, whose MCP
  // server walked up to it before reaching the worker's own shell 7644.
  const ppidByPid = new Map<number, number>([[39876, 6780], [6780, 7644], [7644, 1]]);
  const owners: Record<string, string> = { 'daemon-04f1c884': 'ws-old', 'daemon-worker': 'ws-worker' };
  let sessions: Array<{ id: string; pid?: number; state: string }>;

  beforeEach(() => {
    vi.clearAllMocks();
    __resetWorkspaceClaimTrustForTesting();
    dirRef.current = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-pidmap-live-'));
    fs.writeFileSync(path.join(dirRef.current, '6780'), 'daemon-04f1c884');
    fs.writeFileSync(path.join(dirRef.current, '7644'), 'daemon-worker');
    sessions = [
      { id: 'daemon-04f1c884', pid: 13632, state: 'detached' },
      { id: 'daemon-worker', pid: 7644, state: 'attached' },
    ];
    sendToRendererMock.mockImplementation(
      (_w: unknown, method: string, p: { ptyId: string }) =>
        Promise.resolve({ workspaceId: method === 'input.findOwnerWorkspace' ? owners[p.ptyId] ?? null : null }),
    );
  });
  afterEach(() => {
    try { fs.rmSync(dirRef.current, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  function routerWith(daemon: DaemonClient | null): RpcRouter {
    const router = new RpcRouter();
    registerA2aRpc(router, () => fakeWindow, makeWorker(), {
      snapshot: async () => ({ ppidByPid, listeners: [] }),
      createdAt: () => null,
      getDaemonClient: () => daemon,
    });
    return router;
  }

  function daemonListing(): { client: DaemonClient; rpc: ReturnType<typeof vi.fn> } {
    const rpc = vi.fn(async (method: string) => {
      if (method === 'daemon.listSessions') return sessions;
      throw new Error(`unexpected ${method}`);
    });
    return { client: { isConnected: true, rpc } as unknown as DaemonClient, rpc };
  }

  it('skips the stale file and walks on to the real shell\'s entry', async () => {
    const result = await dispatchResolve(routerWith(daemonListing().client), { callerPid: 39876 });

    expect(result.resolved).toEqual({ workspaceId: 'ws-worker', ptyId: 'daemon-worker' });
    // The client-side walk reads these, so the stale PID is gone from both.
    expect(result.entries).toEqual([{ pid: '7644', ptyId: 'daemon-worker', workspaceId: 'ws-worker' }]);
    expect(result.mappings).toEqual({ '7644': 'ws-worker' });
  });

  it('keeps the previous behaviour when the daemon is not connected', async () => {
    const result = await dispatchResolve(routerWith(null), { callerPid: 39876 });

    expect(result.resolved).toEqual({ workspaceId: 'ws-old', ptyId: 'daemon-04f1c884' });
    expect(result.entries).toHaveLength(2);
  });

  it('keeps the previous behaviour when listSessions fails', async () => {
    const rpc = vi.fn(async () => { throw new Error('daemon down'); });
    const result = await dispatchResolve(
      routerWith({ isConnected: true, rpc } as unknown as DaemonClient),
      { callerPid: 39876 },
    );

    expect(result.entries).toHaveLength(2);
  });

  it('reads the list again before a cached one drops an entry', async () => {
    const { client, rpc } = daemonListing();
    const router = routerWith(client);
    await dispatchResolve(router, { callerPid: 39876 });
    expect(rpc).toHaveBeenCalledTimes(1);

    // Within the cache window the old pane gets a new shell that reuses 6780
    // (reconnect writes its file); the cached list still says 13632.
    sessions = [
      { id: 'daemon-04f1c884', pid: 6780, state: 'detached' },
      { id: 'daemon-worker', pid: 7644, state: 'attached' },
    ];
    const second = await dispatchResolve(router, {});
    expect(rpc).toHaveBeenCalledTimes(2);
    expect(second.entries.map((e) => e.pid).sort()).toEqual(['6780', '7644']);

    // A list that agrees is served from the cache.
    await dispatchResolve(router, {});
    expect(rpc).toHaveBeenCalledTimes(2);
  });

  it('skips a stale entry whose session the daemon no longer has (startup prune failed)', async () => {
    // The old pane's session is gone, but its file survived because the
    // startup prune did not run or failed; the renderer still answers for it.
    sessions = [{ id: 'daemon-worker', pid: 7644, state: 'attached' }];
    const { client, rpc } = daemonListing();

    const result = await dispatchResolve(routerWith(client), { callerPid: 39876 });

    expect(rpc).toHaveBeenCalledWith('daemon.listSessions', { includeSuspended: true }, expect.anything());
    expect(result.resolved).toEqual({ workspaceId: 'ws-worker', ptyId: 'daemon-worker' });
    expect(result.entries).toEqual([{ pid: '7644', ptyId: 'daemon-worker', workspaceId: 'ws-worker' }]);
    expect(result.mappings).toEqual({ '7644': 'ws-worker' });
  });

  it('does not use a list cached before a daemon reconnect', async () => {
    // Before the restart the old pane's shell really was 6780.
    sessions = [
      { id: 'daemon-04f1c884', pid: 6780, state: 'detached' },
      { id: 'daemon-worker', pid: 7644, state: 'attached' },
    ];
    const before = daemonListing();
    let current: DaemonClient = before.client;
    const router = new RpcRouter();
    registerA2aRpc(router, () => fakeWindow, makeWorker(), {
      snapshot: async () => ({ ppidByPid, listeners: [] }),
      createdAt: () => null,
      getDaemonClient: () => current,
    });
    const first = await dispatchResolve(router, {});
    expect(first.entries).toHaveLength(2);

    // The daemon restarts inside the cache window: a new client, and the old
    // pane now runs 13632. The cached list would still accept 6780.
    sessions = [
      { id: 'daemon-04f1c884', pid: 13632, state: 'detached' },
      { id: 'daemon-worker', pid: 7644, state: 'attached' },
    ];
    const after = daemonListing();
    current = after.client;
    const second = await dispatchResolve(router, {});

    expect(after.rpc).toHaveBeenCalledTimes(1);
    expect(before.rpc).toHaveBeenCalledTimes(1);
    expect(second.entries).toEqual([{ pid: '7644', ptyId: 'daemon-worker', workspaceId: 'ws-worker' }]);
  });

  describe('a reconnect in the middle of one resolve', () => {
    const before = [
      { id: 'daemon-04f1c884', pid: 6780, state: 'detached' },
      { id: 'daemon-worker', pid: 7644, state: 'attached' },
    ];

    // Client A answers the list, then a reconnect installs client B while the
    // resolve still awaits the process snapshot. `bAnswer` overrides B's list.
    function midResolveReconnect(afterSessions: typeof before, bAnswer?: () => Promise<unknown>) {
      let current: DaemonClient;
      const bRpc = vi.fn(async (method: string) => {
        if (method === 'daemon.listSessions') return bAnswer ? bAnswer() : afterSessions;
        throw new Error(`unexpected ${method}`);
      });
      const b = { isConnected: true, rpc: bRpc } as unknown as DaemonClient;
      let releaseSnapshot!: () => void;
      const snapshotGate = new Promise<void>((r) => { releaseSnapshot = r; });
      const aRpc = vi.fn(async (method: string) => {
        if (method !== 'daemon.listSessions') throw new Error(`unexpected ${method}`);
        // Replace the client only once A's answer is on its way back, then
        // let the snapshot finish.
        queueMicrotask(() => { current = b; releaseSnapshot(); });
        return before;
      });
      current = { isConnected: true, rpc: aRpc } as unknown as DaemonClient;
      const router = new RpcRouter();
      registerA2aRpc(router, () => fakeWindow, makeWorker(), {
        snapshot: async () => { await snapshotGate; return { ppidByPid, listeners: [] }; },
        createdAt: () => null,
        getDaemonClient: () => current,
      });
      return { router, aRpc, bRpc };
    }

    it('mints no token from the old connection\'s entries when the new one disagrees', async () => {
      // After the restart the old pane runs 13632; 6780 is the worker's claude.exe.
      const { router, aRpc, bRpc } = midResolveReconnect([
        { id: 'daemon-04f1c884', pid: 13632, state: 'detached' },
        { id: 'daemon-worker', pid: 7644, state: 'attached' },
      ]);

      const result = (await dispatchResolve(router, { callerPid: 39876 })) as ResolveResult & { workspaceToken?: string };

      expect(aRpc).toHaveBeenCalledTimes(1);
      expect(bRpc).toHaveBeenCalledTimes(1); // re-read once from the new client
      expect(result.workspaceToken).toBeUndefined();
      expect(result.resolved).toBeNull();
      // The response carries the entries judged over the new connection.
      expect(result.entries).toEqual([{ pid: '7644', ptyId: 'daemon-worker', workspaceId: 'ws-worker' }]);
      expect(result.mappings).toEqual({ '7644': 'ws-worker' });
    });

    it.each([
      ['rejects', async () => { throw new Error('daemon busy'); }],
      ['answers with something that is not a list', async () => ({ error: 'malformed' })],
    ])('mints no token when the re-read from the new connection %s', async (_label, bAnswer) => {
      const { router, bRpc } = midResolveReconnect(before, bAnswer);

      const result = (await dispatchResolve(router, { callerPid: 39876 })) as ResolveResult & { workspaceToken?: string };

      expect(bRpc).toHaveBeenCalledTimes(1);
      expect(result.workspaceToken).toBeUndefined();
      expect(result.resolved).toBeNull();
    });

    it('keeps the claim when the new connection judges the entries the same way', async () => {
      const { router, bRpc } = midResolveReconnect(before);

      const result = (await dispatchResolve(router, { callerPid: 39876 })) as ResolveResult & { workspaceToken?: string };

      expect(bRpc).toHaveBeenCalledTimes(1);
      expect(result.resolved).toEqual({ workspaceId: 'ws-old', ptyId: 'daemon-04f1c884' });
      expect(lookupWorkspaceClaim(result.workspaceToken)).toEqual({ kind: 'bound', workspaceId: 'ws-old', ptyId: 'daemon-04f1c884' });
    });
  });

  it('mints no pane claim from a stale PID the cached list still calls current', async () => {
    sessions = [
      { id: 'daemon-04f1c884', pid: 6780, state: 'detached' },
      { id: 'daemon-worker', pid: 7644, state: 'attached' },
    ];
    const { client, rpc } = daemonListing();
    const router = routerWith(client);
    await dispatchResolve(router, {}); // caches a list that names 6780
    expect(rpc).toHaveBeenCalledTimes(1);

    // Same connection, inside the cache window: a supervised restart moved the
    // old pane to 13632 before its pid-map file was rewritten, and 6780 now
    // belongs to the worker's claude.exe.
    sessions = [
      { id: 'daemon-04f1c884', pid: 13632, state: 'detached' },
      { id: 'daemon-worker', pid: 7644, state: 'attached' },
    ];
    const result = (await dispatchResolve(router, { callerPid: 39876 })) as ResolveResult & { workspaceToken?: string };

    expect(rpc).toHaveBeenCalledTimes(2); // the claim-minting call read the list again
    expect(result.resolved).toEqual({ workspaceId: 'ws-worker', ptyId: 'daemon-worker' });
    expect(lookupWorkspaceClaim(result.workspaceToken)).toEqual({ kind: 'bound', workspaceId: 'ws-worker', ptyId: 'daemon-worker' });
  });

  it('accepts a ptyId missing from the cached list once the re-read list has it', async () => {
    // Cache the list while only the old pane exists.
    fs.rmSync(path.join(dirRef.current, '7644'));
    sessions = [{ id: 'daemon-04f1c884', pid: 6780, state: 'detached' }];
    const { client, rpc } = daemonListing();
    const router = routerWith(client);
    await dispatchResolve(router, {});
    expect(rpc).toHaveBeenCalledTimes(1);

    // A new pane is created inside the cache window: its session and file appear.
    sessions = [
      { id: 'daemon-04f1c884', pid: 6780, state: 'detached' },
      { id: 'daemon-worker', pid: 7644, state: 'attached' },
    ];
    fs.writeFileSync(path.join(dirRef.current, '7644'), 'daemon-worker');

    const result = await dispatchResolve(router, {});

    expect(rpc).toHaveBeenCalledTimes(2);
    expect(result.entries.map((e) => e.pid).sort()).toEqual(['6780', '7644']);
  });
});

describe('a2a.resolve.identity — a claim is taken only from the process it names', () => {
  // Two panes: daemon-shell (shell 49076) and daemon-other (shell 50000).
  // 39876 and 60002 run in daemon-shell, 60001 in daemon-other.
  const tree = new Map<number, number>([
    [39876, 49076], [60002, 49076], [49076, 1],
    [60001, 50000], [50000, 1],
  ]);
  // Start times as the OS would report them now.
  const started = new Map<number, bigint>([[39876, 100n], [60002, 200n], [60001, 300n], [777, 900n]]);
  type PeerResult = ResolveResult & {
    workspaceToken?: string;
    threadClaim?: { ptyId: string };
  };

  beforeEach(() => {
    vi.clearAllMocks();
    __resetWorkspaceClaimTrustForTesting();
    setClaimStartTimeSource((pid) => started.get(pid) ?? null);
    dirRef.current = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-pidmap-peer-'));
    fs.writeFileSync(path.join(dirRef.current, '49076'), 'daemon-shell');
    fs.writeFileSync(path.join(dirRef.current, '50000'), 'daemon-other');
    sendToRendererMock.mockImplementation(
      (_w: unknown, method: string, p: { ptyId: string }) =>
        Promise.resolve({
          workspaceId: method !== 'input.findOwnerWorkspace'
            ? null
            : p.ptyId === 'daemon-shell' ? 'ws-live' : p.ptyId === 'daemon-other' ? 'ws-other' : null,
        }),
    );
  });
  afterEach(() => {
    try { fs.rmSync(dirRef.current, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  function peerRouter(): RpcRouter {
    const router = new RpcRouter();
    registerA2aRpc(router, () => fakeWindow, makeWorker(), {
      snapshot: async () => ({ ppidByPid: tree, listeners: [] }),
      createdAt: () => null,
      classifyCodexCaller: async () => 'shared-server',
    });
    return router;
  }

  /** Dispatch over a connection whose OS peer is `peer` (pid, and the start time read at accept). */
  async function resolveAs(
    params: Record<string, unknown>,
    peer?: { pid: number; startedAt?: string },
    router: RpcRouter = peerRouter(),
  ): Promise<PeerResult> {
    const res = await router.dispatch(
      { id: 'pp', method: 'a2a.resolve.identity', params },
      { externalWire: true, ...(peer && { peerPid: peer.pid }), ...(peer?.startedAt !== undefined && { peerStartedAt: peer.startedAt }) },
    );
    expect(res.ok).toBe(true);
    return (res as { result: PeerResult }).result;
  }

  const live = { workspaceId: 'ws-live', ptyId: 'daemon-shell' };

  it('takes the claim from the process it names, with the start time read at accept', async () => {
    const result = await resolveAs({ callerPid: 39876 }, { pid: 39876, startedAt: '100' });
    expect(result.resolved).toEqual(live);
    expect(typeof result.workspaceToken).toBe('string');
  });

  it('takes the broker\'s claim for the pid it names, when the broker is the one main spawned', async () => {
    setBrokerIdentitySource(() => ({ pid: 777, startedAt: '900' }));
    const result = await resolveAs({ callerPid: 39876 }, { pid: 777, startedAt: '900' });
    expect(result.resolved).toEqual(live);
    expect(typeof result.workspaceToken).toBe('string');
  });

  it('refuses a claim from another process in the same pane, and in another pane', async () => {
    for (const peer of [60002, 60001]) {
      const result = await resolveAs({ callerPid: 39876 }, { pid: peer, startedAt: String(started.get(peer)) });
      expect(result.resolved, String(peer)).toBeNull();
      expect(result.workspaceToken, String(peer)).toBeUndefined();
      // The caller's own walk still gets the live entries.
      expect(result.entries.map((e) => e.ptyId).sort()).toEqual(['daemon-other', 'daemon-shell']);
    }
  });

  it('refuses a claim whose pid now belongs to a process that started later', async () => {
    const result = await resolveAs({ callerPid: 39876 }, { pid: 39876, startedAt: '99' });
    expect(result.resolved).toBeNull();
    expect(result.workspaceToken).toBeUndefined();
  });

  it('refuses a claim when the start time was not read at accept, or cannot be read now', async () => {
    expect((await resolveAs({ callerPid: 39876 }, { pid: 39876 })).resolved).toBeNull();
    setClaimStartTimeSource(() => null);
    expect((await resolveAs({ callerPid: 39876 }, { pid: 39876, startedAt: '100' })).resolved).toBeNull();
  });

  it('refuses a claim over a connection with no peer pid, and still says whether the hinted pane is live', async () => {
    const result = await resolveAs({ callerPid: 39876, hintedPtyId: 'daemon-shell' });
    expect(result.resolved).toBeNull();
    expect(result.workspaceToken).toBeUndefined();
    expect(result).toHaveProperty('hintedPane');
  });

  it('refuses a claim whose process changed between the check and the mint', async () => {
    let reads = 0;
    setClaimStartTimeSource((pid) => (pid === 39876 ? (reads++ === 0 ? 100n : 101n) : null));
    const result = await resolveAs({ callerPid: 39876 }, { pid: 39876, startedAt: '100' });
    expect(result.resolved).toBeNull();
    expect(result.workspaceToken).toBeUndefined();
  });

  it('counts one refusal for a call that names the same pid as caller and Codex caller', async () => {
    const { identitySummary } = await import('../peerPidShadow');
    await resolveAs({ callerPid: 39876, codexThreadId: '019a0000-0000-7000-8000-0000000000ee', codexCallerPid: 39876 });
    expect(identitySummary('darwin').refusals['no-peer']).toBe(1);
  });

  it('counts one refusal for a call naming the same pid twice whose process changed before the mint', async () => {
    const { identitySummary } = await import('../peerPidShadow');
    let reads = 0;
    setClaimStartTimeSource((pid) => (pid === 39876 ? (reads++ === 0 ? 100n : 101n) : null));
    const result = await resolveAs(
      { callerPid: 39876, codexThreadId: '019a0000-0000-7000-8000-0000000000ef', codexCallerPid: 39876 },
      { pid: 39876, startedAt: '100' },
    );
    expect(result.resolved).toBeNull();
    expect(result.threadClaim).toBeUndefined();
    expect(identitySummary('darwin').refusals.restarted).toBe(1);
  });

  it('refuses a claim from the broker\'s pid with another start time, or with none recorded', async () => {
    setBrokerIdentitySource(() => ({ pid: 777, startedAt: '900' }));
    expect((await resolveAs({ callerPid: 39876 }, { pid: 777, startedAt: '901' })).resolved).toBeNull();
    setBrokerIdentitySource(() => ({ pid: 777, startedAt: null }));
    expect((await resolveAs({ callerPid: 39876 }, { pid: 777, startedAt: '900' })).resolved).toBeNull();
  });

  it('refuses a Codex thread claim unless it comes from the process it names', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-codex-peer-'));
    const threadId = '019a0000-0000-7000-8000-0000000000dd';
    const digest = (v: string) => createHash('sha256').update(v).digest('hex');
    const dir = path.join(home, 'wmux-thread-owners');
    fs.mkdirSync(dir, { recursive: true });
    const suffix = process.env.WMUX_DATA_SUFFIX || '';
    const env = {
      WMUX_PTY_ID: 'daemon-shell', WMUX_WORKSPACE_ID: 'ws-frozen', WMUX_SURFACE_ID: '', WMUX_DATA_SUFFIX: suffix,
      WMUX_PIPE_NAME: '', WMUX_HOOKS_TO_MAIN: '',
    };
    fs.writeFileSync(path.join(dir, `thread-${digest(threadId)}.json`), JSON.stringify({ version: 1, id: threadId, env, nonce: 'n3' }));
    fs.writeFileSync(path.join(dir, `pane-${digest(JSON.stringify([suffix, 'daemon-shell']))}.json`), JSON.stringify({ id: threadId, nonce: 'n3' }));
    const previous = process.env.CODEX_HOME;
    process.env.CODEX_HOME = home;
    try {
      const params = { codexThreadId: threadId, codexCallerPid: 60002 };
      expect((await resolveAs(params, { pid: 60002, startedAt: '200' })).threadClaim).toMatchObject({ ptyId: 'daemon-shell' });
      setBrokerIdentitySource(() => ({ pid: 777, startedAt: '900' }));
      expect((await resolveAs(params, { pid: 777, startedAt: '900' })).threadClaim).toMatchObject({ ptyId: 'daemon-shell' });
      // Another process, even in the same pane, and no peer at all.
      expect((await resolveAs(params, { pid: 39876, startedAt: '100' })).threadClaim).toBeUndefined();
      expect((await resolveAs(params)).threadClaim).toBeUndefined();
    } finally {
      if (previous === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previous;
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('classifies a Codex caller afresh when its pid now belongs to a process that started later', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-codex-reuse-'));
    const threadId = '019a0000-0000-7000-8000-0000000000de';
    const digest = (v: string) => createHash('sha256').update(v).digest('hex');
    const dir = path.join(home, 'wmux-thread-owners');
    fs.mkdirSync(dir, { recursive: true });
    const suffix = process.env.WMUX_DATA_SUFFIX || '';
    const env = {
      WMUX_PTY_ID: 'daemon-shell', WMUX_WORKSPACE_ID: 'ws-frozen', WMUX_SURFACE_ID: '', WMUX_DATA_SUFFIX: suffix,
      WMUX_PIPE_NAME: '', WMUX_HOOKS_TO_MAIN: '',
    };
    fs.writeFileSync(path.join(dir, `thread-${digest(threadId)}.json`), JSON.stringify({ version: 1, id: threadId, env, nonce: 'n4' }));
    fs.writeFileSync(path.join(dir, `pane-${digest(JSON.stringify([suffix, 'daemon-shell']))}.json`), JSON.stringify({ id: threadId, nonce: 'n4' }));
    const previous = process.env.CODEX_HOME;
    process.env.CODEX_HOME = home;
    // One router, so its class cache lives across the calls.
    let cls: 'shared-server' | 'other' = 'shared-server';
    let duringClassification: (() => void) | null = null;
    const router = new RpcRouter();
    registerA2aRpc(router, () => fakeWindow, makeWorker(), {
      snapshot: async () => ({ ppidByPid: tree, listeners: [] }),
      createdAt: () => null,
      classifyCodexCaller: async () => { duringClassification?.(); return cls; },
    });
    const now = new Map(started);
    setClaimStartTimeSource((pid) => now.get(pid) ?? null);
    try {
      // From the process itself: keyed by the start time read at accept.
      const own = { codexThreadId: threadId, codexCallerPid: 60002 };
      expect((await resolveAs(own, { pid: 60002, startedAt: '200' }, router)).threadClaim).toMatchObject({ ptyId: 'daemon-shell' });
      cls = 'other';
      now.set(60002, 201n);
      expect((await resolveAs(own, { pid: 60002, startedAt: '201' }, router)).threadClaim).toBeUndefined();
      // Through the broker: keyed by the start time read at classification.
      setBrokerIdentitySource(() => ({ pid: 777, startedAt: '900' }));
      const relayed = { codexThreadId: threadId, codexCallerPid: 60001 };
      cls = 'shared-server';
      expect((await resolveAs(relayed, { pid: 777, startedAt: '900' }, router)).threadClaim).toBeDefined();
      cls = 'other';
      now.set(60001, 301n);
      expect((await resolveAs(relayed, { pid: 777, startedAt: '900' }, router)).threadClaim).toBeUndefined();
      // The pid passes to another process while it is classified: that
      // answer is neither used nor kept.
      cls = 'shared-server';
      now.set(60001, 302n);
      duringClassification = () => now.set(60001, 303n);
      expect((await resolveAs(relayed, { pid: 777, startedAt: '900' }, router)).threadClaim).toBeUndefined();
      duringClassification = null;
      cls = 'other';
      expect((await resolveAs(relayed, { pid: 777, startedAt: '900' }, router)).threadClaim).toBeUndefined();
      // No start time: nothing is kept, so every call classifies.
      now.delete(60001);
      cls = 'shared-server';
      expect((await resolveAs(relayed, { pid: 777, startedAt: '900' }, router)).threadClaim).toBeDefined();
      cls = 'other';
      expect((await resolveAs(relayed, { pid: 777, startedAt: '900' }, router)).threadClaim).toBeUndefined();
    } finally {
      if (previous === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previous;
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('takes a claim as sent on Windows, where no peer pid is read', async () => {
    const { checkClaim } = await import('../peerPidShadow');
    const ctx = { firstParty: true } as Parameters<typeof checkClaim>[1];
    expect(checkClaim('callerPid', ctx, 39876, { platform: 'win32', log: () => undefined })).toEqual({ ok: true, via: 'unchecked' });
  });
});
