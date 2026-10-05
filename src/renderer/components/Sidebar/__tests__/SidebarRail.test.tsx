// @vitest-environment jsdom
// The icon rail (MiniSidebar `rail`): shortcuts in order, the More menu
// (Settings, shortcuts, updates, version) at the foot, the workspace list only while collapsed, arrow
// keys between buttons, and Fleet's needs-you count as a number badge.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { useStore } from '../../../stores';
import MiniSidebar from '../MiniSidebar';
import { seedFleetTriageStore } from '../../../utils/__tests__/fleetTriageFixture';
import { selectFleetSectionCounts } from '../../../stores/selectors/fleet';

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal('electronAPI', { web: { status: vi.fn(async () => ({ running: false })) } });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  useStore.setState({
    commandPaletteVisible: false, fleetViewVisible: false, settingsPanelVisible: false,
    schedulesViewOpen: false, appRoute: 'workspaces', schedulesAvailable: true, readOnly: false, sidebarVisible: true,
    moa: null,
  });
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

const rail = () => container.querySelector<HTMLDivElement>('[data-sidebar-rail]')!;
const navIds = () => [...container.querySelectorAll('[data-sidebar-nav]')].map((el) => el.getAttribute('data-sidebar-nav'));

describe('sidebar icon rail', () => {
  it('lists only pages — Workspaces, Fleet, Schedules, Remote and Git — each named', async () => {
    await act(async () => root.render(<MiniSidebar rail collapsed={false} />));
    // Search & commands is a palette (the titlebar pill), not a page.
    expect(navIds()).toEqual(['home', 'fleet', 'schedules', 'remote', 'git']);
    // Home is the current page until another is chosen.
    expect(container.querySelector('[data-sidebar-nav="home"]')?.getAttribute('aria-current')).toBe('page');
    for (const b of rail().querySelectorAll('button')) {
      expect(b.getAttribute('aria-label')?.length, b.outerHTML).toBeGreaterThan(0);
    }
  });

  it('Git opens its page and carries a red dot only while a PR fails its checks or conflicts', async () => {
    await act(async () => root.render(<MiniSidebar rail collapsed={false} />));
    const git = () => container.querySelector<HTMLButtonElement>('[data-sidebar-nav="git"]')!;
    expect(git().querySelector('[data-git-nav-signal]')).toBeNull();
    act(() => git().click());
    expect(useStore.getState().appRoute).toBe('git');
    expect(git().getAttribute('aria-current')).toBe('page');

    const ws = (id: string, pr: object) => ({ id, name: id, metadata: { pr }, rootPane: { id: 'p', type: 'leaf', surfaces: [], activeSurfaceId: '' }, activePaneId: 'p' });
    act(() => useStore.setState({ workspaces: [ws('a', { number: 1, state: 'open', checks: 'passing', url: 'u' })] as never }));
    expect(git().querySelector('[data-git-nav-signal]')).toBeNull();
    act(() => useStore.setState({ workspaces: [ws('a', { number: 1, state: 'open', checks: 'failing', url: 'u' })] as never }));
    expect(git().querySelector('[data-git-nav-signal]')).not.toBeNull();
    expect(git().getAttribute('aria-label')).toContain('checks failing or a merge conflict');
    act(() => useStore.setState({ workspaces: [ws('a', { number: 1, state: 'open', checks: 'passing', url: 'u', conflicting: true })] as never }));
    expect(git().querySelector('[data-git-nav-signal]')).not.toBeNull();
  });

  it('keeps only the More menu at its foot: no chevron, Settings inside it', async () => {
    await act(async () => root.render(<MiniSidebar rail collapsed={false} />));
    const more = container.querySelector<HTMLButtonElement>('[data-rail-more]')!;
    expect(more.getAttribute('aria-label')).toBe('More');
    expect(more.getAttribute('aria-haspopup')).toBe('menu');
    // The onboarding step that points at Settings now points at its menu.
    expect(more.getAttribute('data-onboarding-target')).toBe('settings-button');
    expect(container.querySelector('[data-sidebar-collapse]')).toBeNull();
    expect(container.querySelector('[aria-label^="Hide sidebar"], [aria-label^="Expand sidebar"]')).toBeNull();
  });

  it('opens the command palette, Settings, Keyboard shortcuts and Check for updates from the More menu, over the version line', async () => {
    (globalThis as { __APP_VERSION__?: string }).__APP_VERSION__ = '9.9.9';
    const checkForUpdates = vi.fn(async () => ({ status: 'not-available' }));
    vi.stubGlobal('electronAPI', { platform: 'darwin', updater: { checkForUpdates } });
    await act(async () => root.render(<MiniSidebar rail collapsed={false} />));
    const more = () => container.querySelector<HTMLButtonElement>('[data-rail-more]')!;
    const item = (key: string) => document.querySelector<HTMLButtonElement>(`[data-pane-menu-action="${key}"]`);
    act(() => more().click());
    expect(more().getAttribute('aria-expanded')).toBe('true');
    const menu = document.querySelector('[data-pane-actions-menu]')!;
    expect(menu.getAttribute('role')).toBe('menu');
    expect([...menu.querySelectorAll('[role="menuitem"]')].map((b) => b.textContent)).toEqual(['Command palette⌘K', 'Settings⌘,', 'Turn on Moa…', 'Keyboard shortcuts', 'Check for updates']);
    expect(menu.querySelector('[data-pane-menu-footer]')?.textContent).toBe('wmux v9.9.9');

    act(() => item('command-palette')!.click());
    expect(useStore.getState().commandPaletteVisible).toBe(true);
    act(() => useStore.setState({ commandPaletteVisible: false }));

    act(() => more().click());
    act(() => item('settings')!.click());
    expect(useStore.getState().appRoute).toBe('settings');
    expect(document.querySelector('[data-pane-actions-menu]')).toBeNull();

    act(() => useStore.setState({ appRoute: 'workspaces' }));
    act(() => more().click());
    act(() => item('shortcuts')!.click());
    expect(useStore.getState().appRoute).toBe('settings');
    expect(useStore.getState().settingsInitialTab).toBe('shortcuts');

    act(() => useStore.setState({ appRoute: 'workspaces', settingsInitialTab: null }));
    act(() => more().click());
    act(() => useStore.setState({ toasts: [] }));
    await act(async () => { item('check-updates')!.click(); await Promise.resolve(); await Promise.resolve(); });
    expect(checkForUpdates).toHaveBeenCalledTimes(1);
    expect(useStore.getState().settingsInitialTab).toBe('general');
    // No updater event follows a 'not-available' answer: the menu says it.
    expect(useStore.getState().toasts.map((x) => x.message)).toContain('Up to date');
    delete (globalThis as { __APP_VERSION__?: string }).__APP_VERSION__;
  });

  it('offers Turn on Moa… only while Moa is off, opening Settings › Moa', async () => {
    await act(async () => root.render(<MiniSidebar rail collapsed={false} />));
    const more = () => container.querySelector<HTMLButtonElement>('[data-rail-more]')!;
    const item = () => document.querySelector<HTMLButtonElement>('[data-pane-menu-action="turn-on-moa"]');
    act(() => more().click());
    expect(item()?.textContent).toBe('Turn on Moa…');
    act(() => item()!.click());
    expect(useStore.getState().appRoute).toBe('settings');
    expect(useStore.getState().settingsInitialTab).toBe('moa');
    act(() => useStore.setState({ appRoute: 'workspaces', settingsInitialTab: null, moa: { config: { enabled: true }, hq: { workspaceId: null, state: 'unset' } } as never }));
    act(() => more().click());
    expect(item()).toBeNull();
    act(() => useStore.setState({ moa: null }));
  });

  it('closes the More menu on Escape and hands focus back to its button', async () => {
    await act(async () => root.render(<MiniSidebar rail collapsed={false} />));
    const more = container.querySelector<HTMLButtonElement>('[data-rail-more]')!;
    more.focus();
    act(() => more.click());
    expect(document.activeElement?.getAttribute('data-pane-menu-action')).toBe('command-palette');
    act(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
    expect(document.querySelector('[data-pane-actions-menu]')).toBeNull();
    expect(document.activeElement).toBe(more);
  });

  it('shows no workspace list beside an open sidebar', async () => {
    await act(async () => root.render(<MiniSidebar rail collapsed={false} />));
    expect(container.querySelector('[data-mini-add-workspace]')).toBeNull();
  });

  it('adds the workspace list when collapsed', async () => {
    await act(async () => root.render(<MiniSidebar rail collapsed />));
    expect(container.querySelector('[data-mini-add-workspace]')).not.toBeNull();
  });

  it('moves focus between buttons with the arrow keys, wrapping at the ends', async () => {
    await act(async () => root.render(<MiniSidebar rail collapsed={false} />));
    const buttons = [...rail().querySelectorAll<HTMLButtonElement>('button')];
    buttons[0].focus();
    act(() => { buttons[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })); });
    expect(document.activeElement).toBe(buttons[1]);
    act(() => { buttons[1].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true })); });
    act(() => { buttons[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true })); });
    expect(document.activeElement).toBe(buttons[buttons.length - 1]);
  });

  it('carries the Fleet needs-you count as a number badge', async () => {
    seedFleetTriageStore(Date.now(), { schedulesAvailable: true, readOnly: false });
    const needs = selectFleetSectionCounts(useStore.getState()).needsYou;
    expect(needs).toBeGreaterThan(0);
    await act(async () => root.render(<MiniSidebar rail collapsed={false} />));
    const badge = container.querySelector('[data-sidebar-nav="fleet"] .wmux-nav-badge');
    expect(badge?.textContent).toBe(String(needs));
  });

  it('swaps the sheet to each page and marks only that one', async () => {
    await act(async () => root.render(<MiniSidebar rail collapsed={false} />));
    const pressed = () => [...container.querySelectorAll('[data-sidebar-nav][aria-current="page"]')]
      .map((el) => el.getAttribute('data-sidebar-nav'));
    for (const page of ['fleet', 'schedules', 'remote'] as const) {
      act(() => container.querySelector<HTMLButtonElement>(`[data-sidebar-nav="${page}"]`)!.click());
      expect(useStore.getState().appRoute).toBe(page);
      expect(pressed()).toEqual([page]);
    }
    // A page clicked again stays (the rail navigates, it does not toggle).
    act(() => container.querySelector<HTMLButtonElement>('[data-sidebar-nav="remote"]')!.click());
    expect(useStore.getState().appRoute).toBe('remote');
    // Settings is a page too, opened from the titlebar; the rail marks nothing.
    act(() => useStore.getState().setAppRoute('settings'));
    expect(pressed()).toEqual([]);
    act(() => container.querySelector<HTMLButtonElement>('[data-sidebar-nav="home"]')!.click());
    expect(useStore.getState().appRoute).toBe('workspaces');
    expect(pressed()).toEqual(['home']);
  });

  it('a workspace picked on the collapsed rail brings Workspaces back', async () => {
    useStore.setState({ appRoute: 'fleet', fleetViewVisible: true });
    await act(async () => root.render(<MiniSidebar rail collapsed />));
    const avatar = rail().querySelector<HTMLButtonElement>('.overflow-y-auto button');
    expect(avatar).not.toBeNull();
    act(() => avatar!.click());
    expect(useStore.getState().appRoute).toBe('workspaces');
  });
});

