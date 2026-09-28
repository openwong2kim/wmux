// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useStore } from '../../../stores';
import SidebarNavigation from '../SidebarNavigation';
import { automation, run } from '../../Schedules/__tests__/fixtures';

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal('electronAPI', { web: { status: vi.fn(async () => ({ running: false })) } });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  useStore.setState({
    commandPaletteVisible: false, fleetViewVisible: false, settingsPanelVisible: false,
    automations: [], automationRuns: [], schedulesAvailable: false, schedulesViewOpen: false,
  });
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
const row = () => container.querySelector<HTMLButtonElement>('[data-sidebar-nav="schedules"]');

describe('Sidebar Schedules row', () => {
  it('stays hidden until a daemon answers automation.list', async () => {
    await act(async () => root.render(<SidebarNavigation />));
    expect(row()).toBeNull();
  });

  it('shows the next run muted when nothing needs you, and opens the main-area view', async () => {
    const next = new Date();
    next.setHours(23, 59, 0, 0);
    useStore.setState({ schedulesAvailable: true, automations: [automation({ nextRunAt: next.getTime() })] });
    await act(async () => root.render(<SidebarNavigation />));
    expect(row()!.querySelector('.wmux-nav-count-needs')).toBeNull();
    expect(row()!.querySelector('.wmux-nav-count-running')!.textContent).toMatch(/59/);
    expect(row()!.getAttribute('aria-label')).toMatch(/^Schedules, next /);
    await act(async () => row()!.click());
    expect(useStore.getState().schedulesViewOpen).toBe(true);
    expect(useStore.getState().fleetViewVisible).toBe(false);
    expect(row()!.getAttribute('aria-pressed')).toBe('true');
  });

  it('puts the needs-you count first when a run awaits or failed', async () => {
    useStore.setState({
      schedulesAvailable: true,
      automations: [automation({ nextRunAt: Date.now() + 60_000 })],
      automationRuns: [run({ state: 'awaiting' })],
    });
    await act(async () => root.render(<SidebarNavigation />));
    expect(row()!.querySelector('.wmux-nav-count-needs')!.textContent).toContain('1');
    expect(row()!.querySelector('.wmux-nav-count-running')).toBeNull();
    expect(row()!.getAttribute('aria-label')).toBe('Schedules, needs you 1');
  });

  it('keeps a single dot in the compact rail', async () => {
    useStore.setState({ schedulesAvailable: true, automations: [automation()], automationRuns: [run({ state: 'awaiting' })] });
    await act(async () => root.render(<SidebarNavigation compact />));
    expect(row()!.querySelectorAll('.wmux-nav-count')).toHaveLength(1);
    expect(row()!.textContent).toBe('');
    expect(row()!.title).toBe('Schedules, needs you 1');
  });

  it('shows a failure as muted text, never the amber needs count', async () => {
    useStore.setState({ schedulesAvailable: true, automations: [automation()], automationRuns: [run({ state: 'failed' })] });
    await act(async () => root.render(<SidebarNavigation />));
    expect(row()!.querySelector('.wmux-nav-count-needs')).toBeNull();
    expect(row()!.querySelector('.wmux-nav-count-running')!.textContent).toBe('1 failed');
  });

  it('hides a next-run time that is already in the past', async () => {
    useStore.setState({ schedulesAvailable: true, automations: [automation({ nextRunAt: Date.now() - 60_000 })] });
    await act(async () => root.render(<SidebarNavigation />));
    expect(row()!.querySelector('.wmux-nav-count-running')).toBeNull();
    expect(row()!.getAttribute('aria-label')).toBe('Schedules');
  });
});
