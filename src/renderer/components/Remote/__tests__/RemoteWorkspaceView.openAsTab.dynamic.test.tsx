// @vitest-environment jsdom
//
// #1323 item 2 — "Open as tab" on a mirror-grid session: the session the grid
// is watching becomes a remote-terminal tab in one of this computer's own
// workspaces (the #1100 Surface model), without minting anything on the host.
//
// Real store. The grid and a real RemotePaneSurface (rendered for every
// remote tab in the store, as Pane.tsx would) are mounted side by side, so
// both views of one session are observed end to end. The fake bridge models
// main's attach (remote.handler.ts, REMOTE_PANE_ATTACH): one stream per
// (host, session), one viewer id per attach call, idempotent detach per id,
// and the stream closes when its last viewer detaches. The mirror stub
// detaches its id on unmount, as the real RemoteMirrorTerminal does, so each
// view releases its id twice.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act, createElement, Fragment } from 'react';
import { useShallow } from 'zustand/react/shallow';
import RemoteWorkspaceView from '../RemoteWorkspaceView';
import RemotePaneSurface from '../RemotePaneSurface';
import { useStore } from '../../../stores';
import { createRemoteSurface, createSurface, createWorkspace, type Workspace, type Surface } from '../../../../shared/types';
import { formatShadowWorkspaceId } from '../../../../shared/pcRail';
import { getLeafPanes } from '../../../../shared/paneUtils';
import { destroySurfaceRemoteSession } from '../../../utils/remoteSessionTeardown';
import type { AttachedRemoteWorkspace } from '../../../stores/slices/remoteWorkspacesSlice';

vi.mock('../RemoteMirrorTerminal', async () => {
  const { createElement: h, useEffect } = await import('react');
  return {
    default: function MirrorStub({ attachId }: { attachId: string | null }) {
      useEffect(() => () => {
        if (attachId) void window.electronAPI?.remote?.paneDetach(attachId);
      }, [attachId]);
      return h('div', { 'data-mirror-attach-id': attachId ?? '' });
    },
  };
});
vi.mock('../RemoteResumeChip', () => ({ default: () => null }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const MIRROR: AttachedRemoteWorkspace = {
  key: 'host-1:ws-on-host',
  hostId: 'host-1',
  hostLabel: 'office-mac',
  workspaceId: 'ws-on-host',
  name: 'api',
  panes: [{ sessionId: 'sess-1', shell: 'zsh', cwd: '/srv/api' }],
};

let container: HTMLDivElement;
let root: Root;
let saved: Partial<ReturnType<typeof useStore.getState>>;
let first: Workspace;
let target: Workspace;
let shadow: Workspace;
/** Streams opened and closed, in order. */
let opened: string[];
let closed: string[];
/** Viewer ids main still holds. */
let live: Set<string>;
let sessionClose: ReturnType<typeof vi.fn>;
let workspaceCreate: ReturnType<typeof vi.fn>;

function installBridge(opts: { refuseAttach?: boolean } = {}): void {
  opened = [];
  closed = [];
  live = new Set();
  const streams = new Map<string, { id: string; viewers: Set<string> }>();
  const viewerKey = new Map<string, string>();
  let next = 0;
  let seq = 0;
  sessionClose = vi.fn().mockResolvedValue({ ok: true });
  workspaceCreate = vi.fn().mockResolvedValue({ ok: true, sessionId: 'minted' });
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    remote: {
      hostsList: vi.fn(async () => [{ id: 'host-1', label: 'office-mac', origin: 'https://office-mac.ts.net', addedAt: 1, allowInput: true }]),
      paneAttach: vi.fn(async (hostId: string, sessionId: string) => {
        if (opts.refuseAttach) return { ok: false, error: 'host refused' };
        const key = `${hostId}:${sessionId}`;
        let stream = streams.get(key);
        let viewer: string;
        if (stream) {
          seq += 1;
          viewer = `${stream.id}~${seq}`;
        } else {
          next += 1;
          stream = { id: `att-${next}`, viewers: new Set() };
          streams.set(key, stream);
          opened.push(stream.id);
          viewer = stream.id;
        }
        stream.viewers.add(viewer);
        viewerKey.set(viewer, key);
        live.add(viewer);
        return { ok: true, attachId: viewer };
      }),
      paneDetach: vi.fn(async (viewer: string) => {
        const key = viewerKey.get(viewer);
        viewerKey.delete(viewer);
        live.delete(viewer);
        const stream = key ? streams.get(key) : undefined;
        if (!key || !stream) return;
        stream.viewers.delete(viewer);
        if (stream.viewers.size === 0) {
          streams.delete(key);
          closed.push(stream.id);
        }
      }),
      sessionClose,
      workspaceCreate,
    },
  };
}

/** Renders every remote-terminal tab in the store, as each Pane would. */
function RemoteTabs() {
  const tabs = useStore(useShallow((s) => s.workspaces.flatMap((ws) => getLeafPanes(ws.rootPane)
    .flatMap((leaf) => leaf.surfaces)
    .filter((sf) => sf.surfaceType === 'remote-terminal')
    .map((sf) => `${sf.id}|${sf.remoteHostId}|${sf.remoteSessionId}`))));
  return createElement('div', { 'data-tabs': '' }, tabs.map((entry) => {
    const [surfaceId, hostId, sessionId] = entry.split('|');
    return createElement('div', { key: surfaceId, 'data-tab': surfaceId },
      createElement(RemotePaneSurface, { hostId, sessionId, surfaceId, onTitleChange: () => undefined }));
  }));
}

async function flush(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 12; i++) await Promise.resolve();
  });
}

