// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { useStore } from '../../../stores';
import SidebarNavigation from '../SidebarNavigation';
import MiniSidebar from '../MiniSidebar';
import { selectFleetBoard } from '../../../stores/selectors/fleet';
import { seedFleetTriageStore } from '../../../utils/__tests__/fleetTriageFixture';
import { setLocale } from '../../../i18n';

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal('electronAPI', { web: { status: vi.fn(async () => ({ running: false })) } });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  useStore.setState({
    commandPaletteVisible: false, fleetViewVisible: false,
    notificationPanelVisible: false, settingsPanelVisible: false,
    channelDockVisible: false, channelsTabVisible: false,
    activeDeckTab: 'commander', channelUnread: {}, notifications: [],
  });
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
function button(id: string) {
  return container.querySelector<HTMLButtonElement>(`[data-sidebar-nav="${id}"]`)!;
}

describe('Sidebar global navigation', () => {
  it('uses existing overlay actions and keeps their mutual exclusion', () => {
    act(() => root.render(<SidebarNavigation />));
    act(() => button('fleet').click());
    expect(useStore.getState().fleetViewVisible).toBe(true);
    expect(button('fleet').getAttribute('aria-pressed')).toBe('true');
    act(() => button('search').click());
    expect(useStore.getState().fleetViewVisible).toBe(false);
    expect(useStore.getState().commandPaletteVisible).toBe(true);
  });

  it('shows Remote and Fleet as the default destinations, alongside search', async () => {
    await act(async () => root.render(<SidebarNavigation />));
    expect([...container.querySelectorAll('[data-sidebar-nav]')].map((el) => el.getAttribute('data-sidebar-nav')))
      .toEqual(['search', 'remote', 'fleet']);
    await act(async () => button('remote').click());
    expect(button('remote').getAttribute('aria-expanded')).toBe('true');
    expect(container.querySelector('[role="dialog"]')).not.toBeNull();
    expect(useStore.getState().fleetViewVisible).toBe(false);
  });

  it('keeps compact actions named and opens Fleet', () => {
    act(() => root.render(<SidebarNavigation compact />));
    for (const item of container.querySelectorAll('button')) {
      expect(item.getAttribute('aria-label')?.length).toBeGreaterThan(0);
      expect(item.title).toBe(item.getAttribute('aria-label'));
    }
    expect(button('fleet').getAttribute('aria-label')).toBe('Fleet');
    act(() => button('fleet').click());
    expect(useStore.getState().fleetViewVisible).toBe(true);
  });

  it('renders the collapsed sidebar with one Fleet destination and working settings', () => {
    act(() => root.render(<MiniSidebar />));
    expect(container.querySelectorAll('[data-sidebar-nav="fleet"]')).toHaveLength(1);
    expect(container.querySelectorAll('[data-sidebar-nav="notifications"]')).toHaveLength(0);
    const settings = container.querySelector<HTMLButtonElement>('button[aria-label="Settings"]')!;
    expect(settings).not.toBeNull();
    act(() => settings.click());
    expect(useStore.getState().settingsPanelVisible).toBe(true);
    expect(settings.getAttribute('aria-pressed')).toBe('true');
  });


  it('keeps settings reachable after Minimal and restores the Standard layout', () => {
    act(() => useStore.getState().applyChromePreset('minimal'));
    expect(useStore.getState().sidebarVisible).toBe(false);
    expect(useStore.getState().agentToolbarEnabled).toBe(false);
    expect(useStore.getState().paneActionsVisible).toBe(false);
    expect(useStore.getState().channelDockVisible).toBe(false);
    act(() => root.render(<MiniSidebar />));
    const settings = container.querySelector<HTMLButtonElement>('[data-onboarding-target="settings-button"]')!;
    act(() => settings.click());
    expect(useStore.getState().settingsPanelVisible).toBe(true);
    act(() => useStore.getState().applyChromePreset('standard'));
    expect(useStore.getState().sidebarVisible).toBe(true);
    expect(useStore.getState().paneActionsVisible).toBe(true);
    expect(useStore.getState().agentToolbarEnabled).toBe(true);
  });

});

