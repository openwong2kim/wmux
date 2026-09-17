// @vitest-environment jsdom
//
// Dynamic verification for useRemoteAttachmentsLifecycle. The restore replay,
// the exit-driven refetch and the safety-net poll all live INSIDE React
// effects, so — like useNotificationListener.activity.dynamic.test.tsx — the
// REAL hook is mounted against the REAL store with a mocked
// `window.electronAPI.remote`, and the assertions are made on the live store.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useRemoteAttachmentsLifecycle } from '../useRemoteAttachmentsLifecycle';
import { useStore } from '../../stores';
import { windowDisplayedStore } from '../useWindowDisplayed';
import { selectAttachedRemoteWorkspaces } from '../../stores/slices/remoteWorkspacesSlice';
import { selectWorkspaceAgentRoster } from '../../stores/selectors/workspaceAgentRoster';
import { createRemoteSurface, createWorkspace } from '../../../shared/types';
import type { PaneLeaf } from '../../../shared/types';
import type { RemoteAttachmentDescriptor, RemoteWorkspaceSummary } from '../../../shared/remoteHosts';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
/** The captured REMOTE_PANE_EXIT callback the hook registered at mount. */
let exitCb: (() => void) | undefined;
/** Unsubscribe spy for that callback — proves teardown. */
let exitUnsub: ReturnType<typeof vi.fn>;

interface RemoteApiStub {
  attachmentsList: ReturnType<typeof vi.fn>;
  attachmentsAdd: ReturnType<typeof vi.fn>;
  attachmentsRemove: ReturnType<typeof vi.fn>;
  workspacesList: ReturnType<typeof vi.fn>;
  onPaneExit: ReturnType<typeof vi.fn>;
  /** #1329 — only the surface-row reconcile reads it, and only for the roster's
   *  origin badge. Deliberately absent from the default stub: the hook must
   *  survive an older preload bundle that has no such route. */
  hostsList?: ReturnType<typeof vi.fn>;
  /** #1391 — main's unthrottled poll tick. Also deliberately absent from the
   *  default stub, so every pre-existing case here exercises the renderer-side
   *  FALLBACK interval and proves it still works. */
  pollSubscribe?: ReturnType<typeof vi.fn>;
  onPollTick?: ReturnType<typeof vi.fn>;
}

let api: RemoteApiStub;
/** #1391 — the captured REMOTE_POLL_TICK callback, when the stub has the route. */
let tickCb: (() => void) | undefined;
/** Unsubscribe spies for that subscription — they prove teardown. */
let pollUnsub: ReturnType<typeof vi.fn>;
let tickOff: ReturnType<typeof vi.fn>;

/** A promise the test resolves by hand — models a host that has not answered
 *  yet (an asleep laptop burns the full request timeout before it fails). */
function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ListResult = any;

function installElectronApi(opts: {
  descriptors?: RemoteAttachmentDescriptor[];
  workspaces?: RemoteWorkspaceSummary[];
  listFails?: boolean;
  /** Full control over the per-host answer, for the multi-host cases. */
  listImpl?: (hostId: string) => Promise<ListResult>;
  attachmentsListImpl?: () => Promise<RemoteAttachmentDescriptor[]>;
  /** #1329 — paired hosts, for the surface-row reconcile's label lookup. */
  hosts?: Array<{ id: string; label: string; origin: string }>;
  /** #1391 — install main's poll-tick route. Off by default: absent means the
   *  renderer-interval fallback, which is what an older preload bundle gives. */
  mainTick?: boolean;
  /** #1391 — the route exists but the subscribe REJECTS (main disposed, or a
   *  main bundle reloaded under a live window). Must fall back, not go silent. */
  subscribeFails?: boolean;
} = {}): void {
  exitCb = undefined;
  exitUnsub = vi.fn();
  tickCb = undefined;
  pollUnsub = vi.fn();
  tickOff = vi.fn();
  api = {
    attachmentsList: vi.fn(opts.attachmentsListImpl ?? (async () => opts.descriptors ?? [])),
    attachmentsAdd: vi.fn(async () => true),
    attachmentsRemove: vi.fn(async () => true),
    workspacesList: vi.fn(opts.listImpl ?? (async () =>
      opts.listFails
        ? { ok: false as const, error: 'could not reach that host' }
        : { ok: true as const, workspaces: opts.workspaces ?? [] })),
    onPaneExit: vi.fn((cb: () => void) => {
      exitCb = cb;
      return exitUnsub;
    }),
    ...(opts.hosts ? { hostsList: vi.fn(async () => opts.hosts) } : {}),
    ...(opts.mainTick
      ? {
          pollSubscribe: vi.fn(async () => {
            if (opts.subscribeFails) throw new Error('no handler for remote:poll:subscribe');
            return pollUnsub;
          }),
          onPollTick: vi.fn((cb: () => void) => {
            tickCb = cb;
            return tickOff;
          }),
        }
      : {}),
  };
  (window as unknown as { electronAPI: unknown }).electronAPI = { remote: api };
}

function mount(): void {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  function Harness(): null {
    useRemoteAttachmentsLifecycle();
    return null;
  }
  act(() => {
    root.render(React.createElement(Harness));
  });
}

function unmount(): void {
  act(() => { root.unmount(); });
  container.remove();
}

/** Lets the hook's queued promise chain settle inside act(). */
async function settle(): Promise<void> {
  await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
}

const descriptor: RemoteAttachmentDescriptor = {
  key: 'h1:ws-1',
  hostId: 'h1',
  hostLabel: 'office-mac',
  workspaceId: 'ws-1',
  name: 'Remote WS',
};

function seedAttached(panes: Array<{ sessionId: string }>): void {
  act(() => {
    useStore.setState((s) => {
      s.remoteWorkspaces = [{ ...descriptor, panes }];
      s.activeRemoteKey = null;
    });
  });
}

/** Descriptor for a SECOND host — the parallelism and one-bad-host cases need
 *  two machines to have anything to say. */
const descriptor2: RemoteAttachmentDescriptor = {
  key: 'h2:ws-2',
  hostId: 'h2',
  hostLabel: 'shed-linux',
  workspaceId: 'ws-2',
  name: 'Other WS',
};