describe('Moa and the rail', () => {
  const moa = (enabled: boolean, state: 'ok' | 'hq-missing' | 'unset' = 'ok') => ({
    config: { enabled, onboarded: true, level: 1 as const, maxTurnsPerHour: 20, bubbles: true, reduceMotion: false, defaultReason: null },
    hq: { workspaceId: state === 'unset' ? null : 'hq', state },
    archive: { unacked: 0, total: 0 },
  });
  const ws = (id: string) => ({ id, name: id, rootPane: { id: `${id}-p`, type: 'leaf' as const, surfaces: [], activeSurfaceId: '' }, activePaneId: `${id}-p` });
  const current = () => [...container.querySelectorAll('[data-sidebar-nav][aria-current="page"]')].map((el) => el.getAttribute('data-sidebar-nav'));

  it('has no Moa entry: the panel is its home', async () => {
    useStore.setState({ workspaces: [ws('a'), ws('hq')], activeWorkspaceId: 'a', activeRemoteKey: null, moa: moa(true) } as never);
    await act(async () => root.render(<MiniSidebar rail collapsed={false} />));
    expect(navIds()).toEqual(['home', 'fleet', 'schedules', 'remote', 'git']);
    expect(container.querySelector('[data-sidebar-nav="moa"]')).toBeNull();
  });

  it('Workspaces leads back from the HQ to the first listed workspace', async () => {
    useStore.setState({ workspaces: [ws('hq'), ws('a')], activeWorkspaceId: 'hq', activeRemoteKey: null, appRoute: 'workspaces', moa: moa(true) } as never);
    await act(async () => root.render(<MiniSidebar rail collapsed={false} />));
    expect(current()).toEqual(['home']);
    act(() => container.querySelector<HTMLButtonElement>('[data-sidebar-nav="home"]')!.click());
    expect(useStore.getState().activeWorkspaceId).toBe('a');
    expect(current()).toEqual(['home']);
  });
});