describe('Fleet shortcut counts', () => {
  /** Visible text per part: the full needs-you string (the short number is the
   *  narrow-width fallback), the running string without its separator. */
  function counts() {
    const out: Record<string, string> = {};
    const needs = container.querySelector<HTMLElement>('[data-fleet-nav-count="needsYou"]');
    if (needs) out.needsYou = needs.querySelector('.wmux-nav-count-full')?.textContent ?? '';
    const running = container.querySelector<HTMLElement>('[data-fleet-nav-count="running"]');
    if (running) out.running = (running.textContent ?? '').replace('·', '');
    return out;
  }
  function seed(extra: Parameters<typeof seedFleetTriageStore>[1] = {}) {
    act(() => seedFleetTriageStore(Date.now(), { locale: 'en', ...extra }));
  }
  function board() {
    const { groups } = selectFleetBoard(useStore.getState(), { now: Date.now(), sortMode: 'attention' });
    return { needsYou: groups.needsYou.length, running: groups.running.length };
  }

  it('shows the Fleet board\'s own Needs you and Running section sizes', () => {
    seed();
    act(() => root.render(<SidebarNavigation />));
    // Fixture: two agents asking, one remote error; one running.
    expect(board()).toEqual({ needsYou: 3, running: 1 });
    expect(counts()).toEqual({ needsYou: 'needs you 3', running: 'running 1' });
    expect(container.querySelector('.wmux-nav-count-short')?.textContent).toBe('3');
    expect(container.querySelector('.wmux-nav-count')?.getAttribute('aria-hidden')).toBe('true');
  });

  it('names the button with the same words it shows (label in name)', () => {
    seed();
    act(() => root.render(<SidebarNavigation />));
    const name = button('fleet').getAttribute('aria-label') ?? '';
    expect(name).toBe('Fleet, needs you 3, running 1');
    for (const part of Object.values(counts())) expect(name).toContain(part);
    try {
      act(() => { setLocale('ko'); useStore.setState({ locale: 'ko' }); });
      expect(button('fleet').getAttribute('aria-label')).toBe('Fleet, 확인 필요 3, 실행 중 1');
      expect(container.querySelector('.wmux-nav-count-full')?.textContent).toBe('확인 필요 3');
    } finally {
      act(() => { setLocale('en'); useStore.setState({ locale: 'en' }); });
    }
  });

  it('agrees with selectFleetBoard across states, and draws nothing at zero', () => {
    seed();
    act(() => root.render(<SidebarNavigation />));
    const steps: Partial<ReturnType<typeof useStore.getState>>[] = [
      { surfaceAgentStatus: {}, surfacePendingQuestion: {}, remoteWorkspaces: [] },
      { surfaceAgentStatus: { 'pty-5': 'error', 'pty-4': 'complete' } },
      { surfaceAgent: {}, surfaceTurnOpenAt: {} },
      { surfaceAgentStatus: {} },
      { surfaceAgentStatus: { 'pty-1': 'running', 'pty-5': 'running' }, surfaceAgent: { 'pty-1': { name: 'Claude Code', status: 'running' } } },
    ];
    for (const step of steps) {
      act(() => useStore.setState(step));
      const expected = board();
      const shown = counts();
      expect(shown.needsYou ?? '').toBe(expected.needsYou ? `needs you ${expected.needsYou}` : '');
      expect(shown.running ?? '').toBe(expected.running ? `running ${expected.running}` : '');
      if (expected.needsYou + expected.running === 0) {
        expect(container.querySelector('.wmux-nav-count')).toBeNull();
        expect(button('fleet').getAttribute('aria-label')).toBe('Fleet');
      }
    }
  });

  it('keeps only the needs-you dot on the compact rail, with the numbers in its name', () => {
    seed();
    act(() => root.render(<SidebarNavigation compact />));
    expect(container.querySelectorAll('[data-fleet-nav-count]')).toHaveLength(1);
    expect(container.querySelector('[data-fleet-nav-count="needsYou"]')?.textContent).toBe('');
    expect(button('fleet').getAttribute('aria-label')).toBe('Fleet, needs you 3, running 1');
    expect(button('fleet').title).toBe(button('fleet').getAttribute('aria-label'));

    act(() => useStore.setState({ surfaceAgentStatus: {}, surfacePendingQuestion: {}, remoteWorkspaces: [] }));
    expect(container.querySelectorAll('[data-fleet-nav-count]')).toHaveLength(0);
    expect(button('fleet').getAttribute('aria-label')).toBe('Fleet, running 1');
  });
});