beforeEach(() => {
  act(() => {
    useStore.setState((s) => {
      s.remoteWorkspaces = [];
      s.activeRemoteKey = null;
    });
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('useRemoteAttachmentsLifecycle — boot restore', () => {
  it('restores a persisted descriptor with FRESHLY fetched panes', async () => {
    installElectronApi({
      descriptors: [descriptor],
      workspaces: [{ id: 'ws-1', name: 'Renamed remotely', panes: [{ sessionId: 's1' }, { sessionId: 's2' }] }],
    });
    mount();
    await settle();

    const entries = useStore.getState().remoteWorkspaces;
    expect(entries).toHaveLength(1);
    expect(entries[0].panes.map((p) => p.sessionId)).toEqual(['s1', 's2']);
    expect(entries[0].name).toBe('Renamed remotely');
    expect(entries[0].stale).toBe(false);
    // A restore must not steal the user's current view.
    expect(useStore.getState().activeRemoteKey).toBeNull();
    unmount();
  });

  it('keeps the entry in a stale state when the host is unreachable', async () => {
    installElectronApi({ descriptors: [descriptor], listFails: true });
    mount();
    await settle();

    const entries = useStore.getState().remoteWorkspaces;
    expect(entries).toHaveLength(1);
    expect(entries[0].stale).toBe(true);
    expect(entries[0].panes).toEqual([]);
    unmount();
  });

  it('keeps the entry in a stale state when the workspace is gone from the host', async () => {
    installElectronApi({
      descriptors: [descriptor],
      workspaces: [{ id: 'other-ws', name: 'Other', panes: [{ sessionId: 'x' }] }],
    });
    mount();
    await settle();

    expect(useStore.getState().remoteWorkspaces).toHaveLength(1);
    expect(useStore.getState().remoteWorkspaces[0].stale).toBe(true);
    unmount();
  });

  it('makes no host request when nothing was persisted', async () => {
    installElectronApi({ descriptors: [] });
    mount();
    await settle();

    expect(api.workspacesList).not.toHaveBeenCalled();
    expect(useStore.getState().remoteWorkspaces).toEqual([]);
    unmount();
  });
});

// Findings 1 and 4 — boot restore is not instantaneous: it waits on hosts that
// may take a full request timeout to fail, and the user is free to act on the
// same keys in the meantime.
describe('useRemoteAttachmentsLifecycle — boot restore races the user', () => {
  it('shows every row IMMEDIATELY, before any host has answered', async () => {
    const pendingHost = deferred<ListResult>();
    installElectronApi({ descriptors: [descriptor], listImpl: () => pendingHost.promise });
    mount();
    await settle();

    // The host is still hanging — the sidebar must not be empty for that long.
    const entries = useStore.getState().remoteWorkspaces;
    expect(entries).toHaveLength(1);
    expect(entries[0].name).toBe('Remote WS');
    expect(entries[0].stale).toBe(true);
    expect(entries[0].panes).toEqual([]);

    pendingHost.resolve({ ok: true, workspaces: [{ id: 'ws-1', name: 'Remote WS', panes: [{ sessionId: 's1' }] }] });
    await settle();
    expect(useStore.getState().remoteWorkspaces[0].panes.map((p) => p.sessionId)).toEqual(['s1']);
    expect(useStore.getState().remoteWorkspaces[0].stale).toBe(false);
    unmount();
  });

  it('queries hosts in PARALLEL, not one timeout after another', async () => {
    const pending = deferred<ListResult>();
    installElectronApi({
      descriptors: [descriptor, descriptor2],
      listImpl: () => pending.promise,
    });
    mount();
    await settle();

    // Sequentially, the second host would not be contacted until the first
    // one had answered — which it still has not.
    expect(api.workspacesList.mock.calls.map((c) => c[0]).sort()).toEqual(['h1', 'h2']);
    pending.resolve({ ok: true, workspaces: [] });
    await settle();
    unmount();
  });

  it('a manual attach during restore is NOT clobbered by the late restore', async () => {
    const pendingDescriptors = deferred<RemoteAttachmentDescriptor[]>();
    installElectronApi({
      attachmentsListImpl: () => pendingDescriptors.promise,
      workspaces: [{ id: 'ws-1', name: 'Remote WS', panes: [{ sessionId: 'live' }] }],
    });
    mount();
    await settle();

    // The user attaches the very workspace the restore is about to replay.
    act(() => {
      useStore.getState().attachRemoteWorkspace({ ...descriptor, panes: [{ sessionId: 'live' }] });
    });

    pendingDescriptors.resolve([descriptor]);
    await settle();

    const entries = useStore.getState().remoteWorkspaces;
    expect(entries).toHaveLength(1);
    expect(entries[0].panes.map((p) => p.sessionId)).toEqual(['live']);
    // The live entry keeps the selection the attach gave it.
    expect(useStore.getState().activeRemoteKey).toBe('h1:ws-1');
    unmount();
  });

  it('a detach during restore is NOT resurrected as a ghost row', async () => {
    const pendingHost = deferred<ListResult>();
    installElectronApi({ descriptors: [descriptor], listImpl: () => pendingHost.promise });
    mount();
    await settle();
    expect(useStore.getState().remoteWorkspaces).toHaveLength(1);

    // The user detaches the restored row while the host is still hanging;
    // main drops the descriptor from disk with it.
    act(() => { useStore.getState().detachRemoteWorkspace('h1:ws-1'); });
    expect(useStore.getState().remoteWorkspaces).toHaveLength(0);

    pendingHost.resolve({ ok: true, workspaces: [{ id: 'ws-1', name: 'Remote WS', panes: [{ sessionId: 's1' }] }] });
    await settle();

    expect(useStore.getState().remoteWorkspaces).toEqual([]);
    unmount();
  });
});

// Finding 3 — /api/workspaces is another machine's answer. A body that does
// not match the declared shape must cost that host its round, nothing more.
describe('useRemoteAttachmentsLifecycle — malformed remote responses', () => {
  it('a non-array `workspaces` does not abort the round for other hosts', async () => {
    installElectronApi({
      descriptors: [descriptor, descriptor2],
      listImpl: async (hostId: string) => (hostId === 'h1'
        ? { ok: true, workspaces: 'not an array' }
        : { ok: true, workspaces: [{ id: 'ws-2', name: 'Other WS', panes: [{ sessionId: 'ok' }] }] }),
    });
    mount();
    await settle();

    const byKey = new Map(useStore.getState().remoteWorkspaces.map((w) => [w.key, w]));
    expect(byKey.get('h1:ws-1')?.stale).toBe(true);
    expect(byKey.get('h2:ws-2')?.stale).toBe(false);
    expect(byKey.get('h2:ws-2')?.panes.map((p) => p.sessionId)).toEqual(['ok']);
    unmount();
  });

  it('a workspace with a null pane list goes stale instead of throwing', async () => {
    installElectronApi({
      descriptors: [descriptor, descriptor2],
      listImpl: async (hostId: string) => (hostId === 'h1'
        ? { ok: true, workspaces: [{ id: 'ws-1', name: 'Remote WS', panes: null }] }
        : { ok: true, workspaces: [{ id: 'ws-2', name: 'Other WS', panes: [{ sessionId: 'ok' }] }] }),
    });
    mount();
    await settle();

    const byKey = new Map(useStore.getState().remoteWorkspaces.map((w) => [w.key, w]));
    expect(byKey.get('h1:ws-1')?.stale).toBe(true);
    expect(byKey.get('h2:ws-2')?.panes.map((p) => p.sessionId)).toEqual(['ok']);
    unmount();
  });

  it('an IPC rejection for one host leaves the other host restored', async () => {
    installElectronApi({
      descriptors: [descriptor, descriptor2],
      listImpl: async (hostId: string) => {
        if (hostId === 'h1') throw new Error('channel closed');
        return { ok: true, workspaces: [{ id: 'ws-2', name: 'Other WS', panes: [{ sessionId: 'ok' }] }] };
      },
    });
    mount();
    await settle();

    const byKey = new Map(useStore.getState().remoteWorkspaces.map((w) => [w.key, w]));
    expect(byKey.get('h1:ws-1')?.stale).toBe(true);
    expect(byKey.get('h2:ws-2')?.panes.map((p) => p.sessionId)).toEqual(['ok']);
    unmount();
  });
});

describe('useRemoteAttachmentsLifecycle — exit-driven refresh', () => {
  it('an exit event refetches and drops the pane that closed', async () => {
    vi.useFakeTimers();
    installElectronApi({ workspaces: [{ id: 'ws-1', name: 'Remote WS', panes: [{ sessionId: 'a' }] }] });
    mount();
    seedAttached([{ sessionId: 'a' }, { sessionId: 'b' }]);
    expect(exitCb).toBeTruthy();

    act(() => { exitCb!(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });

    expect(useStore.getState().remoteWorkspaces[0].panes.map((p) => p.sessionId)).toEqual(['a']);
    unmount();
  });

  it('an exit BURST collapses into a single refetch', async () => {
    vi.useFakeTimers();
    installElectronApi({ workspaces: [{ id: 'ws-1', name: 'Remote WS', panes: [] }] });
    mount();
    seedAttached([{ sessionId: 'a' }, { sessionId: 'b' }, { sessionId: 'c' }]);

    act(() => { exitCb!(); exitCb!(); exitCb!(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });

    expect(api.workspacesList).toHaveBeenCalledTimes(1);
    unmount();
  });

  it('unsubscribes the exit listener on unmount', () => {
    installElectronApi();
    mount();
    expect(exitUnsub).not.toHaveBeenCalled();
    unmount();
    expect(exitUnsub).toHaveBeenCalledTimes(1);
  });
});

describe('useRemoteAttachmentsLifecycle — safety-net poll', () => {
  // Asserting only "workspacesList was never called" would pass even with the
  // guard deleted — an empty remoteWorkspaces yields no hostIds, so a running
  // interval would still make no request. Count the TIMER instead.
  it('arms no interval at all while nothing is attached', async () => {
    vi.useFakeTimers();
    installElectronApi();
    mount();
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });

    expect(vi.getTimerCount()).toBe(0);
    expect(api.workspacesList).not.toHaveBeenCalled();
    unmount();
  });

  it('polls once attached and picks up a pane OPENED on the remote', async () => {
    vi.useFakeTimers();
    installElectronApi({
      workspaces: [{ id: 'ws-1', name: 'Remote WS', panes: [{ sessionId: 'a' }, { sessionId: 'new' }] }],
    });
    mount();
    seedAttached([{ sessionId: 'a' }]);

    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });

    expect(api.workspacesList).toHaveBeenCalledTimes(1);
    expect(useStore.getState().remoteWorkspaces[0].panes.map((p) => p.sessionId)).toEqual(['a', 'new']);
    unmount();
  });

  it('clears the interval on detach and arms exactly one again on re-attach', async () => {
    vi.useFakeTimers();
    installElectronApi({ workspaces: [{ id: 'ws-1', name: 'Remote WS', panes: [{ sessionId: 'a' }] }] });
    mount();
    seedAttached([{ sessionId: 'a' }]);
    expect(vi.getTimerCount()).toBe(1);

    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(api.workspacesList).toHaveBeenCalledTimes(1);

    act(() => { useStore.getState().detachRemoteWorkspace('h1:ws-1'); });
    expect(vi.getTimerCount()).toBe(0);
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(api.workspacesList).toHaveBeenCalledTimes(1);

    // Re-attaching must leave ONE interval, not stack a second one.
    seedAttached([{ sessionId: 'a' }]);
    expect(vi.getTimerCount()).toBe(1);
    unmount();
  });

  it('a failed poll marks the entry stale without dropping it', async () => {
    vi.useFakeTimers();
    installElectronApi({ listFails: true });
    mount();
    seedAttached([{ sessionId: 'a' }]);

    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });

    expect(useStore.getState().remoteWorkspaces).toHaveLength(1);
    expect(useStore.getState().remoteWorkspaces[0].stale).toBe(true);
    unmount();
  });

  // Finding 6 — the SSE layer backs off and eventually gives up; the poll used
  // to retry a permanently dead host at full rate forever.
  it('backs a repeatedly failing host off instead of retrying every 10s', async () => {
    vi.useFakeTimers();
    installElectronApi({ listFails: true });
    mount();
    seedAttached([{ sessionId: 'a' }]);

    // 6 poll ticks. Without backoff that is 6 requests; with it, the delay
    // doubles from one poll interval after each consecutive failure.
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    const backedOff = api.workspacesList.mock.calls.length;
    expect(backedOff).toBeGreaterThan(0);
    expect(backedOff).toBeLessThan(6);
    unmount();
  });

  it('a host that answers again is polled at full rate immediately', async () => {
    vi.useFakeTimers();
    let healthy = false;
    installElectronApi({
      listImpl: async () => (healthy
        ? { ok: true, workspaces: [{ id: 'ws-1', name: 'Remote WS', panes: [{ sessionId: 'a' }] }] }
        : { ok: false, error: 'could not reach that host' }),
    });
    mount();
    seedAttached([{ sessionId: 'a' }]);

    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(useStore.getState().remoteWorkspaces[0].stale).toBe(true);

    healthy = true;
    // Far enough past the first backoff step for the retry to land.
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(useStore.getState().remoteWorkspaces[0].stale).toBe(false);

    // Backoff cleared: the next two ticks are both requests again.
    const afterRecovery = api.workspacesList.mock.calls.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
    expect(api.workspacesList.mock.calls.length).toBe(afterRecovery + 2);
    unmount();
  });
});