async function mount(): Promise<void> {
  act(() => root.render(createElement(Fragment, null,
    createElement(RemoteWorkspaceView, { workspace: MIRROR }),
    createElement(RemoteTabs),
  )));
  await flush();
}

const cellAction = (): HTMLElement => {
  const el = container.querySelector<HTMLElement>('[data-mirror-open-as-tab]');
  if (!el) throw new Error('no open-as-tab button');
  return el;
};
const mirrorAttachId = (): string | null =>
  container.querySelector('[data-tabs]')?.previousElementSibling
    ?.querySelector('[data-mirror-attach-id]')?.getAttribute('data-mirror-attach-id') ?? null;
const tabAttachId = (): string | null =>
  container.querySelector('[data-tab] [data-mirror-attach-id]')?.getAttribute('data-mirror-attach-id') ?? null;

function remoteTabs(): { ws: Workspace; paneId: string; surface: Surface }[] {
  return useStore.getState().workspaces.flatMap((ws) => getLeafPanes(ws.rootPane).flatMap((leaf) =>
    leaf.surfaces.filter((sf) => sf.surfaceType === 'remote-terminal').map((surface) => ({ ws, paneId: leaf.id, surface }))));
}

async function openAsTabIn(workspaceId: string): Promise<void> {
  act(() => cellAction().click());
  await flush();
  const row = document.querySelector<HTMLButtonElement>(`[data-open-as-tab-target="${workspaceId}"]`);
  if (!row) throw new Error(`no row for ${workspaceId}`);
  act(() => row.click());
  await flush();
}

beforeEach(() => {
  const s = useStore.getState();
  saved = {
    workspaces: s.workspaces,
    activeWorkspaceId: s.activeWorkspaceId,
    remoteWorkspaces: s.remoteWorkspaces,
    activeRemoteKey: s.activeRemoteKey,
    paneGate: s.paneGate,
  };
  first = createWorkspace('Workspace 1', 1);
  target = createWorkspace('Target', 2);
  for (const ws of [first, target]) {
    if (ws.rootPane.type !== 'leaf') throw new Error('fixture expects a leaf root');
    const local = createSurface(`pty-${ws.id}`, 'pwsh', '');
    ws.rootPane.surfaces = [local];
    ws.rootPane.activeSurfaceId = local.id;
  }
  // Another computer's workspace: never offered as a target.
  shadow = createWorkspace('Shadow', 3);
  shadow.id = formatShadowWorkspaceId('host-1', 'ws-on-host') ?? 'shadow';
  act(() => useStore.setState({
    workspaces: [first, target, shadow],
    activeWorkspaceId: first.id,
    remoteWorkspaces: [MIRROR],
    activeRemoteKey: MIRROR.key,
    paneGate: 'ready',
  }));
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  delete (window as unknown as { electronAPI?: unknown }).electronAPI;
  act(() => useStore.setState(saved));
});

