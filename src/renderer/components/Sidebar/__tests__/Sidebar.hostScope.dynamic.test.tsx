// @vitest-environment jsdom
// PC rail: with a paired computer selected, the Workspaces page lists that
// computer's workspaces with this computer's own row (WorkspaceItem and its
// pane rows), in the host's order and numbering, and opening one builds its
// shadow workspace. With This computer selected, nothing changes.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import Sidebar from '../Sidebar';
import { nextRemoteWorkspaceName } from '../useRemoteWorkspaceCreate';
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
  { id: 'rw-a', name: '', order: 0, panes: [{ sessionId: 's-a', agentName: 'Claude Code', agentStatus: 'awaiting_input', paneName: 'w1-1' }] },
  { id: 'rw-e', name: '', order: 2, panes: [], empty: true },
];

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  const stub = (): unknown => new Proxy(() => Promise.resolve([]), { get: (_t, key) => (key === 'then' ? undefined : key === 'onChanged' ? () => () => undefined : stub()) });
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

const hostRows = () => [...container.querySelectorAll<HTMLElement>('[data-host-workspaces] [data-sidebar-row]')];
const rowId = (el: Element) => el.getAttribute('data-sidebar-row');
const card = (el: Element) => el.closest('.sidebar-row') as HTMLElement;

