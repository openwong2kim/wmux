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

function installElectronApi(opts: {
  descriptors?: RemoteAttachmentDescriptor[];
  workspaces?: RemoteWorkspaceSummary[];
  listFails?: boolean;
} = {}): void {
  exitCb = undefined;
  exitUnsub = vi.fn();
  api = {
    attachmentsList: vi.fn(async () => opts.descriptors ?? []),
    attachmentsAdd: vi.fn(async () => true),
    attachmentsRemove: vi.fn(async () => true),
    workspacesList: vi.fn(async () =>
      opts.listFails
        ? { ok: false as const, error: 'could not reach that host' }
        : { ok: true as const, workspaces: opts.workspaces ?? [] }),
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
  it('does not poll while nothing is attached', async () => {
    vi.useFakeTimers();
    installElectronApi();
    mount();
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });

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

  it('stops polling once the last attachment is detached', async () => {
    vi.useFakeTimers();
    installElectronApi({ workspaces: [{ id: 'ws-1', name: 'Remote WS', panes: [{ sessionId: 'a' }] }] });
    mount();
    seedAttached([{ sessionId: 'a' }]);

    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(api.workspacesList).toHaveBeenCalledTimes(1);

    act(() => { useStore.getState().detachRemoteWorkspace('h1:ws-1'); });
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });

    expect(api.workspacesList).toHaveBeenCalledTimes(1);
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
});
