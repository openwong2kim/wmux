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
}

let api: RemoteApiStub;

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
} = {}): void {
  exitCb = undefined;
  exitUnsub = vi.fn();
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
