// @vitest-environment jsdom
// The sidebar's filter popover: facet checks narrow the list (the header
// counts what is left), chips remove one check at a time, nothing left says
// so with a way out, and a hidden selection is called out.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import Sidebar from '../Sidebar';
import { useStore } from '../../../stores';
import { EMPTY_FILTER } from '../workspaceFilter';
import type { AgentStatus, Pane, Workspace } from '../../../../shared/types';

function ws(id: string): Workspace {
  const rootPane: Pane = {
    id: `${id}-p`, type: 'leaf', activeSurfaceId: `${id}-s`,
    surfaces: [{ id: `${id}-s`, ptyId: `pty-${id}`, title: '', shell: 'zsh', cwd: '/r', surfaceType: 'terminal' }],
  };
  return { id, name: id, rootPane, activePaneId: `${id}-p` };
}
/** Workspaces with an agent in the given status; 'shell' has none. */
function seed(statuses: Record<string, AgentStatus | 'shell'>, active: string) {
  const ids = Object.keys(statuses);
  const agents = ids.filter((id) => statuses[id] !== 'shell');
  act(() => useStore.setState({
    workspaces: ids.map(ws),
    activeWorkspaceId: active,
    activeRemoteKey: null,
    sidebarSortMode: 'manual',
    sidebarPinnedIds: [],
    sidebarNewAt: {},
    sidebarFilter: EMPTY_FILTER,
    surfaceAgent: Object.fromEntries(agents.map((id) => [`pty-${id}`, { name: 'Claude Code', status: statuses[id] as AgentStatus, slug: 'claude' }])),
    surfaceAgentStatus: Object.fromEntries(agents.filter((id) => !['running', 'idle'].includes(statuses[id])).map((id) => [`pty-${id}`, statuses[id] as AgentStatus])),
    surfaceTurnOpenAt: Object.fromEntries(agents.filter((id) => statuses[id] === 'running').map((id) => [`pty-${id}`, Date.now()])),
    surfaceActivityAt: Object.fromEntries(agents.filter((id) => statuses[id] === 'running').map((id) => [`pty-${id}`, Date.now()])),
    agentClockMs: Date.now(),
    missionByPaneGroup: {}, fanoutLineage: {}, fanoutSpawnOwner: {},
    remoteWorkspaces: [],
  } as never));
}
const rows = () => [...document.querySelectorAll('.sidebar-row')].map((r) => r.textContent?.match(/^[a-z]+/)?.[0]);
const q = <T extends Element>(sel: string) => document.querySelector<T>(sel);

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  const stub = (): unknown => new Proxy(() => Promise.resolve([]), { get: (_t, key) => (key === 'then' ? undefined : stub()) });
  (window as unknown as { electronAPI: unknown }).electronAPI = new Proxy({ platform: 'darwin' } as Record<string, unknown>, {
    get: (t, key: string) => (key in t ? t[key] : stub()),
  });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('Sidebar workspace filter', () => {
  it('narrows by facets, counts what is left, and removes a check from its chip', () => {
    seed({ ask: 'awaiting_input', run: 'running', idle: 'idle', sh: 'shell' }, 'ask');
    act(() => root.render(<Sidebar />));
    act(() => q<HTMLButtonElement>('[data-sidebar-search-toggle]')!.click());
    expect(q('[data-ws-filter]')).not.toBeNull();
    expect(document.activeElement).toBe(q('[data-ws-filter-search]'));
    act(() => q<HTMLButtonElement>('[data-filter-option="sidebar.filter.status.needsYou"]')!.click());
    act(() => q<HTMLButtonElement>('[data-filter-option="sidebar.filter.status.running"]')!.click());
    expect(rows()).toEqual(['ask', 'run']);
    expect(q('[data-sidebar-total-compact]')!.textContent).toBe('2/4');
    expect(q('[data-sidebar-total] .sr-only')!.textContent).toBe('2 of 4');
    expect(q('[data-sidebar-total]')!.getAttribute('title')).toBe('2 of 4');
    expect(q('[data-sidebar-search-toggle]')!.getAttribute('data-filter-active')).toBe('true');
    // Escape closes the popover; the chips stay.
    act(() => { q('[data-ws-filter-search]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
    expect(q('[data-ws-filter]')).toBeNull();
    const chips = () => [...document.querySelectorAll('[data-ws-filter-chip]')].map((c) => c.getAttribute('data-ws-filter-chip'));
    expect(chips()).toEqual(['sidebar.filter.status.needsYou', 'sidebar.filter.status.running']);
    act(() => q<HTMLButtonElement>('[data-ws-filter-chip="sidebar.filter.status.running"] button')!.click());
    expect(rows()).toEqual(['ask']);
    expect(chips()).toEqual(['sidebar.filter.status.needsYou']);
  });

  it('says when nothing matches and clears in one go', () => {
    seed({ ask: 'awaiting_input', run: 'running', sh: 'shell' }, 'ask');
    act(() => useStore.setState({ sidebarFilter: { ...EMPTY_FILTER, status: ['running'], kind: ['terminal'] } }));
    act(() => root.render(<Sidebar />));
    expect(rows()).toEqual([]);
    expect(q('[data-ws-filter-empty]')!.textContent).toContain('No workspaces match');
    act(() => q<HTMLButtonElement>('[data-ws-filter-empty] button')!.click());
    expect(rows()).toEqual(['ask', 'run', 'sh']);
    expect(q('[data-ws-filter-chips]')).toBeNull();
  });

  it('calls out a selected workspace the filter hides, without moving the selection', () => {
    seed({ ask: 'awaiting_input', run: 'running', sh: 'shell' }, 'sh');
    act(() => useStore.setState({ sidebarFilter: { ...EMPTY_FILTER, kind: ['agent'] } }));
    act(() => root.render(<Sidebar />));
    expect(rows()).toEqual(['ask', 'run']);
    expect(q('[data-ws-filter-hidden-active]')).not.toBeNull();
    expect(useStore.getState().activeWorkspaceId).toBe('sh');
  });
});
