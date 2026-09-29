// @vitest-environment jsdom
//
// #1323 — the + menu offers "Empty — remote" next to the local "Empty" row
// when (and only when) a host is paired. Picking it opens the same host picker
// the ⋮ menu's "Split right/down — remote" entries use, and the minted session
// lands in a NEW workspace's single pane.
//
// EmptyLeafFunnel is mounted alongside on purpose: a new workspace starts with
// an empty leaf, and the funnel spawns a local PTY into any empty leaf it
// sees. The remote flow is only correct if the funnel never gets that chance.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act, createElement, Fragment } from 'react';
import PresetPicker from '../PresetPicker';
import { EmptyLeafFunnel } from '../../Layout/EmptyLeafFunnel';
import { useStore } from '../../../stores';
import { selectActiveEmptyLeafIdsKey } from '../../../stores/selectors/appLayout';
import { createSurface, createWorkspace, type Workspace } from '../../../../shared/types';
import type { RemoteHostPublic } from '../../../../shared/remoteHosts';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const HOST: RemoteHostPublic = { id: 'host-1', label: 'office-mac', origin: 'https://office-mac.ts.net', addedAt: 1 };

let container: HTMLDivElement;
let root: Root;
let ptyCreate: ReturnType<typeof vi.fn>;
let workspaceCreate: ReturnType<typeof vi.fn>;
let sessionClose: ReturnType<typeof vi.fn>;
let seeded: Workspace;
let saved: Partial<ReturnType<typeof useStore.getState>>;

function installBridge(hostsList: () => Promise<RemoteHostPublic[]>): void {
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    pty: { create: ptyCreate, dispose: vi.fn() },
    remote: { hostsList: vi.fn(hostsList), workspaceCreate, sessionClose },
  };
}

async function flush(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
  });
}

function mountPicker(onClose = vi.fn()): void {
  act(() => root.render(createElement(Fragment, null,
    createElement(PresetPicker, { onClose }),
    createElement(EmptyLeafFunnel),
  )));
}

function buttonByText(text: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes(text));
  if (!button) throw new Error(`no button containing "${text}"`);
  return button;
}

beforeEach(() => {
  const s = useStore.getState();
  saved = {
    workspaces: s.workspaces,
    activeWorkspaceId: s.activeWorkspaceId,
    paneGate: s.paneGate,
    nextWorkspaceOrdinal: s.nextWorkspaceOrdinal,
    remoteHubMounted: s.remoteHubMounted,
  };
  // The existing workspace already holds a terminal, so the funnel has nothing
  // to do until something creates an empty leaf.
  seeded = createWorkspace('Workspace 1', 1);
  if (seeded.rootPane.type !== 'leaf') throw new Error('fixture expects a leaf root');
  const surface = createSurface('pty-seed', 'pwsh', '');
  seeded.rootPane.surfaces = [surface];
  seeded.rootPane.activeSurfaceId = surface.id;
  act(() => useStore.setState({
    workspaces: [seeded],
    activeWorkspaceId: seeded.id,
    paneGate: 'ready',
    nextWorkspaceOrdinal: 2,
    remoteHubMounted: 0,
  }));

  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  ptyCreate = vi.fn().mockReturnValue(new Promise(() => undefined));
  workspaceCreate = vi.fn().mockResolvedValue({ ok: true, sessionId: 'sess-1' });
  sessionClose = vi.fn().mockResolvedValue({ ok: true });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  delete (window as unknown as { electronAPI?: unknown }).electronAPI;
  act(() => useStore.setState(saved));
});

