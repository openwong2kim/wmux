// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { useStore } from '../../../stores';
import SidebarNavigation from '../SidebarNavigation';
import MiniSidebar from '../MiniSidebar';

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
