// @vitest-environment jsdom
// PC rail, PR4: with a paired computer selected, the Workspaces page lists
// that computer's workspaces (in its own order) and opening one builds its
// shadow workspace. With This computer selected, nothing changes.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import Sidebar from '../Sidebar';
import { useStore } from '../../../stores';
import type { Workspace } from '../../../../shared/types';
import type { PcRailWorkspaceRow } from '../../../../shared/pcRail';

function local(id: string): Workspace {
  return {
    id, name: id, activePaneId: `${id}-p`,
    rootPane: { id: `${id}-p`, type: 'leaf', activeSurfaceId: `${id}-s`, surfaces: [{ id: `${id}-s`, ptyId: `pty-${id}`, title: '', shell: 'zsh', cwd: '/r' }] },
  };
}
const rows: PcRailWorkspaceRow[] = [
  { id: 'rw-b', name: 'beta', order: 1, panes: [{ sessionId: 's-b' }] },
  { id: 'rw-a', name: '', order: 0, panes: [{ sessionId: 's-a', agentName: 'Claude Code', agentStatus: 'awaiting_input' }] },
  { id: 'rw-e', name: '', order: 2, panes: [], empty: true },
];

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  const stub = (): unknown => new Proxy(() => Promise.resolve([]), { get: (_t, key) => (key === 'then' ? undefined : stub()) });
  (window as unknown as { electronAPI: unknown }).electronAPI = new Proxy({ platform: 'darwin' } as Record<string, unknown>, {
    get: (t, key: string) => (key in t ? t[key] : stub()),
  });
  act(() => useStore.setState((s) => ({
    workspaces: [local('one'), local('two')],
    activeWorkspaceId: 'one',
    pcRailHosts: [{ id: 'h1', label: 'office-mac' }],
    pcRailHostsLoaded: true,
    pcRailHostStatus: { h1: 'reachable' },
    pcRailFeeds: { h1: { workspaces: rows, fetchedAt: Date.now(), failedTicks: 0 } },
    pcRail: { ...s.pcRail, activePcId: 'h1' },
  })));
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  act(() => useStore.setState((s) => ({ pcRailHosts: [], pcRailFeeds: {}, pcRail: { ...s.pcRail, activePcId: 'local' } })));
});

const hostRows = () => [...container.querySelectorAll('[data-host-row]')];

describe('Sidebar scoped to a paired computer', () => {
  it("lists that computer's rows in its own order, named by id when the host sends no name", () => {
    act(() => root.render(<Sidebar />));
    expect(hostRows().map((r) => r.getAttribute('data-host-row'))).toEqual(['rw-a', 'rw-b', 'rw-e']);
    expect(hostRows()[0].textContent).toContain('rw-a');
    expect(hostRows()[0].textContent).toContain('Needs you');
    expect(container.querySelector('[data-sidebar-total]')?.textContent).toBe('3');
    // None of this computer's rows, and no new-workspace button for the host.
    expect(container.textContent).not.toContain('two');
    expect(container.querySelector('[aria-label="New workspace"]')).toBeNull();
    // A workspace with no terminal is listed, but cannot be opened.
    expect(hostRows()[2].getAttribute('aria-disabled')).toBe('true');
  });

  it('opens a row as a shadow workspace and marks it selected', () => {
    act(() => root.render(<Sidebar />));
    act(() => (hostRows()[1] as HTMLElement).click());
    expect(useStore.getState().activeWorkspaceId).toBe('shadow:h1:rw-b');
    expect(hostRows()[1].getAttribute('aria-selected')).toBe('true');
    act(() => (hostRows()[2] as HTMLElement).click());
    expect(useStore.getState().activeWorkspaceId).toBe('shadow:h1:rw-b');
  });

  it('shows an offline computer muted with its last-seen line, and opens nothing', () => {
    act(() => useStore.setState({ pcRailHostStatus: { h1: 'unreachable' } }));
    act(() => root.render(<Sidebar />));
    expect(container.querySelector('[data-host-notice="offline"]')?.textContent).toMatch(/last seen/i);
    act(() => (hostRows()[0] as HTMLElement).click());
    expect(useStore.getState().activeWorkspaceId).toBe('one');
  });

  it('says so when the computer has no open workspaces', () => {
    act(() => useStore.setState({ pcRailFeeds: { h1: { workspaces: [], fetchedAt: Date.now(), failedTicks: 0 } } }));
    act(() => root.render(<Sidebar />));
    expect(container.querySelector('[data-host-empty]')?.textContent).toContain('office-mac');
  });

  it('lists this computer exactly as before when This computer is selected', () => {
    act(() => useStore.setState((s) => ({ pcRail: { ...s.pcRail, activePcId: 'local' } })));
    act(() => root.render(<Sidebar />));
    expect(container.querySelector('[data-host-workspaces]')).toBeNull();
    expect(container.textContent).toContain('two');
  });
});