describe('PresetPicker — local vs. remote for a new pane (#1323)', () => {
  it('with no paired host, renders exactly the menu it rendered before', async () => {
    // Baseline: no remote bridge at all — the pre-#1323 menu, since nothing
    // it renders ever depended on one.
    mountPicker();
    await flush();
    const baseline = container.innerHTML;
    act(() => root.unmount());
    root = createRoot(container);

    installBridge(() => Promise.resolve([]));
    mountPicker();
    await flush();

    expect(container.innerHTML).toBe(baseline);
    expect(container.querySelector('[data-preset-remote-pane]')).toBeNull();
  });

  it('with no paired host, "Empty" still makes a local pane', async () => {
    installBridge(() => Promise.resolve([]));
    mountPicker();
    await flush();

    act(() => buttonByText('Empty').click());
    await flush();

    // Control for the remote case below: the funnel does see a new empty
    // leaf here and asks for a local PTY.
    expect(useStore.getState().workspaces).toHaveLength(2);
    expect(ptyCreate).toHaveBeenCalledTimes(1);
  });

  it('a rejected host-list read leaves the row out', async () => {
    installBridge(() => Promise.reject(new Error('IPC closed')));
    mountPicker();
    await flush();
    expect(container.querySelector('[data-preset-remote-pane]')).toBeNull();
  });

  it('with a paired host, offers the remote row last, below "Attach remote workspace"', async () => {
    installBridge(() => Promise.resolve([HOST]));
    mountPicker();
    await flush();

    const rows = Array.from(container.querySelectorAll('button'));
    const remoteRow = container.querySelector('[data-preset-remote-pane]');
    expect(remoteRow?.textContent).toContain('Empty — remote');
    expect(remoteRow?.textContent).toContain('Blank single pane on a paired computer');
    // Arrives after the host list resolves, so it goes where it moves no row
    // already on screen.
    expect(rows[rows.length - 1]).toBe(remoteRow);
    expect(rows[rows.length - 2].textContent).toContain('Attach remote workspace');
  });

  it('opens the host picker named after the row, and puts the minted session in a new workspace’s pane', async () => {
    installBridge(() => Promise.resolve([HOST]));
    const onClose = vi.fn();
    mountPicker(onClose);
    await flush();

    act(() => (container.querySelector('[data-preset-remote-pane]') as HTMLButtonElement).click());
    await flush();

    const dialog = container.querySelector('.ui-dialog');
    expect(dialog).not.toBeNull();
    expect(dialog?.textContent).toContain('Empty — remote');
    // Nothing is created until a host is picked.
    expect(useStore.getState().workspaces).toHaveLength(1);

    await act(async () => buttonByText('office-mac').click());
    await flush();

    const mintedId = workspaceCreate.mock.calls[0][1] as string;
    expect(workspaceCreate).toHaveBeenCalledWith('host-1', mintedId);
    expect(mintedId).toMatch(/^remote-pane-/);

    const state = useStore.getState();
    expect(state.workspaces).toHaveLength(2);
    const created = state.workspaces[1];
    expect(state.activeWorkspaceId).toBe(created.id);
    if (created.rootPane.type !== 'leaf') throw new Error('expected a single leaf');
    expect(created.rootPane.surfaces).toHaveLength(1);
    const surface = created.rootPane.surfaces[0];
    expect(surface.surfaceType).toBe('remote-terminal');
    expect(surface.ptyId).toBe('');
    expect(surface.remoteHostId).toBe('host-1');
    expect(surface.remoteSessionId).toBe('sess-1');
    expect(surface.remoteOwned).toBe(true);
    expect(surface.remoteWorkspaceId).toBe(mintedId);
    expect(created.rootPane.activeSurfaceId).toBe(surface.id);

    // The funnel never saw an empty leaf: no local PTY was requested.
    expect(selectActiveEmptyLeafIdsKey(state)).toBe('');
    expect(ptyCreate).not.toHaveBeenCalled();
    // The existing workspace is untouched.
    expect(state.workspaces[0]).toBe(seeded);
    expect(sessionClose).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it('a failed mint creates no workspace', async () => {
    workspaceCreate = vi.fn().mockResolvedValue({ ok: false, error: 'host refused' });
    installBridge(() => Promise.resolve([HOST]));
    mountPicker();
    await flush();

    act(() => (container.querySelector('[data-preset-remote-pane]') as HTMLButtonElement).click());
    await flush();
    await act(async () => buttonByText('office-mac').click());
    await flush();

    expect(useStore.getState().workspaces).toHaveLength(1);
    expect(ptyCreate).not.toHaveBeenCalled();
    expect(container.textContent).toContain('host refused');
  });
});
