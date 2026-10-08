// @vitest-environment jsdom
//
// Per-pane Chrome profile items in the pane actions menu (⋮ / right-click):
// "Browser profile ›" (a submenu in the same popover) and "Show in Chrome".
// Mounts the REAL SurfaceTabs against the REAL store with the preload's
// chromeProfiles surface mocked — main's handlers are not under test here.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import SurfaceTabs from '../SurfaceTabs';
import { useStore } from '../../../stores';
import type { Workspace } from '../../../../shared/types';
import type { ChromeProfilesListResult } from '../../../../shared/chromePaneBinding';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
let listResult: ChromeProfilesListResult;
type Reply = { ok: boolean; error?: string };
const ok = async (): Promise<Reply> => ({ ok: true });
const api = {
  list: vi.fn(async () => listResult),
  create: vi.fn<(name: string) => Promise<Reply>>(ok),
  bind: vi.fn(ok),
  bindPane: vi.fn<(paneId: string, workspaceId: string, profile: string | null) => Promise<Reply>>(ok),
  revealPane: vi.fn<(paneId: string, workspaceId: string) => Promise<Reply>>(ok),
};

function activeWs(): Workspace {
  return useStore.getState().workspaces.find((w) => w.id === useStore.getState().activeWorkspaceId)!;
}

function mount(): { paneId: string; wsId: string } {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  const ws = activeWs();
  const paneId = ws.rootPane.id;
  act(() => {
    root.render(
      React.createElement(SurfaceTabs, {
        surfaces: [],
        activeSurfaceId: '',
        workspace: ws,
        paneId,
        paneActive: true,
        actionsMode: 'overflow',
        onSelect: () => undefined,
        onClose: () => undefined,
        onSplitHorizontal: () => undefined,
        onSplitVertical: () => undefined,
        onAddTerminal: () => undefined,
        onAddBrowser: () => undefined,
      }),
    );
  });
  return { paneId, wsId: ws.id };
}

/** Let the list()/create()/bindPane() promise chains settle. */
async function flush(): Promise<void> {
  await act(async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); });
}