describe('RemoteWorkspaceView — Open as tab (#1323 item 2)', () => {
  it('offers the action on a live mirror, listing only this computer’s own workspaces', async () => {
    installBridge();
    await mount();
    expect(mirrorAttachId()).toBe('att-1');
    expect(cellAction().textContent).toBe('Open as tab…');
    expect(cellAction().getAttribute('aria-label')).toBe('Open zsh as a tab');

    act(() => cellAction().click());
    await flush();

    const dialog = document.querySelector('.ui-dialog');
    expect(dialog?.textContent).toContain('Open as tab');
    expect(dialog?.textContent).toContain('It keeps running on office-mac');
    const targets = [...document.querySelectorAll('[data-open-as-tab-target]')].map((el) => el.getAttribute('data-open-as-tab-target'));
    expect(targets).toEqual([first.id, target.id]);
  });

  it('opens the session as a NOT-owned tab in the picked workspace and goes there', async () => {
    installBridge();
    await mount();

    await openAsTabIn(target.id);

    const tabs = remoteTabs();
    expect(tabs).toHaveLength(1);
    const [{ ws, paneId, surface }] = tabs;
    expect(ws.id).toBe(target.id);
    expect(paneId).toBe(target.activePaneId);
    expect(surface).toMatchObject({ remoteHostId: 'host-1', remoteSessionId: 'sess-1', remoteWorkspaceId: 'ws-on-host', ptyId: '' });
    // Not minted, so not owned: closing it must never end the host's session.
    expect(surface.remoteOwned).toBeUndefined();
    expect(workspaceCreate).not.toHaveBeenCalled();
    // The jump left the mirror for the target workspace, on the new tab.
    const st = useStore.getState();
    expect(st.activeRemoteKey).toBeNull();
    expect(st.activeWorkspaceId).toBe(target.id);
    expect(st.workspaces.find((w) => w.id === target.id)?.rootPane).toMatchObject({ activeSurfaceId: surface.id });
    expect(document.querySelector('.ui-dialog')).toBeNull();
    expect(cellAction().textContent).toBe('Go to tab');
  });

  it('both views stay live on one stream; closing the tab leaves the mirror streaming and the host session running', async () => {
    installBridge();
    await mount();
    await openAsTabIn(target.id);

    // One stream, two live viewers: the cell's and the tab's. The tab's extra
    // meta join was released at once.
    expect(opened).toEqual(['att-1']);
    expect(mirrorAttachId()).toBe('att-1');
    const tabId = tabAttachId();
    expect(tabId).toMatch(/^att-1~/);
    expect(live).toEqual(new Set(['att-1', tabId]));

    // Pane.tsx's close path: teardown (gated on remoteOwned), then the store.
    const [{ ws, paneId, surface }] = remoteTabs();
    destroySurfaceRemoteSession(surface);
    act(() => useStore.getState().closeSurface(paneId, surface.id, ws.id));
    await flush();

    expect(sessionClose).not.toHaveBeenCalled();
    expect(remoteTabs()).toHaveLength(0);
    // The tab released its id (twice: owner and mirror); the cell's stream
    // is untouched and was never re-opened.
    expect(closed).toEqual([]);
    expect(live).toEqual(new Set(['att-1']));
    expect(mirrorAttachId()).toBe('att-1');
    expect(cellAction().textContent).toBe('Open as tab…');

    // The last view going away closes the stream.
    act(() => root.render(createElement(Fragment)));
    await flush();
    expect(closed).toEqual(['att-1']);
    expect(live).toEqual(new Set());
  });

  it('"Go to tab" jumps to the tab that already shows the session', async () => {
    installBridge();
    await mount();
    await openAsTabIn(target.id);
    const [{ surface }] = remoteTabs();
    act(() => useStore.setState({ activeWorkspaceId: first.id, activeRemoteKey: MIRROR.key }));

    act(() => cellAction().click());
    await flush();

    expect(document.querySelector('.ui-dialog')).toBeNull();
    expect(useStore.getState().activeRemoteKey).toBeNull();
    expect(useStore.getState().activeWorkspaceId).toBe(target.id);
    expect(remoteTabs().map((t) => t.surface.id)).toEqual([surface.id]);
  });

  it('a session another tab already shows (even another computer’s shadow) offers "Go to tab", which goes there', async () => {
    installBridge();
    // The store opens a session in one tab only, shadows included
    // (addRemoteSurface's one-viewer rule), so "Open as tab" could not succeed.
    if (shadow.rootPane.type !== 'leaf') throw new Error('fixture expects a leaf root');
    const shown = createRemoteSurface('host-1', 'sess-1', '', '');
    shadow.rootPane.surfaces = [shown];
    shadow.rootPane.activeSurfaceId = shown.id;
    act(() => useStore.setState({ workspaces: [first, target, shadow] }));
    await mount();
    expect(cellAction().textContent).toBe('Go to tab');
    // The grid keeps its own live view alongside.
    expect(mirrorAttachId()).toBe('att-1');

    act(() => cellAction().click());
    await flush();
    expect(useStore.getState().activeWorkspaceId).toBe(shadow.id);
    expect(remoteTabs()).toHaveLength(1);
  });

  it('offers nothing while the host refuses the attach', async () => {
    installBridge({ refuseAttach: true });
    await mount();
    expect(container.querySelector('[data-mirror-open-as-tab]')).toBeNull();
  });
});
