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
import { act, createElement, Fragment, useState } from 'react';
import PresetPicker from '../PresetPicker';
import { EmptyLeafFunnel } from '../../Layout/EmptyLeafFunnel';
import { useStore } from '../../../stores';
import { selectActiveEmptyLeafIdsKey } from '../../../stores/selectors/appLayout';
import { createSurface, createWorkspace, type Workspace } from '../../../../shared/types';
import type { RemoteHostPublic } from '../../../../shared/remoteHosts';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const HOST: RemoteHostPublic = { id: 'host-1', label: 'office-mac', origin: 'https://office-mac.ts.net', addedAt: 1 };

// The + menu exactly as origin/main 9190baaf (the commit #1323 branched from)
// rendered it with no anchor. Captured by rendering that commit's
// PresetPicker.tsx in this same jsdom setup, not written by hand; split at
// element boundaries for reading, the pieces join back to the captured bytes.
// What it pins: with no paired host, #1323 changes nothing in this menu. If
// the menu is changed on purpose later, recapture it from the new markup.
const ROW = '<button class="w-full text-left px-3 py-1.5 hover:bg-[var(--bg-surface)] text-[var(--text-main)] transition-colors">';
const SEPARATOR = '<div class="border-t border-[var(--bg-surface)] my-0.5"></div>';
const PRE_1323_MENU_HTML = [
  '<div class="wmux-workspace-menu absolute right-2 top-10 z-50 w-52 bg-[var(--bg-overlay)] border border-[var(--bg-surface)] rounded-md shadow-lg py-1 text-[13px]">',
  ROW, '<div class="font-semibold">Browse Folder…</div><div class="text-[var(--text-sub)] text-[11px]">Choose any folder on disk</div></button>',
  SEPARATOR,
  ROW, '<div class="font-semibold">Empty</div><div class="text-[var(--text-sub)] text-[11px]">Blank single pane</div></button>',
  SEPARATOR,
  ROW, '<div class="font-semibold">Horizontal Split</div><div class="text-[var(--text-sub)] text-[11px]">Two panes side by side</div></button>',
  ROW, '<div class="font-semibold">Vertical Split</div><div class="text-[var(--text-sub)] text-[11px]">Two panes stacked vertically</div></button>',
  ROW, '<div class="font-semibold">Three Columns</div><div class="text-[var(--text-sub)] text-[11px]">Three panes in a row</div></button>',
  ROW, '<div class="font-semibold">Main + Sidebar</div><div class="text-[var(--text-sub)] text-[11px]">Large left pane with smaller right pane</div></button>',
  ROW, '<div class="font-semibold">2x2 Grid</div><div class="text-[var(--text-sub)] text-[11px]">Four panes in a grid</div></button>',
  SEPARATOR,
  ROW, '<div class="font-semibold">Attach remote workspace…</div><div class="text-[var(--text-sub)] text-[11px]">Mirror a workspace from another wmux</div></button>',
  '</div>',
].join('');

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

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

/** Hosts the picker the way Titlebar, Sidebar and MiniSidebar do
 *  (`{pickerOpen && <PresetPicker onClose={closePicker} />}`): closing it
 *  unmounts it. A bare vi.fn() onClose would keep it mounted after every way
 *  out, which is not a state the app can be in. */
function PickerHost({ onClose }: { onClose: () => void }) {
  const [open, setOpen] = useState(true);
  return open
    ? createElement(PresetPicker, { onClose: () => { onClose(); setOpen(false); } })
    : null;
}

let mounts = 0;
/** Each call is a fresh picker, as each click on + makes one. */
function mountPicker(onClose = vi.fn()): void {
  mounts += 1;
  act(() => root.render(createElement(Fragment, null,
    createElement(PickerHost, { key: mounts, onClose }),
    createElement(EmptyLeafFunnel),
  )));
}

function buttonByText(text: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes(text));
  if (!button) throw new Error(`no button containing "${text}"`);
  return button;
}

function remoteRow(): HTMLButtonElement {
  const row = container.querySelector<HTMLButtonElement>('[data-preset-remote-pane]');
  if (!row) throw new Error('no "Empty — remote" row');
  return row;
}

/** Open "Empty — remote", pick the host; the mint is left to the caller. */
async function pickHost(): Promise<void> {
  act(() => remoteRow().click());
  await flush();
  await act(async () => buttonByText('office-mac').click());
}

