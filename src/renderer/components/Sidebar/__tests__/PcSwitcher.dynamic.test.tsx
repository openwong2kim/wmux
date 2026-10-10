// @vitest-environment jsdom
// The PC switcher in the sidebar title: the plain title with no paired
// computer; "Workspaces ▾" / "Workspaces · <name> ▾" otherwise, a badge summing
// the unselected computers' needs-you, a dropdown that selects a computer and
// holds each host's settings, and one collapsed-rail item.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useStore } from '../../../stores';
import { PcSwitcherRailItem, PcSwitcherTitle } from '../PcSwitcher';
import { LOCAL_PC_ID, type PcRailWorkspaceRow } from '../../../../shared/pcRail';

let container: HTMLDivElement;
let root: Root;

function seed(activePcId = LOCAL_PC_ID): void {
  useStore.setState((s) => ({
    pcRail: { ...s.pcRail, activePcId, lastWorkspaceByPc: {}, mutedPcs: [] },
    pcRailHosts: [{ id: 'h1', label: 'office-mac', allowInput: false }],
    pcRailHostsLoaded: true,
    pcRailHostStatus: { h1: 'reachable' },
    pcRailFeeds: {
      h1: {
        workspaces: [{ id: 'w1', name: 'api', order: 0, panes: [{ sessionId: 's1', agentName: 'claude', agentStatus: 'awaiting_input' }] } as PcRailWorkspaceRow],
        fetchedAt: 1_000,
        failedTicks: 0,
      },
    },
    pcRailPending: {},
    pcRailCompleteSeenAt: {},
    pcRailHostSeen: {},
    sidebarPosition: 'left',
  }));
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  seed();
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  useStore.setState((s) => ({ pcRailHosts: [], pcRailFeeds: {}, pcRailHostStatus: {}, pcRail: { ...s.pcRail, activePcId: LOCAL_PC_ID } }));
});

const q = (sel: string) => document.querySelector<HTMLElement>(sel);
const menuKeys = () => [...document.querySelectorAll('[data-pane-menu-action]')].map((b) => b.getAttribute('data-pane-menu-action'));

describe('PcSwitcherTitle', () => {
  it('is the plain title with no paired computer', () => {
    useStore.setState({ pcRailHosts: [] });
    act(() => root.render(<PcSwitcherTitle title="Workspaces" />));
    expect(container.textContent).toBe('Workspaces');
    expect(q('[data-pc-switcher]')).toBeNull();
    expect(q('[data-pc-switcher-badge]')).toBeNull();
  });

  it("names no host for this computer and badges the host's needs-you", () => {
    act(() => root.render(<PcSwitcherTitle title="Workspaces" />));
    expect(q('[data-pc-switcher]')?.getAttribute('aria-haspopup')).toBe('menu');
    expect(q('[data-pc-switcher-name]')).toBeNull();
    expect(q('[data-pc-switcher-badge]')?.textContent).toBe('1');
  });

  it('names the selected host and hides its own badge', () => {
    seed('h1');
    act(() => root.render(<PcSwitcherTitle title="Workspaces" />));
    expect(q('[data-pc-switcher-name]')?.textContent).toBe('· office-mac');
    expect(q('[data-pc-switcher-badge]')).toBeNull();
  });

  it('selects a computer from the dropdown', () => {
    act(() => root.render(<PcSwitcherTitle title="Workspaces" />));
    act(() => q('[data-pc-switcher]')!.click());
    expect(menuKeys()).toEqual(['pc-local', 'pc-h1', 'pc-manage-h1']);
    expect(q('[data-pane-menu-action="pc-h1"] [data-pane-menu-detail]')?.textContent).toBe('Online · 1 need you');
    act(() => q('[data-pane-menu-action="pc-h1"]')!.click());
    expect(useStore.getState().pcRail.activePcId).toBe('h1');
    expect(q('[data-pane-actions-menu]')).toBeNull();
  });

  it("opens a host's settings and steps back with Escape", () => {
    act(() => root.render(<PcSwitcherTitle title="Workspaces" />));
    act(() => q('[data-pc-switcher]')!.click());
    act(() => q('[data-pane-menu-action="pc-manage-h1"]')!.click());
    expect(menuKeys()).toEqual(['mute', 'remote-page', 'pair-again']);
    expect(q('[data-pc-access]')?.textContent).toContain('View only');
    act(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
    expect(menuKeys()).toEqual(['pc-local', 'pc-h1', 'pc-manage-h1']);
  });
});

describe('PcSwitcherRailItem', () => {
  it('renders nothing with no paired computer', () => {
    useStore.setState({ pcRailHosts: [] });
    act(() => root.render(<PcSwitcherRailItem />));
    expect(container.innerHTML).toBe('');
  });

  it("shows the selected host's monogram and opens the same dropdown", () => {
    seed('h1');
    act(() => root.render(<PcSwitcherRailItem />));
    expect(q('[data-pc-switcher-rail]')?.textContent).toBe('OM');
    act(() => q('[data-pc-switcher-rail]')!.click());
    expect(menuKeys()).toEqual(['pc-local', 'pc-h1', 'pc-manage-h1']);
  });
});