// ─── #1329 / #1322 ───────────────────────────────────────────────────────────
//
// A remote-terminal SURFACE ("Split right|down — remote", "New remote pane")
// is not an attachment: nothing ever put it in `remoteWorkspaces`, so the poll
// above never asked its host anything and its agent stayed invisible to both
// readers of that feed forever. These assert the whole chain end to end,
// against the REAL store: surface in a pane tree → ephemeral row → poll →
// agent metadata → a roster row (the sidebar half of #1322) and a hit on the
// lookup `pane.list`'s `agents:` builder performs (#1324's half).
describe('useRemoteAttachmentsLifecycle — remote-terminal surface rows (#1329)', () => {
  /** The local workspace a split-remote pane lives in. */
  function seedSurfaceWorkspace(opts: {
    hostId?: string;
    remoteWorkspaceId?: string;
    sessionId?: string;
  } = {}): string {
    const ws = createWorkspace('Local WS');
    const leaf = ws.rootPane as PaneLeaf;
    const surface = createRemoteSurface(
      opts.hostId ?? 'h1',
      opts.sessionId ?? 'sess-remote',
      'bash',
      '/root',
      true,
      opts.remoteWorkspaceId ?? 'remote-pane-1',
    );
    leaf.surfaces = [surface];
    leaf.activeSurfaceId = surface.id;
    act(() => {
      useStore.setState((s) => {
        s.workspaces = [ws];
        s.activeWorkspaceId = ws.id;
      });
    });
    return ws.id;
  }

  function clearWorkspaces(): void {
    act(() => { useStore.setState((s) => { s.workspaces = []; }); });
  }

  afterEach(() => { clearWorkspaces(); });

  it('gives the pane an INVISIBLE row and polls its host — the agent reaches the roster', async () => {
    installElectronApi({
      hosts: [{ id: 'h1', label: 'office-mac', origin: 'https://office-mac:7681' }],
      listImpl: async () => ({
        ok: true as const,
        workspaces: [{
          id: 'remote-pane-1',
          name: '',
          panes: [{ sessionId: 'sess-remote', shell: 'bash', agentName: 'Claude', agentStatus: 'working' }],
        }],
      }),
    });
    const wsId = seedSurfaceWorkspace();
    mount();
    await settle();
    await settle();

    const rows = useStore.getState().remoteWorkspaces;
    expect(rows).toHaveLength(1);
    // Invisible: a poll input, not a mirror the user asked for.
    expect(rows[0].ephemeral).toBe(true);
    expect(selectAttachedRemoteWorkspaces(useStore.getState())).toEqual([]);
    // Never persisted, so it can't come back on a later boot as a ghost.
    expect(api.attachmentsAdd).not.toHaveBeenCalled();
    // The host actually answered, and the label came from hostsList.
    expect(rows[0].stale).toBe(false);
    expect(rows[0].hostLabel).toBe('office-mac');

    // The sidebar half of #1322.
    const roster = selectWorkspaceAgentRoster(useStore.getState(), wsId);
    expect(roster.rows.map((r) => ({ agentName: r.agentName, status: r.status, host: r.remote?.hostLabel })))
      .toEqual([{ agentName: 'Claude', status: 'working', host: 'office-mac' }]);

    // …and the lookup pane.list's `agents:` builder performs (#1324).
    const found = useStore.getState().remoteWorkspaces.find(
      (r) => r.hostId === 'h1' && !r.stale && r.panes.some((p) => p.sessionId === 'sess-remote'),
    );
    expect(found?.panes.find((p) => p.sessionId === 'sess-remote')?.agentName).toBe('Claude');
    unmount();
  });

  it('reaps the row when the pane closes — no poller outlives its surface', async () => {
    installElectronApi({
      hosts: [{ id: 'h1', label: 'office-mac', origin: 'https://office-mac:7681' }],
      workspaces: [{ id: 'remote-pane-1', name: '', panes: [{ sessionId: 'sess-remote' }] }],
    });
    seedSurfaceWorkspace();
    mount();
    await settle();
    await settle();
    expect(useStore.getState().remoteWorkspaces).toHaveLength(1);

    // Whatever the close path (tab X, Ctrl+W, pane or workspace teardown), it
    // ends here: the surface is gone from state.workspaces.
    act(() => {
      useStore.setState((s) => {
        const leaf = s.workspaces[0].rootPane as PaneLeaf;
        leaf.surfaces = [];
        leaf.activeSurfaceId = '';
      });
    });
    await settle();

    expect(useStore.getState().remoteWorkspaces).toEqual([]);
    unmount();
  });

  it('never demotes a mirror the user attached on the same key', async () => {
    installElectronApi({
      hosts: [{ id: 'h1', label: 'office-mac', origin: 'https://office-mac:7681' }],
      workspaces: [{ id: 'remote-pane-1', name: '', panes: [{ sessionId: 'sess-remote' }] }],
    });
    // The mint flows create a REAL workspace on the host, so AttachRemoteModal
    // lists it and the user can attach the very same hostId:workspaceId.
    act(() => {
      useStore.setState((s) => {
        s.remoteWorkspaces = [{
          key: 'h1:remote-pane-1',
          hostId: 'h1',
          hostLabel: 'office-mac',
          workspaceId: 'remote-pane-1',
          name: '',
          label: 'my alias',
          panes: [],
        }];
      });
    });
    seedSurfaceWorkspace();
    mount();
    await settle();
    await settle();

    const rows = useStore.getState().remoteWorkspaces;
    expect(rows).toHaveLength(1);
    expect(rows[0].ephemeral).toBeUndefined();
    expect(rows[0].label).toBe('my alias');
    expect(selectAttachedRemoteWorkspaces(useStore.getState())).toHaveLength(1);

    // Closing the pane must NOT reap the user's attachment.
    act(() => {
      useStore.setState((s) => {
        const leaf = s.workspaces[0].rootPane as PaneLeaf;
        leaf.surfaces = [];
        leaf.activeSurfaceId = '';
      });
    });
    await settle();
    expect(useStore.getState().remoteWorkspaces).toHaveLength(1);
    unmount();
  });

  // The demotion path. Attaching the same host workspace from the sidebar
  // PROMOTES the ephemeral row; detaching it then removes the row outright,
  // while the pane is still open and its surfaces have not changed. A
  // reconcile keyed on the surfaces alone would sit still here and leave that
  // pane agent-less for the rest of the session — #1322, silently restored.
  it('re-mints the row if the user detaches an attachment out from under a live pane', async () => {
    installElectronApi({
      hosts: [{ id: 'h1', label: 'office-mac', origin: 'https://office-mac:7681' }],
      workspaces: [{
        id: 'remote-pane-1',
        name: '',
        panes: [{ sessionId: 'sess-remote', agentName: 'Claude' }],
      }],
    });
    const wsId = seedSurfaceWorkspace();
    mount();
    await settle();
    await settle();
    expect(useStore.getState().remoteWorkspaces).toHaveLength(1);

    // The user attaches the very same workspace as a sidebar mirror…
    act(() => {
      useStore.getState().attachRemoteWorkspace({
        key: 'h1:remote-pane-1',
        hostId: 'h1',
        hostLabel: 'office-mac',
        workspaceId: 'remote-pane-1',
        name: '',
        panes: [],
      });
    });
    expect(useStore.getState().remoteWorkspaces[0].ephemeral).toBeUndefined();

    // …then changes their mind. The pane never moved.
    act(() => { useStore.getState().detachRemoteWorkspace('h1:remote-pane-1'); });
    await settle();
    await settle();

    const rows = useStore.getState().remoteWorkspaces;
    expect(rows).toHaveLength(1);
    expect(rows[0].ephemeral).toBe(true);
    expect(selectWorkspaceAgentRoster(useStore.getState(), wsId).rows).toHaveLength(1);
    unmount();
  });

  // collectRemoteSurfaceWorkspaces promises this explicitly: ownership decides
  // who may DESTROY a session, not who may watch one.
  it('feeds a surface that only VIEWS a session it does not own', async () => {
    installElectronApi({
      hosts: [{ id: 'h1', label: 'office-mac', origin: 'https://office-mac:7681' }],
      workspaces: [{ id: 'ws-theirs', name: '', panes: [{ sessionId: 'theirs', agentName: 'Codex' }] }],
    });
    const ws = createWorkspace('Local WS');
    const leaf = ws.rootPane as PaneLeaf;
    // owned = false — somebody else's running work, merely mirrored here.
    leaf.surfaces = [createRemoteSurface('h1', 'theirs', 'bash', '/root', false, 'ws-theirs')];
    leaf.activeSurfaceId = leaf.surfaces[0].id;
    act(() => { useStore.setState((s) => { s.workspaces = [ws]; s.activeWorkspaceId = ws.id; }); });

    mount();
    await settle();
    await settle();

    expect(useStore.getState().remoteWorkspaces).toHaveLength(1);
    expect(leaf.surfaces[0].remoteOwned).toBeUndefined();
    expect(selectWorkspaceAgentRoster(useStore.getState(), ws.id).rows.map((r) => r.agentName))
      .toEqual(['Codex']);
    unmount();
  });

  it('two panes on one host share ONE row and one request per round', async () => {
    installElectronApi({
      hosts: [{ id: 'h1', label: 'office-mac', origin: 'https://office-mac:7681' }],
      workspaces: [{ id: 'remote-pane-1', name: '', panes: [{ sessionId: 'a' }, { sessionId: 'b' }] }],
    });
    const ws = createWorkspace('Local WS');
    const leaf = ws.rootPane as PaneLeaf;
    // Both panes point at the SAME minted workspace on the host.
    leaf.surfaces = [
      createRemoteSurface('h1', 'a', 'bash', '/root', true, 'remote-pane-1'),
      createRemoteSurface('h1', 'b', 'bash', '/root', true, 'remote-pane-1'),
    ];
    leaf.activeSurfaceId = leaf.surfaces[0].id;
    act(() => { useStore.setState((s) => { s.workspaces = [ws]; s.activeWorkspaceId = ws.id; }); });

    mount();
    await settle();
    await settle();

    expect(useStore.getState().remoteWorkspaces).toHaveLength(1);
    // One row, one hostId, so refresh() makes exactly one workspacesList call
    // per round — no duplicate poller.
    expect(api.workspacesList.mock.calls.every((c) => c[0] === 'h1')).toBe(true);
    unmount();
  });

  it('survives a preload bundle with no hostsList route — hostId is the fallback label', async () => {
    // No `hosts` option, so the stub genuinely has no hostsList (see
    // RemoteApiStub). The pane must still get its feed.
    installElectronApi({
      workspaces: [{ id: 'remote-pane-1', name: '', panes: [{ sessionId: 'sess-remote', agentName: 'Codex' }] }],
    });
    const wsId = seedSurfaceWorkspace();
    mount();
    await settle();
    await settle();

    const rows = useStore.getState().remoteWorkspaces;
    expect(rows).toHaveLength(1);
    expect(rows[0].hostLabel).toBe('h1');
    expect(selectWorkspaceAgentRoster(useStore.getState(), wsId).rows).toHaveLength(1);
    unmount();
  });

  it('a surface from before #1329 (no remote workspace id) is skipped, not crashed on', async () => {
    installElectronApi({ workspaces: [] });
    const ws = createWorkspace('Local WS');
    const leaf = ws.rootPane as PaneLeaf;
    // createRemoteSurface without the trailing id — exactly what a session.json
    // written by an older build restores.
    leaf.surfaces = [createRemoteSurface('h1', 'legacy', 'bash', '/root', true)];
    leaf.activeSurfaceId = leaf.surfaces[0].id;
    act(() => { useStore.setState((s) => { s.workspaces = [ws]; s.activeWorkspaceId = ws.id; }); });

    mount();
    await settle();

    expect(useStore.getState().remoteWorkspaces).toEqual([]);
    expect(api.workspacesList).not.toHaveBeenCalled();
    unmount();
  });
});

