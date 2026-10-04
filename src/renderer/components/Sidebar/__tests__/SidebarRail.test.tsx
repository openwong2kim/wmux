// @vitest-environment jsdom
// The icon rail (MiniSidebar `rail`): shortcuts in order, Settings and the
// sidebar toggle at the foot, the workspace list only while collapsed, arrow
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

  it('keeps only the sidebar toggle at its foot (Settings lives in the titlebar)', async () => {
    await act(async () => root.render(<MiniSidebar rail collapsed={false} />));
    expect(container.querySelector('[data-onboarding-target="settings-button"]')).toBeNull();
    expect(container.querySelector('[data-sidebar-collapse]')).not.toBeNull();
  });

  it('shows no workspace list beside an open sidebar, and offers to collapse it', async () => {
    await act(async () => root.render(<MiniSidebar rail collapsed={false} />));
    expect(container.querySelector('[data-mini-add-workspace]')).toBeNull();
    const toggle = container.querySelector<HTMLButtonElement>('[data-sidebar-collapse]')!;
    expect(toggle).not.toBeNull();
    act(() => toggle.click());
    expect(useStore.getState().sidebarVisible).toBe(false);
  });

  it('adds the workspace list when collapsed', async () => {
    await act(async () => root.render(<MiniSidebar rail collapsed />));
    expect(container.querySelector('[data-mini-add-workspace]')).not.toBeNull();
    expect(container.querySelector('[data-sidebar-collapse]')).toBeNull();
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

describe('the Moa rail entry', () => {
  const moa = (enabled: boolean, state: 'ok' | 'hq-missing' | 'unset' = 'ok') => ({
    config: { enabled, onboarded: true, level: 1 as const, maxTurnsPerHour: 20, bubbles: true, reduceMotion: false, defaultReason: null },
    hq: { workspaceId: state === 'unset' ? null : 'hq', state },
    archive: { unacked: 0, total: 0 },
  });
  const ws = (id: string) => ({ id, name: id, rootPane: { id: `${id}-p`, type: 'leaf' as const, surfaces: [], activeSurfaceId: '' }, activePaneId: `${id}-p` });
  const entry = () => container.querySelector<HTMLButtonElement>('[data-sidebar-nav="moa"]');
  const current = () => [...container.querySelectorAll('[data-sidebar-nav][aria-current="page"]')].map((el) => el.getAttribute('data-sidebar-nav'));

  it('shows after Git, named, only while Moa is on and its workspace exists', async () => {
    useStore.setState({ workspaces: [ws('a'), ws('hq')], activeWorkspaceId: 'a', activeRemoteKey: null, moa: moa(false) } as never);
    await act(async () => root.render(<MiniSidebar rail collapsed={false} />));
    expect(entry()).toBeNull();
    act(() => useStore.setState({ moa: moa(true, 'hq-missing') } as never));
    expect(entry()).toBeNull();
    act(() => useStore.setState({ moa: moa(true, 'unset') } as never));
    expect(entry()).toBeNull();
    act(() => useStore.setState({ moa: moa(true) } as never));
    expect(navIds()).toEqual(['home', 'fleet', 'schedules', 'remote', 'git', 'moa']);
    expect(entry()!.getAttribute('aria-label')).toBe('Moa');
  });

  it('opens the HQ on Workspaces from any page and is the current place while it is active', async () => {
    useStore.setState({ workspaces: [ws('a'), ws('hq')], activeWorkspaceId: 'a', activeRemoteKey: null, appRoute: 'git', moa: moa(true) } as never);
    const openMoaHq = vi.spyOn(useStore.getState(), 'openMoaHq');
    await act(async () => root.render(<MiniSidebar rail collapsed={false} />));
    expect(current()).toEqual(['git']);
    act(() => entry()!.click());
    expect(openMoaHq).toHaveBeenCalledTimes(1);
    expect(useStore.getState().activeWorkspaceId).toBe('hq');
    expect(useStore.getState().appRoute).toBe('workspaces');
    // One current item: Moa, not Workspaces.
    expect(current()).toEqual(['moa']);
    act(() => useStore.getState().setActiveWorkspace('a'));
    expect(current()).toEqual(['home']);
    openMoaHq.mockRestore();
  });

  it('keeps arrow-key navigation reaching it', async () => {
    useStore.setState({ workspaces: [ws('a'), ws('hq')], activeWorkspaceId: 'a', activeRemoteKey: null, moa: moa(true) } as never);
    await act(async () => root.render(<MiniSidebar rail collapsed={false} />));
    const git = container.querySelector<HTMLButtonElement>('[data-sidebar-nav="git"]')!;
    git.focus();
    act(() => { git.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })); });
    expect(document.activeElement).toBe(entry());
  });
});
