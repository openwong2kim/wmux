import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserWindow } from 'electron';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { RpcRouter } from '../../RpcRouter';
import { registerA2aRpc } from '../a2a.rpc';
import type { ClaudeWorker } from '../../../a2a/ClaudeWorker';
import type { DaemonClient } from '../../../DaemonClient';
import { createHash } from 'node:crypto';
import {
  __resetWorkspaceClaimTrustForTesting,
  lookupWorkspaceClaim,
} from '../../../workspace/workspaceClaimTrust';

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
      // The single-caller ancestry read is its own fallback (tested below);
      // here it finds nothing, so only the snapshot's retry policy is measured.
      readAncestry: async () => null,
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
    registerA2aRpc(router, () => fakeWindow, makeWorker(), {
      snapshot: async () => ({ ppidByPid: new Map([[39876, 1]]), listeners: [] }),
      createdAt: () => null,
      getDaemonClient: () => ({ rpc }) as unknown as DaemonClient,
    });
    return { router, rpc };
  }

  it('reports a hinted name that is no live pane (a scheduled run\'s auto- session) as not live', async () => {
    const { router, rpc } = routerWithDaemon(true);
    const result = (await dispatchResolve(router, { callerPid: 39876, hintedPtyId: 'auto-run-1' })) as { hintedPane?: unknown };
    expect(result.hintedPane).toEqual({ live: false });
    expect(rpc).not.toHaveBeenCalled();
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

  async function router(ppidByPid: Map<number, number>, callerPid = 39876) {
    const r = setupRouterWithSnapshot(ppidByPid);
    const res = await r.dispatch({ id: 'rp', method: 'a2a.resolve.identity', params: { callerPid } });
    expect(res.ok).toBe(true);
    return (res as { result: ResolveResult & { workspaceToken?: string } }).result;
  }
});