// #1391 — the poll's cadence moved to MAIN. A renderer setInterval is throttled
// by Chromium once the window is hidden or occluded (measured 10s → 17s → 60s),
// which is exactly when someone is watching a remote agent from a background
// window. These assert the two halves that makes true: the renderer arms no
// timer of its own when the tick route exists, and coming back to the window
// refreshes straight away instead of waiting out a tick.
describe('useRemoteAttachmentsLifecycle — main-driven poll cadence (#1391)', () => {
  /** jsdom's visibilityState is a getter — override it for the duration. */
  function setVisibility(state: 'visible' | 'hidden'): void {
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => state,
    });
  }

  beforeEach(() => { setVisibility('visible'); });

  it('the cadence is NOT a renderer timer — renderer time alone polls nothing', async () => {
    vi.useFakeTimers();
    installElectronApi({ mainTick: true, workspaces: [] });
    mount();
    seedAttached([{ sessionId: 'a' }]);
    await settle();
    api.workspacesList.mockClear();

    // 25s of renderer time, inside the watchdog's patience. The OLD interval
    // would have polled twice here; a THROTTLED one would have polled once.
    // Neither may happen: nothing on this side decides when to poll.
    await act(async () => { await vi.advanceTimersByTimeAsync(25_000); });
    expect(api.workspacesList).not.toHaveBeenCalled();

    // Only main's tick does.
    await act(async () => { tickCb?.(); await Promise.resolve(); });
    await settle();
    expect(api.workspacesList).toHaveBeenCalledTimes(1);
    unmount();
  });

  it('subscribes to main while attached and polls on the tick', async () => {
    vi.useFakeTimers();
    installElectronApi({
      mainTick: true,
      workspaces: [{ id: 'ws-1', name: 'Remote WS', panes: [{ sessionId: 'a' }, { sessionId: 'new' }] }],
    });
    mount();
    seedAttached([{ sessionId: 'a' }]);
    await settle();
    expect(api.pollSubscribe).toHaveBeenCalledTimes(1);
    api.workspacesList!.mockClear();

    await act(async () => { tickCb?.(); await Promise.resolve(); });
    await settle();

    expect(api.workspacesList).toHaveBeenCalledTimes(1);
    // The tick is a real liveness feed, not just a request: the pane opened on
    // the remote landed in the store.
    expect(useStore.getState().remoteWorkspaces[0].panes.map((p) => p.sessionId))
      .toEqual(['a', 'new']);
    unmount();
  });

  it('does not subscribe while nothing is attached, and unsubscribes on detach', async () => {
    vi.useFakeTimers();
    installElectronApi({ mainTick: true, workspaces: [] });
    mount();
    await settle();
    expect(api.pollSubscribe).not.toHaveBeenCalled();

    seedAttached([{ sessionId: 'a' }]);
    await settle();
    expect(api.pollSubscribe).toHaveBeenCalledTimes(1);

    act(() => { useStore.setState((s) => { s.remoteWorkspaces = []; }); });
    await settle();
    expect(pollUnsub).toHaveBeenCalledTimes(1);
    expect(tickOff).toHaveBeenCalledTimes(1);
    unmount();
  });

  it('unsubscribes on unmount — no tick outlives the hook', async () => {
    vi.useFakeTimers();
    installElectronApi({ mainTick: true, workspaces: [] });
    mount();
    seedAttached([{ sessionId: 'a' }]);
    await settle();

    unmount();
    expect(pollUnsub).toHaveBeenCalledTimes(1);
    expect(tickOff).toHaveBeenCalledTimes(1);
  });

  it('falls back to a renderer interval when the preload has no tick route', async () => {
    vi.useFakeTimers();
    // No mainTick — an older preload bundle. Freshness degrades to whatever
    // Chromium allows, but the poll must NOT disappear.
    installElectronApi({ workspaces: [] });
    mount();
    seedAttached([{ sessionId: 'a' }]);
    await settle();
    api.workspacesList.mockClear();

    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });

    expect(api.workspacesList).toHaveBeenCalledTimes(1);
    unmount();
  });

  it('polls IMMEDIATELY when the window becomes visible again', async () => {
    vi.useFakeTimers();
    installElectronApi({ mainTick: true, workspaces: [] });
    mount();
    seedAttached([{ sessionId: 'a' }]);
    await settle();
    api.workspacesList.mockClear();

    setVisibility('hidden');
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
      await Promise.resolve();
    });
    expect(api.workspacesList).not.toHaveBeenCalled();

    // Back to the window: the first frame the user sees must not be stale.
    setVisibility('visible');
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
      await Promise.resolve();
    });
    await settle();

    expect(api.workspacesList).toHaveBeenCalledTimes(1);
    unmount();
  });

  it('polls IMMEDIATELY on window focus', async () => {
    vi.useFakeTimers();
    installElectronApi({ mainTick: true, workspaces: [] });
    mount();
    seedAttached([{ sessionId: 'a' }]);
    await settle();
    api.workspacesList.mockClear();

    await act(async () => { window.dispatchEvent(new Event('focus')); await Promise.resolve(); });
    await settle();

    expect(api.workspacesList).toHaveBeenCalledTimes(1);
    unmount();
  });

  it('rate-limits the catch-up so alt-tab thrash costs ONE round', async () => {
    vi.useFakeTimers();
    installElectronApi({ mainTick: true, workspaces: [] });
    mount();
    seedAttached([{ sessionId: 'a' }]);
    await settle();
    api.workspacesList.mockClear();

    // visibilitychange + focus both fire on one alt-tab, and the user flicks —
    // with REAL time passing between flicks, or the gate would hold trivially.
    for (let i = 0; i < 5; i++) {
      await act(async () => {
        document.dispatchEvent(new Event('visibilitychange'));
        window.dispatchEvent(new Event('focus'));
        await Promise.resolve();
      });
      await act(async () => { await vi.advanceTimersByTimeAsync(400); });
    }
    await settle();
    expect(api.workspacesList).toHaveBeenCalledTimes(1);

    // Past the gap, a genuine return polls again.
    await act(async () => { await vi.advanceTimersByTimeAsync(2_500); });
    await act(async () => { window.dispatchEvent(new Event('focus')); await Promise.resolve(); });
    await settle();
    expect(api.workspacesList).toHaveBeenCalledTimes(2);
    unmount();
  });

  // The catch-up needs the same drop-not-queue rule as the tick, and for a
  // sharper reason: a round against a sleeping host runs for 20s, `focus` is
  // bound raw (alt-tab, DevTools closing, a tray show, a notification click all
  // land there), and every one of those is more than the 2s gate past the
  // round's start. Queued, each would make the `finally` start another round
  // the instant the last ended — an unbounded loop against a dead host.
  it('a focus event during an in-flight round is DROPPED, not queued', async () => {
    vi.useFakeTimers();
    const slow = deferred<ListResult>();
    installElectronApi({ mainTick: true, listImpl: () => slow.promise });
    mount();
    seedAttached([{ sessionId: 'a' }]);
    await settle();
    api.workspacesList.mockClear();

    await act(async () => { tickCb?.(); await Promise.resolve(); });
    expect(api.workspacesList).toHaveBeenCalledTimes(1);

    // Focus events well past the 2s gate, while the host still has not answered.
    for (const at of [2_500, 5_000, 7_500]) {
      await act(async () => { await vi.advanceTimersByTimeAsync(at); });
      await act(async () => { window.dispatchEvent(new Event('focus')); await Promise.resolve(); });
    }
    await act(async () => {
      slow.resolve({ ok: false as const, error: 'could not reach that host' });
      await Promise.resolve();
    });
    await settle();

    expect(api.workspacesList).toHaveBeenCalledTimes(1);
    unmount();
  });

  // Lifting the DEADLINE, not dropping the entry. Dropping it would reset
  // `failures` to 0, so a user switching windows would hold #1385's exponential
  // ladder at its first step forever against a host that is plainly dead.
  it('the catch-up lifts the backoff deadline without resetting the ladder', async () => {
    vi.useFakeTimers();
    installElectronApi({ mainTick: true, listFails: true });
    mount();
    seedAttached([{ sessionId: 'a' }]);
    await settle();

    // Two failed rounds: the ladder is at 20s.
    await act(async () => { tickCb?.(); await Promise.resolve(); });
    await settle();
    await act(async () => { await vi.advanceTimersByTimeAsync(11_000); });
    await act(async () => { tickCb?.(); await Promise.resolve(); });
    await settle();

    // A catch-up retries now, fails, and the ladder CLIMBS to 40s rather than
    // starting over at 10s.
    await act(async () => { await vi.advanceTimersByTimeAsync(2_500); });
    await act(async () => { window.dispatchEvent(new Event('focus')); await Promise.resolve(); });
    await settle();
    api.workspacesList.mockClear();

    // 25s later: past a reset ladder's 10s step, still inside the real 40s one.
    await act(async () => { await vi.advanceTimersByTimeAsync(25_000); });
    await act(async () => { tickCb?.(); await Promise.resolve(); });
    await settle();

    expect(api.workspacesList).not.toHaveBeenCalled();
    unmount();
  });

  // A tick round in which every host is backed off makes no request at all.
  // Letting that count as "just refreshed" would swallow the next return to the
  // window — the exact moment the catch-up exists to serve.
  it('a no-op tick round does not starve the next catch-up', async () => {
    vi.useFakeTimers();
    installElectronApi({ mainTick: true, listFails: true });
    mount();
    seedAttached([{ sessionId: 'a' }]);
    await settle();

    // One failure puts the host on a 10s deadline.
    await act(async () => { tickCb?.(); await Promise.resolve(); });
    await settle();
    // A tick 1s later: due-filtered, zero requests, but a round "started".
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    await act(async () => { tickCb?.(); await Promise.resolve(); });
    await settle();
    api.workspacesList.mockClear();

    // The user returns immediately after that empty round.
    await act(async () => { window.dispatchEvent(new Event('focus')); await Promise.resolve(); });
    await settle();

    expect(api.workspacesList).toHaveBeenCalledTimes(1);
    unmount();
  });

  // Main drops every subscriber on `will-quit` and in its disposer without
  // telling anyone, and neither is a rejection. A renderer that kept believing
  // it was subscribed would poll nothing for the rest of the session.
  it('falls back when a LIVE subscription silently stops ticking', async () => {
    vi.useFakeTimers();
    installElectronApi({ mainTick: true, workspaces: [] });
    mount();
    seedAttached([{ sessionId: 'a' }]);
    await settle();
    expect(api.pollSubscribe).toHaveBeenCalledTimes(1);
    api.workspacesList.mockClear();

    // Ticks just stop. Past the watchdog's patience the renderer takes over.
    await act(async () => { await vi.advanceTimersByTimeAsync(31_000); });
    // The tick listener is torn down, so exactly one driver is live.
    expect(tickOff).toHaveBeenCalled();
    api.workspacesList.mockClear();

    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(api.workspacesList).toHaveBeenCalledTimes(1);
    unmount();
  });

  it('a healthy tick keeps the watchdog from ever arming the fallback', async () => {
    vi.useFakeTimers();
    installElectronApi({ mainTick: true, workspaces: [] });
    mount();
    seedAttached([{ sessionId: 'a' }]);
    await settle();
    api.workspacesList.mockClear();

    // Six rounds of main ticking on time, across two watchdog windows.
    for (let i = 0; i < 6; i++) {
      await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
      await act(async () => { tickCb?.(); await Promise.resolve(); });
      await settle();
    }

    expect(tickOff).not.toHaveBeenCalled();
    // Exactly the six ticks — no fallback interval doubling them up.
    expect(api.workspacesList).toHaveBeenCalledTimes(6);
    unmount();
  });

  // Detach and re-attach faster than one IPC round trip: subscribe(A) →
  // subscribe(B) → A's late unsubscribe. The counts must balance, and the
  // renderer must not end up driving both a tick and a fallback interval.
  it('a detach/re-attach mid-subscribe leaves exactly one live driver', async () => {
    vi.useFakeTimers();
    installElectronApi({ mainTick: true, workspaces: [] });
    mount();
    seedAttached([{ sessionId: 'a' }]);
    act(() => { useStore.setState((s) => { s.remoteWorkspaces = []; }); });
    seedAttached([{ sessionId: 'a' }]);
    await settle();

    expect(api.pollSubscribe).toHaveBeenCalledTimes(2);
    expect(pollUnsub).toHaveBeenCalledTimes(1);
    api.workspacesList.mockClear();

    // No renderer interval was armed alongside the live subscription.
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(api.workspacesList).not.toHaveBeenCalled();
    unmount();
  });

  it('does not catch up while nothing is attached', async () => {
    vi.useFakeTimers();
    installElectronApi({ mainTick: true, workspaces: [] });
    mount();
    await settle();

    await act(async () => { window.dispatchEvent(new Event('focus')); await Promise.resolve(); });
    await settle();

    expect(api.workspacesList).not.toHaveBeenCalled();
    unmount();
  });

  it('a focus event after unmount polls nothing', async () => {
    vi.useFakeTimers();
    installElectronApi({ mainTick: true, workspaces: [] });
    mount();
    seedAttached([{ sessionId: 'a' }]);
    await settle();
    unmount();
    api.workspacesList.mockClear();

    await act(async () => { window.dispatchEvent(new Event('focus')); await Promise.resolve(); });

    expect(api.workspacesList).not.toHaveBeenCalled();
  });

  // A tick is a HEARTBEAT: it carries no information, so one that lands during
  // a round must be dropped, not queued. One round against a sleeping host can
  // take 20s (config probe timeout + workspaces timeout) while ticks keep
  // arriving every 10s — queueing them would make each round start the next the
  // instant it ended, which is a continuous request loop, not a 10s poll.
  it('a tick during an in-flight round is DROPPED, not queued', async () => {
    vi.useFakeTimers();
    const slow = deferred<ListResult>();
    installElectronApi({ mainTick: true, listImpl: () => slow.promise });
    mount();
    seedAttached([{ sessionId: 'a' }]);
    await settle();
    api.workspacesList.mockClear();

    await act(async () => { tickCb?.(); await Promise.resolve(); });
    expect(api.workspacesList).toHaveBeenCalledTimes(1);

    // Two more ticks while the host has not answered.
    await act(async () => { tickCb?.(); tickCb?.(); await Promise.resolve(); });
    await act(async () => {
      slow.resolve({ ok: true as const, workspaces: [] });
      await Promise.resolve();
    });
    await settle();

    // Still one. A queued tick would have fired a second round out of the
    // `finally` the moment the first one finished.
    expect(api.workspacesList).toHaveBeenCalledTimes(1);
    unmount();
  });

  // The case #1391 is actually about: window left in the background while the
  // other machine slept. By the time the user looks again the host is backed
  // off, so a plain refresh would filter it out of `due` and make NO request —
  // the rows would stay stale for another five minutes with the user watching.
  it('coming back to the window CLEARS the backoff so a slept host is retried now', async () => {
    vi.useFakeTimers();
    installElectronApi({ mainTick: true, listFails: true });
    mount();
    seedAttached([{ sessionId: 'a' }]);
    await settle();

    // Three failed rounds, each waiting out the step before it: 10s, then 20s.
    // The host is now backed off for 40s.
    for (const wait of [11_000, 21_000]) {
      await act(async () => { tickCb?.(); await Promise.resolve(); });
      await settle();
      await act(async () => { await vi.advanceTimersByTimeAsync(wait); });
    }
    await act(async () => { tickCb?.(); await Promise.resolve(); });
    await settle();
    api.workspacesList.mockClear();

    // A tick inside the backoff window asks nothing — that is the feature.
    await act(async () => { tickCb?.(); await Promise.resolve(); });
    await settle();
    expect(api.workspacesList).not.toHaveBeenCalled();

    // The user comes back. Past the catch-up's own rate limit, but far inside
    // the host's backoff.
    await act(async () => { await vi.advanceTimersByTimeAsync(3_000); });
    await act(async () => { window.dispatchEvent(new Event('focus')); await Promise.resolve(); });
    await settle();

    expect(api.workspacesList).toHaveBeenCalledTimes(1);
    unmount();
  });

  it('falls back to a renderer interval when the subscribe REJECTS', async () => {
    vi.useFakeTimers();
    // The route exists (so the member check passes) but main has no handler.
    installElectronApi({ mainTick: true, subscribeFails: true, workspaces: [] });
    mount();
    seedAttached([{ sessionId: 'a' }]);
    await settle();
    api.workspacesList.mockClear();

    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });

    // Throttled freshness beats no poll at all.
    expect(api.workspacesList).toHaveBeenCalledTimes(1);
    unmount();
  });

  // On Windows `document.visibilityState` is a constant — it stays 'visible'
  // while the window is minimized or fully covered (#882 measured it). The
  // main-owned window-displayed signal is the only trigger that fires there.
  it('catches up when MAIN reports the window displayed again', async () => {
    vi.useFakeTimers();
    installElectronApi({ mainTick: true, workspaces: [] });
    let pushDisplayed: ((v: boolean) => void) | undefined;
    const stopStore = windowDisplayedStore.init({
      isDisplayed: async () => true,
      onDisplayedChanged: (cb) => { pushDisplayed = cb; return () => undefined; },
    });
    mount();
    seedAttached([{ sessionId: 'a' }]);
    await settle();

    // Window minimized: no catch-up, and no visibilitychange on Windows either.
    await act(async () => { pushDisplayed?.(false); await Promise.resolve(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(3_000); });
    api.workspacesList.mockClear();

    await act(async () => { pushDisplayed?.(true); await Promise.resolve(); });
    await settle();

    expect(api.workspacesList).toHaveBeenCalledTimes(1);
    stopStore();
    unmount();
  });
});