async function openMenu(): Promise<void> {
  const trigger = container.querySelector<HTMLButtonElement>('[data-pane-overflow-trigger]')!;
  act(() => { trigger.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
  await flush();
}

function item(key: string): HTMLButtonElement | null {
  return document.querySelector<HTMLButtonElement>(`[data-pane-menu-action="${key}"]`);
}

async function clickItem(key: string): Promise<void> {
  const el = item(key);
  expect(el, `menu item "${key}"`).not.toBeNull();
  act(() => { el!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
  await flush();
}

async function openProfileSubmenu(): Promise<void> {
  await openMenu();
  await clickItem('browser-profile');
}

beforeEach(() => {
  const state = useStore.getState();
  for (const w of [...state.workspaces]) state.removeWorkspace(w.id);
  state.addWorkspace();
  state.setPaneActionsVisible(true);
  state.setBrowserBackend('chrome');
  useStore.setState({ toasts: [] });
  listResult = { profiles: ['default', 'live', 'shop', 'work'], bindings: {}, paneBindings: {} };
  for (const fn of Object.values(api)) fn.mockClear();
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    browser: { chromeProfiles: api },
  };
});

afterEach(() => {
  act(() => { root.unmount(); });
  container.remove();
  delete (window as unknown as { electronAPI?: unknown }).electronAPI;
});

describe('SurfaceTabs — per-pane Chrome profile', () => {
  it('hides both items off the chrome backend', async () => {
    useStore.getState().setBrowserBackend('builtin');
    mount();
    await openMenu();
    expect(item('split-right')).not.toBeNull();
    expect(item('browser-profile')).toBeNull();
    expect(item('show-in-chrome')).toBeNull();
    expect(api.list).not.toHaveBeenCalled();
  });

  it('lists registered profiles except default and live, checking the current binding', async () => {
    mountWithBinding('work');
    await openProfileSubmenu();
    expect(item('profile:default')).toBeNull();
    expect(item('profile:live')).toBeNull();
    expect(item('profile:shop')?.getAttribute('aria-checked')).toBe('false');
    expect(item('profile:work')?.getAttribute('aria-checked')).toBe('true');
    expect(item('profile-unbind')).not.toBeNull();
  });

  it('ignores a binding recorded under another workspace', async () => {
    const ws = activeWs();
    listResult.paneBindings = { [ws.rootPane.id]: { workspaceId: 'other-ws', profile: 'work' } };
    mount();
    await openProfileSubmenu();
    expect(item('profile:work')?.getAttribute('aria-checked')).toBe('false');
    expect(item('profile-unbind')).toBeNull();
  });

  it('binds a listed profile to this pane', async () => {
    const { paneId, wsId } = mount();
    await openProfileSubmenu();
    await clickItem('profile:shop');
    expect(api.bindPane).toHaveBeenCalledWith(paneId, wsId, 'shop');
  });

  it('New profile: sanitized, de-duplicated name, created then bound', async () => {
    const ws = activeWs();
    useStore.getState().setPaneLabel(ws.rootPane.id, 'Work');
    const { paneId, wsId } = mount();
    await openProfileSubmenu();
    await clickItem('profile-new');
    // 'work' is taken (case-insensitively) → 'Work-2'.
    expect(api.create).toHaveBeenCalledWith('Work-2');
    expect(api.bindPane).toHaveBeenCalledWith(paneId, wsId, 'Work-2');
    expect(api.create.mock.invocationCallOrder[0]).toBeLessThan(api.bindPane.mock.invocationCallOrder[0]);
  });

  it('New profile: a failed create toasts its error and never binds', async () => {
    api.create.mockResolvedValueOnce({ ok: false, error: 'at most 20 Chrome profiles' });
    mount();
    await openProfileSubmenu();
    await clickItem('profile-new');
    expect(api.bindPane).not.toHaveBeenCalled();
    const toasts = useStore.getState().toasts;
    expect(toasts.at(-1)).toMatchObject({ level: 'error', message: 'at most 20 Chrome profiles' });
  });

  it('New profile: aborts with a toast when the fresh profile list fails', async () => {
    mount();
    await openProfileSubmenu();
    api.list.mockRejectedValueOnce(new Error('ipc down'));
    await clickItem('profile-new');
    expect(api.create).not.toHaveBeenCalled();
    expect(api.bindPane).not.toHaveBeenCalled();
    expect(useStore.getState().toasts.at(-1)).toMatchObject({ level: 'error' });
  });

  it('Use workspace profile unbinds the pane', async () => {
    const { paneId, wsId } = mountWithBinding('work');
    await openProfileSubmenu();
    await clickItem('profile-unbind');
    expect(api.bindPane).toHaveBeenCalledWith(paneId, wsId, null);
  });

  it('a rejected bind shows the error as a toast', async () => {
    api.bindPane.mockResolvedValueOnce({ ok: false, error: 'profile is bound to another pane' });
    mount();
    await openProfileSubmenu();
    await clickItem('profile:shop');
    expect(useStore.getState().toasts.at(-1)).toMatchObject({
      level: 'error',
      message: 'profile is bound to another pane',
    });
  });

  it('Show in Chrome reveals this pane', async () => {
    const { paneId, wsId } = mount();
    await openMenu();
    await clickItem('show-in-chrome');
    expect(api.revealPane).toHaveBeenCalledWith(paneId, wsId);
    expect(useStore.getState().toasts).toHaveLength(0);
  });

  it('Show in Chrome failure toasts', async () => {
    api.revealPane.mockResolvedValueOnce({ ok: false, error: 'no Chrome tab for this pane' });
    mount();
    await openMenu();
    await clickItem('show-in-chrome');
    expect(useStore.getState().toasts.at(-1)).toMatchObject({ level: 'error', message: 'no Chrome tab for this pane' });
  });

  it('Escape in the submenu steps back to the main menu', async () => {
    mount();
    await openProfileSubmenu();
    expect(item('split-right')).toBeNull();
    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(item('split-right')).not.toBeNull();
    expect(document.activeElement?.getAttribute('data-pane-menu-action')).toBe('browser-profile');
  });
});

function mountWithBinding(profile: string): { paneId: string; wsId: string } {
  const ws = activeWs();
  listResult.paneBindings = { [ws.rootPane.id]: { workspaceId: ws.id, profile } };
  return mount();
}
