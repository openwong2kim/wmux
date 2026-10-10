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
import type { Surface, Workspace } from '../../../../shared/types';
import type { BrowserPolicyReadResult } from '../../../../shared/browserPolicy';
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
let policyResult: BrowserPolicyReadResult;
const policyApi = {
  get: vi.fn<(ws: string, pane: string) => Promise<BrowserPolicyReadResult>>(async () => policyResult),
  set: vi.fn(async () => ({ ok: true, epoch: 1 })),
};

function activeWs(): Workspace {
  return useStore.getState().workspaces.find((w) => w.id === useStore.getState().activeWorkspaceId)!;
}

function mount(surfaces: Surface[] = []): { paneId: string; wsId: string } {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  const ws = activeWs();
  const paneId = ws.rootPane.id;
  act(() => {
    root.render(
      React.createElement(SurfaceTabs, {
        surfaces,
        activeSurfaceId: surfaces[0]?.id ?? '',
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

function nameInput(): HTMLInputElement | null {
  return document.querySelector<HTMLInputElement>('[data-pane-new-profile-input]');
}

function typeName(value: string): void {
  const el = nameInput()!;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  act(() => {
    setter.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function submitName(): Promise<void> {
  const form = document.querySelector<HTMLFormElement>('[data-pane-new-profile-form]')!;
  act(() => { form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
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
  for (const fn of Object.values(policyApi)) fn.mockClear();
  policyResult = { ok: true, state: 'missing', epoch: 0, policy: null, currentProfile: 'default' };
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    browser: { chromeProfiles: api, policy: policyApi },
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

  it('disables profiles bound to a workspace or to another pane, with a reason', async () => {
    const ws = activeWs();
    listResult.bindings = { 'ws-other': 'shop' };
    listResult.paneBindings = {
      'pane-other': { workspaceId: ws.id, profile: 'work' },
      [ws.rootPane.id]: { workspaceId: ws.id, profile: 'mine' },
    };
    listResult.profiles = ['default', 'live', 'shop', 'work', 'mine', 'free'];
    mount();
    await openProfileSubmenu();
    expect(item('profile:shop')?.getAttribute('aria-disabled')).toBe('true');
    expect(item('profile:shop')?.title).toBe('In use by a workspace');
    expect(item('profile:work')?.getAttribute('aria-disabled')).toBe('true');
    expect(item('profile:work')?.title).toBe('In use by another pane');
    // This pane's own binding and a free profile stay enabled.
    expect(item('profile:mine')?.getAttribute('aria-disabled')).toBeNull();
    expect(item('profile:free')?.getAttribute('aria-disabled')).toBeNull();
    await clickItem('profile:shop');
    await clickItem('profile:work');
    expect(api.bindPane).not.toHaveBeenCalled();
  });

  it('binds a listed profile to this pane', async () => {
    const { paneId, wsId } = mount();
    await openProfileSubmenu();
    await clickItem('profile:shop');
    expect(api.bindPane).toHaveBeenCalledWith(paneId, wsId, 'shop');
  });

  it('New profile: opens a name field prefilled with the de-duplicated pane name; Create binds it', async () => {
    const ws = activeWs();
    useStore.getState().setPaneLabel(ws.rootPane.id, 'Work');
    const { paneId, wsId } = mount();
    await openProfileSubmenu();
    await clickItem('profile-new');
    expect(api.create).not.toHaveBeenCalled();
    // 'work' is taken (case-insensitively) → 'Work-2'.
    expect(nameInput()?.value).toBe('Work-2');
    await submitName();
    expect(api.create).toHaveBeenCalledWith('Work-2');
    expect(api.bindPane).toHaveBeenCalledWith(paneId, wsId, 'Work-2');
    expect(api.create.mock.invocationCallOrder[0]).toBeLessThan(api.bindPane.mock.invocationCallOrder[0]);
    expect(document.querySelector('[data-pane-actions-menu]')).toBeNull();
  });

  it('New profile: a typed name is created and bound (name it after the account)', async () => {
    const { paneId, wsId } = mount();
    await openProfileSubmenu();
    await clickItem('profile-new');
    typeName('  acme-admin ');
    await submitName();
    expect(api.create).toHaveBeenCalledWith('acme-admin');
    expect(api.bindPane).toHaveBeenCalledWith(paneId, wsId, 'acme-admin');
  });

  it('New profile: an existing name is refused in the form, never created or bound', async () => {
    mount();
    await openProfileSubmenu();
    await clickItem('profile-new');
    typeName('SHOP');
    await submitName();
    expect(api.create).not.toHaveBeenCalled();
    expect(api.bindPane).not.toHaveBeenCalled();
    expect(document.querySelector('[data-pane-new-profile-error]')?.textContent).toContain('already exists');
  });

  it('New profile: a failed create shows its error in the form and never binds', async () => {
    api.create.mockResolvedValueOnce({ ok: false, error: 'at most 20 Chrome profiles' });
    mount();
    await openProfileSubmenu();
    await clickItem('profile-new');
    await submitName();
    expect(api.bindPane).not.toHaveBeenCalled();
    expect(document.querySelector('[data-pane-new-profile-error]')?.textContent).toBe('at most 20 Chrome profiles');
    expect(nameInput()).not.toBeNull();
  });

  it('New profile: aborts with an error when the fresh profile list fails', async () => {
    mount();
    await openProfileSubmenu();
    await clickItem('profile-new');
    api.list.mockRejectedValueOnce(new Error('ipc down'));
    await submitName();
    expect(api.create).not.toHaveBeenCalled();
    expect(api.bindPane).not.toHaveBeenCalled();
    expect(document.querySelector('[data-pane-new-profile-error]')).not.toBeNull();
  });

  it('New profile: Escape steps back to the profile submenu', async () => {
    mount();
    await openProfileSubmenu();
    await clickItem('profile-new');
    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(nameInput()).toBeNull();
    expect(item('profile-new')).not.toBeNull();
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

describe('SurfaceTabs — browser protection', () => {
  const browserTab = (id = 'surface-b1'): Surface => ({ id, ptyId: '', title: 'Docs', shell: '', cwd: '', surfaceType: 'browser' } as Surface);

  it('is hidden off the chrome backend and never reads a policy', async () => {
    useStore.getState().setBrowserBackend('builtin');
    mount([browserTab()]);
    await openMenu();
    expect(item('browser-policy')).toBeNull();
    expect(policyApi.get).not.toHaveBeenCalled();
  });

  it('is hidden on a preload without the policy calls', async () => {
    (window as unknown as { electronAPI: unknown }).electronAPI = { browser: { chromeProfiles: api } };
    mount();
    await openMenu();
    expect(item('browser-profile')).not.toBeNull();
    expect(item('browser-policy')).toBeNull();
  });

  it('is disabled with a reason until the pane has its own profile', async () => {
    mount();
    await openMenu();
    const row = item('browser-policy');
    expect(row?.getAttribute('aria-disabled')).toBe('true');
    expect(row?.textContent).toContain('Bind a Chrome profile to this pane first');
    await clickItem('browser-policy');
    expect(document.querySelector('[data-testid="browser-policy-dialog"]')).toBeNull();
  });

  it('opens the editor when the pane has its own profile', async () => {
    mountWithBinding('work');
    await openMenu();
    expect(item('browser-policy')?.getAttribute('aria-disabled')).toBeNull();
    await clickItem('browser-policy');
    expect(document.querySelector('[data-testid="browser-policy-dialog"]')).not.toBeNull();
  });

  it('draws one muted lock for the pane, never on an in-app browser tab, and says the tab is not covered', async () => {
    const ws = activeWs();
    policyResult = {
      ok: true, state: 'ok', epoch: 3, currentProfile: 'work',
      policy: { workspaceId: ws.id, paneId: ws.rootPane.id, profileId: 'work', protected: true, hosts: { mode: 'allowlist', allow: ['a.com', 'b.com'], block: [] } },
    };
    mount([browserTab()]);
    await flush();
    const lock = container.querySelector('[data-protected-pane]');
    expect(lock?.getAttribute('aria-label')).toBe("This pane's Chrome is protected · Protected · 2 allowed");
    expect(container.querySelector('[role="tab"] [data-protected-pane], [data-protected-browser-tab]')).toBeNull();
    const tab = [...container.querySelectorAll<HTMLElement>('[title]')].find((el) => el.title.includes('not covered'));
    expect(tab).toBeDefined();
    expect(policyApi.get).toHaveBeenCalledWith(ws.id, ws.rootPane.id);
  });

  it('shows the protection on the menu row', async () => {
    const ws = activeWs();
    listResult.paneBindings = { [ws.rootPane.id]: { workspaceId: ws.id, profile: 'work' } };
    policyResult = {
      ok: true, state: 'ok', epoch: 3, currentProfile: 'work',
      policy: { workspaceId: ws.id, paneId: ws.rootPane.id, profileId: 'work', protected: true, hosts: { mode: 'off', allow: [], block: [] } },
    };
    mount();
    await openMenu();
    expect(item('browser-policy')?.querySelector('[data-pane-menu-detail]')?.textContent).toBe('Protected · any site');
  });

  it('a pane refused by an unreadable policy file shows the lock and stays editable without a profile', async () => {
    policyResult = { ok: true, state: 'corrupt', epoch: 0, policy: null, currentProfile: 'default' };
    mount();
    await openMenu();
    expect(container.querySelector('[data-protected-pane]')?.getAttribute('aria-label')).toContain('blocked until you confirm');
    expect(item('browser-policy')?.getAttribute('aria-disabled')).toBeNull();
  });

  it("main's decision wins: legacy draws nothing even with an unreadable file", async () => {
    policyResult = { ok: true, state: 'corrupt', epoch: 0, policy: null, currentProfile: 'default', decision: 'legacy' };
    mount();
    await flush();
    expect(container.querySelector('[data-protected-pane]')).toBeNull();
  });

  it('no lock on an unprotected pane, and in-app tabs keep their plain tooltip', async () => {
    mount([browserTab()]);
    await flush();
    expect(policyApi.get).toHaveBeenCalled();
    expect(container.querySelector('[data-protected-pane]')).toBeNull();
    expect([...container.querySelectorAll<HTMLElement>('[title]')].some((el) => el.title.includes('not covered'))).toBe(false);
  });
});