describe('Sidebar scoped to a paired computer', () => {
  it("lists that computer's rows in its own order and numbering, named by id when the host sends no name", () => {
    act(() => root.render(<Sidebar />));
    expect(hostRows().map(rowId)).toEqual(['shadow:h1:rw-a', 'shadow:h1:rw-b', 'shadow:h1:rw-e']);
    expect(hostRows().map((r) => card(r).querySelector('[data-shortcut-number]')?.getAttribute('data-shortcut-number'))).toEqual(['1', '2', '3']);
    expect(card(hostRows()[0]).textContent).toContain('rw-a');
    expect(card(hostRows()[0]).querySelector('[data-row-needs-you]')).not.toBeNull();
    expect(container.querySelector('[data-sidebar-total]')?.textContent).toBe('3');
    // None of this computer's rows, and no new-workspace button for the host.
    expect(container.textContent).not.toContain('two');
    expect(container.querySelector('[aria-label="New workspace"]')).toBeNull();
  });

  it('a granted host gets a + that creates the workspace there and opens it once listed', async () => {
    const workspaceCreate = vi.fn(() => Promise.resolve({ ok: true, sessionId: 's-new' }));
    (window as unknown as { electronAPI: Record<string, unknown> }).electronAPI.remote = { workspaceCreate };
    act(() => useStore.setState({ pcRailHosts: [{ id: 'h1', label: 'office-mac', canCreateWorkspace: true }] }));
    act(() => root.render(<Sidebar />));
    const plus = container.querySelector<HTMLButtonElement>('[data-sidebar-add-remote-workspace]');
    expect(plus?.getAttribute('aria-label')).toBe('New workspace on office-mac');
    await act(async () => { plus!.click(); });
    expect(workspaceCreate).toHaveBeenCalledTimes(1);
    const [hostId, workspaceId, , name] = workspaceCreate.mock.calls[0] as unknown as [string, string, undefined, string];
    expect(hostId).toBe('h1');
    // Named like the local +: the host lists "beta" and two unnamed rows, so Workspace 1.
    expect(name).toBe('Workspace 1');
    // Nothing local is made while the host has not listed it yet.
    expect(useStore.getState().workspaces.some((w) => w.id === `shadow:h1:${workspaceId}`)).toBe(false);
    act(() => useStore.setState({ pcRailFeeds: { h1: { workspaces: [...rows, { id: workspaceId, name: '', order: 3, panes: [{ sessionId: 's-new' }] }], fetchedAt: Date.now(), failedTicks: 0 } } }));
    expect(useStore.getState().activeWorkspaceId).toBe(`shadow:h1:${workspaceId}`);

    // An offline host keeps the + but it cannot be used, as the list says Offline.
    act(() => useStore.setState({ pcRailHostStatus: { h1: 'unreachable' } }));
    expect(container.querySelector<HTMLButtonElement>('[data-sidebar-add-remote-workspace]')?.disabled).toBe(true);
    act(() => useStore.setState({ pcRailHostStatus: { h1: 'reachable' } }));

    // Without the grant there is no + at all.
    act(() => useStore.setState({ pcRailHosts: [{ id: 'h1', label: 'office-mac' }] }));
    expect(container.querySelector('[data-sidebar-add-remote-workspace]')).toBeNull();
  });

  // The + shows from the grant the host last reported; a host that no longer
  // grants it refuses the new workspace, and the toast says so in our words.
  it('a + the host refuses says this PC cannot start panes there, not the host detail', async () => {
    const detail = 'no live pane is running in that workspace — the daemon can only verify a workspace id it can see on a running session. Omit workspaceId to spawn outside a workspace.';
    const workspaceCreate = vi.fn(() => Promise.resolve({ ok: false, error: detail, reason: 'unknown-workspace-id' }));
    (window as unknown as { electronAPI: Record<string, unknown> }).electronAPI.remote = { workspaceCreate };
    act(() => useStore.setState({ pcRailHosts: [{ id: 'h1', label: 'office-mac', canCreateWorkspace: true }], toasts: [] }));
    act(() => root.render(<Sidebar />));
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-sidebar-add-remote-workspace]')?.click(); });
    const messages = useStore.getState().toasts.map((x) => x.message);
    expect(messages).toContain('This PC can open what is already running on office-mac, but it cannot start new panes there.');
    expect(messages.join(' ')).not.toContain('workspaceId');
  });

  it("draws the host's pane rows (agent and pane name) under an expanded row", () => {
    act(() => root.render(<Sidebar />));
    const toggle = card(hostRows()[0]).querySelector<HTMLElement>('[aria-controls]');
    expect(toggle).not.toBeNull();
    act(() => toggle!.click());
    const roster = document.getElementById(toggle!.getAttribute('aria-controls')!);
    expect(roster?.textContent).toContain('Claude Code');
    expect(roster?.textContent).toContain('w1-1');
  });

  it('a pane row opens its workspace, and lands on the tab already showing that session elsewhere', () => {
    act(() => useStore.setState((s) => ({
      workspaces: s.workspaces.map((w) => (w.id !== 'one' ? w : { ...w, rootPane: { ...(w.rootPane as never as object), surfaces: [
        ...(w.rootPane as unknown as { surfaces: never[] }).surfaces,
        { id: 'mine', ptyId: '', title: '', shell: '', cwd: '', surfaceType: 'remote-terminal', remoteHostId: 'h1', remoteSessionId: 's-a' },
      ] } as never })),
    })));
    act(() => root.render(<Sidebar />));
    const toggle = card(hostRows()[0]).querySelector<HTMLElement>('[aria-controls]')!;
    act(() => toggle.click());
    const roster = document.getElementById(toggle.getAttribute('aria-controls')!)!;
    act(() => roster.querySelector<HTMLButtonElement>('button')!.click());
    const st = useStore.getState();
    expect(st.workspaces.some((w) => w.id === 'shadow:h1:rw-a')).toBe(true);
    // s-a is a tab of 'one' already: the jump goes there, not to the placeholder.
    expect(st.activeWorkspaceId).toBe('one');
    expect((st.workspaces.find((w) => w.id === 'one')!.rootPane as { activeSurfaceId: string }).activeSurfaceId).toBe('mine');
  });

  it('draws what the host sends (pinned, branch) and offers nothing local', () => {
    act(() => useStore.setState({
      pcRailFeeds: { h1: { workspaces: [
        { id: 'rw-p', name: 'api', order: 0, pinned: true, color: 'teal', gitBranch: 'feat/x', panes: [{ sessionId: 's1' }, { sessionId: 's2' }] },
      ], fetchedAt: Date.now(), failedTicks: 0 } },
    }));
    act(() => root.render(<Sidebar />));
    const row = card(hostRows()[0]);
    expect(row.querySelector('.wmux-row-title')?.textContent).toBe('api');
    expect(row.querySelector('[data-sidebar-pinned]')).not.toBeNull();
    expect(row.querySelector('[data-git-signal-line]')?.textContent).toContain('feat/x');
    expect(row.getAttribute('draggable')).toBe('false');
    act(() => { row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })); });
    expect(document.querySelector('[role="menu"]')).toBeNull();
    act(() => { row.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); });
    expect(row.querySelector('input')).toBeNull();
  });

  it('shows the local alias an attached workspace was given before the rail', () => {
    act(() => useStore.setState({
      remoteWorkspaces: [{ key: 'h1:rw-b', hostId: 'h1', hostLabel: 'office-mac', workspaceId: 'rw-b', name: 'beta', panes: [], label: 'Mine', color: 'teal' }],
    } as never));
    act(() => root.render(<Sidebar />));
    expect(card(hostRows()[1]).textContent).toContain('Mine');
    act(() => useStore.setState({ remoteWorkspaces: [] } as never));
  });

  it('opens a row as a shadow workspace and marks it selected; an empty row opens nothing', () => {
    act(() => root.render(<Sidebar />));
    act(() => card(hostRows()[1]).click());
    expect(useStore.getState().activeWorkspaceId).toBe('shadow:h1:rw-b');
    expect(hostRows()[1].getAttribute('aria-selected')).toBe('true');
    act(() => card(hostRows()[2]).click());
    expect(useStore.getState().activeWorkspaceId).toBe('shadow:h1:rw-b');
  });

  it('shows an offline computer muted with its last-seen line, and opens nothing', () => {
    act(() => useStore.setState({ pcRailHostStatus: { h1: 'unreachable' } }));
    act(() => root.render(<Sidebar />));
    expect(container.querySelector('[data-host-notice="offline"]')?.textContent).toMatch(/last seen/i);
    act(() => card(hostRows()[0]).click());
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

describe('nextRemoteWorkspaceName', () => {
  it('takes the lowest number the host does not use', () => {
    expect(nextRemoteWorkspaceName([])).toBe('Workspace 1');
    expect(nextRemoteWorkspaceName(['Workspace 1', 'api', 'Workspace 3'])).toBe('Workspace 2');
    expect(nextRemoteWorkspaceName(['Workspace 1', 'Workspace 2'])).toBe('Workspace 3');
  });
});
