// @vitest-environment jsdom
// Glance board (2026-09-25): the mounted sidebar shows workspaces in the
// Attention order, lifts an owner by its task, and holds the order while the
// pointer is in the list.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import Sidebar from '../Sidebar';
import { useStore } from '../../../stores';
import type { AgentStatus, Pane, Workspace } from '../../../../shared/types';
import type { WorkTask } from '../../../../shared/workTask';

const NOW = 50_000_000;
function ws(id: string): Workspace {
  const rootPane: Pane = {
    id: `${id}-p`, type: 'leaf', activeSurfaceId: `${id}-s`,
    surfaces: [{ id: `${id}-s`, ptyId: `pty-${id}`, title: '', shell: 'zsh', cwd: '/r', surfaceType: 'terminal' }],
  };
  return { id, name: id, rootPane, activePaneId: `${id}-p` };
}
function seed(statuses: Record<string, AgentStatus>, extra: Record<string, unknown> = {}) {
  const ids = Object.keys(statuses);
  act(() => useStore.setState({
    workspaces: ids.map(ws),
    activeWorkspaceId: '',
    sidebarSortMode: 'attention',
    sidebarAttentionFirst: true,
    sidebarPinnedIds: [],
    sidebarNewAt: {},
    surfaceAgent: Object.fromEntries(ids.map((id) => [`pty-${id}`, { name: 'Claude Code', status: statuses[id] }])),
    surfaceAgentStatus: Object.fromEntries(ids.filter((id) => !['running', 'idle'].includes(statuses[id])).map((id) => [`pty-${id}`, statuses[id]])),
    surfaceActivityAt: Object.fromEntries(ids.filter((id) => statuses[id] !== 'idle').map((id) => [`pty-${id}`, NOW])),
    surfaceTurnOpenAt: Object.fromEntries(ids.filter((id) => statuses[id] === 'running').map((id) => [`pty-${id}`, NOW])),
    agentClockMs: NOW,
    missionByPaneGroup: {},
    fanoutLineage: {},
    fanoutSpawnOwner: {},
    ...extra,
  } as never));
}
const shown = () => [...document.querySelectorAll('.sidebar-row')].map((r) => r.textContent?.match(/^[a-z]+/)?.[0]);

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.useFakeTimers({ now: NOW });
  // Any preload call the mounted tree makes resolves to an empty result.
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
  vi.useRealTimers();
});

describe('Sidebar — Attention order (render)', () => {
  it('shows needs you, then finished, running and idle', () => {
    seed({ idle: 'idle', run: 'running', done: 'complete', ask: 'awaiting_input' });
    act(() => root.render(<Sidebar />));
    expect(shown()).toEqual(['ask', 'done', 'run', 'idle']);
  });

  it('lifts an idle owner whose nested task needs you', () => {
    const task = { id: 't1', status: 'open', owner: { verifiedWorkspaceId: 'owner', principalId: 'owner' } } as WorkTask;
    seed({ run: 'running', owner: 'idle', task: 'awaiting_input' }, { missionByPaneGroup: { task } });
    act(() => root.render(<Sidebar />));
    expect(shown().slice(0, 2)).toEqual(['owner', 'task']);
  });

  it('keeps the order while the pointer is in the list, then applies it on leave', () => {
    seed({ a: 'running', b: 'idle' });
    act(() => root.render(<Sidebar />));
    expect(shown()).toEqual(['a', 'b']);
    const list = container.querySelector('.wmux-sidebar .overflow-y-auto') as HTMLElement;
    act(() => { list.dispatchEvent(new MouseEvent('pointerover', { bubbles: true })); });
    act(() => { useStore.setState({ surfaceAgentStatus: { 'pty-b': 'awaiting_input' } } as never); });
    act(() => { vi.advanceTimersByTime(20_000); });
    expect(shown()).toEqual(['a', 'b']);
    act(() => { list.dispatchEvent(new MouseEvent('pointerout', { bubbles: true, relatedTarget: document.body })); });
    expect(shown()).toEqual(['b', 'a']);
  });

  // Review #2 — plain waiting (no question) is idle in the shared class: no
  // "Needs you" label, and it does not sort above a running workspace.
  it('treats plain waiting as idle: no Needs you label, below running', () => {
    seed({ wait: 'waiting', run: 'running' });
    act(() => root.render(<Sidebar />));
    expect(shown()).toEqual(['run', 'wait']);
    const waitRow = [...document.querySelectorAll('.sidebar-row')].find((r) => r.textContent?.startsWith('wait'));
    expect(waitRow?.textContent).not.toContain('Needs you');
  });

  // Review #9 — Ctrl+N hints only in Manual.
  it('draws no Ctrl+N hints outside Manual', () => {
    seed({ a: 'idle', b: 'idle' });
    act(() => root.render(<Sidebar />));
    expect(container.textContent).not.toContain('^1');
    act(() => useStore.setState({ sidebarSortMode: 'manual', sidebarAttentionFirst: false } as never));
    expect(container.textContent).toContain('^1');
  });
});