const pressEscape = (): void => {
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
};
const clickBackdrop = (): void => {
  const backdrop = container.querySelector('.ui-dialog')?.parentElement;
  if (!backdrop) throw new Error('no dialog backdrop');
  backdrop.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
};

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
  it('with no paired host, renders the pre-#1323 menu byte for byte', async () => {
    // An empty host list, and no remote bridge at all: both are "no host".
    installBridge(() => Promise.resolve([]));
    mountPicker();
    await flush();
    expect(container.innerHTML).toBe(PRE_1323_MENU_HTML);

    delete (window as unknown as { electronAPI?: unknown }).electronAPI;
    mountPicker();
    await flush();
    expect(container.innerHTML).toBe(PRE_1323_MENU_HTML);
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

    act(() => remoteRow().click());
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
    // The dialog closed itself after creating (onCreated runs before
    // onClose), and the picker went with it.
    expect(onClose).toHaveBeenCalled();
    expect(container.querySelector('.ui-dialog')).toBeNull();
  });

  it('a failed mint creates no workspace', async () => {
    workspaceCreate = vi.fn().mockResolvedValue({ ok: false, error: 'host refused' });
    installBridge(() => Promise.resolve([HOST]));
    mountPicker();
    await flush();

    await pickHost();
    await flush();

    expect(useStore.getState().workspaces).toHaveLength(1);
    expect(ptyCreate).not.toHaveBeenCalled();
    expect(container.textContent).toContain('host refused');
  });

  // The modal reports the mint whenever the host answers (up to the request
  // timeout), whether or not it is still on screen. Every way out of it
  // unmounts the picker; an answer that arrives after that belongs to a
  // cancelled request.
  it.each([
    ['Escape', pressEscape],
    ['a backdrop click', clickBackdrop],
  ])('closing the dialog with %s while the host is minting creates nothing, and destroys the late session', async (_how, dismiss) => {
    const mint = deferred<{ ok: true; sessionId: string }>();
    workspaceCreate = vi.fn().mockImplementation(() => mint.promise);
    installBridge(() => Promise.resolve([HOST]));
    const onClose = vi.fn();
    mountPicker(onClose);
    await flush();

    await pickHost();
    expect(workspaceCreate).toHaveBeenCalledTimes(1);

    act(() => dismiss());
    await flush();
    expect(onClose).toHaveBeenCalled();
    expect(container.querySelector('.ui-dialog')).toBeNull();

    await act(async () => mint.resolve({ ok: true, sessionId: 'sess-late' }));
    await flush();

    // No workspace appears and the screen does not switch.
    const state = useStore.getState();
    expect(state.workspaces).toHaveLength(1);
    expect(state.workspaces[0]).toBe(seeded);
    expect(state.activeWorkspaceId).toBe(seeded.id);
    expect(ptyCreate).not.toHaveBeenCalled();
    // The session already exists on the host; nothing else would ever reap it.
    expect(sessionClose).toHaveBeenCalledTimes(1);
    expect(sessionClose).toHaveBeenCalledWith('host-1', 'sess-late');
  });

  it('a retry after a cancelled mint ends with one workspace, holding the retry’s session', async () => {
    const cancelled = deferred<{ ok: true; sessionId: string }>();
    const retried = deferred<{ ok: true; sessionId: string }>();
    workspaceCreate = vi.fn()
      .mockImplementationOnce(() => cancelled.promise)
      .mockImplementationOnce(() => retried.promise);
    installBridge(() => Promise.resolve([HOST]));

    mountPicker();
    await flush();
    await pickHost();
    act(() => pressEscape());
    await flush();

    // Open the menu again and pick the host again.
    mountPicker();
    await flush();
    await pickHost();
    expect(workspaceCreate).toHaveBeenCalledTimes(2);

    // The cancelled request's answer lands after the retry started.
    await act(async () => cancelled.resolve({ ok: true, sessionId: 'sess-cancelled' }));
    await flush();
    await act(async () => retried.resolve({ ok: true, sessionId: 'sess-retry' }));
    await flush();

    const state = useStore.getState();
    expect(state.workspaces).toHaveLength(2);
    const created = state.workspaces[1];
    expect(state.activeWorkspaceId).toBe(created.id);
    if (created.rootPane.type !== 'leaf') throw new Error('expected a single leaf');
    expect(created.rootPane.surfaces.map((s) => s.remoteSessionId)).toEqual(['sess-retry']);
    expect(sessionClose).toHaveBeenCalledTimes(1);
    expect(sessionClose).toHaveBeenCalledWith('host-1', 'sess-cancelled');
  });
});
