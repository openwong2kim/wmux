// @vitest-environment jsdom
// 2026-09-27 — fan-out tasks nest under the roster row of the pane that
// requested them; tasks with no live requesting pane collect in the owner's
// trailing "From closed pane" group. The requester line and the "N requested"
// badge (#1575) are gone: the tree already says who asked.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import Sidebar from '../Sidebar';
import { ORPHAN_GROUP_KEY } from '../sidebarTree';
import { useStore } from '../../../stores';
import type { AgentStatus, Pane, Surface, Workspace } from '../../../../shared/types';
import type { FanoutOrigin } from '../../../../shared/fanoutOrigin';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NOW = 50_000_000;
const surface = (id: string, ptyId: string): Surface => ({
  id, ptyId, title: '', shell: 'zsh', cwd: '/r', surfaceType: 'terminal',
});
const leaf = (id: string, ordinal: number, s: Surface): Pane =>
  ({ id, type: 'leaf', ordinal, surfaces: [s], activeSurfaceId: s.id }) as Pane;
const p1 = leaf('p1', 1, surface('s1', 'pty-1'));
const p2 = leaf('p2', 2, surface('s2', 'pty-2'));
const twoPanes = { id: 'split', type: 'branch', direction: 'horizontal', sizes: [50, 50], children: [p1, p2] } as unknown as Pane;

const owner = (rootPane: Pane): Workspace => ({ id: 'w1', name: 'Workspace 1', wsOrdinal: 1, rootPane, activePaneId: 'p1' } as Workspace);
const other: Workspace = { id: 'bee', name: 'bee', wsOrdinal: 2, rootPane: leaf('bp', 1, surface('bs', 'pty-bee')), activePaneId: 'bp' } as Workspace;
const task = (id: string, name: string): Workspace =>
  ({ id, name: `wtask: ${name}`, wsOrdinal: 10, rootPane: leaf(`${id}-p`, 1, surface(`${id}-s`, `pty-${id}`)), activePaneId: `${id}-p` }) as Workspace;
const TASKS = [task('t1', 'alpha one'), task('t2', 'alpha two'), task('t3', 'beta')];

const byPane1 = (): FanoutOrigin => ({ kind: 'pane', paneId: 'p1', surfaceId: 's1', label: 'w1-1 · Claude Code' });
const byPane2 = (): FanoutOrigin => ({ kind: 'pane', paneId: 'p2', surfaceId: 's2', label: 'w1-2 · Claude Code' });

function seed(opts: {
  rootPane?: Pane;
  origins?: Record<string, FanoutOrigin | undefined>;
  status?: Record<string, AgentStatus>;
  active?: string;
} = {}) {
  const status: Record<string, AgentStatus> = { 1: 'idle', 2: 'idle', bee: 'idle', t1: 'idle', t2: 'idle', t3: 'idle', ...opts.status };
  const ptys = Object.keys(status).map((k) => `pty-${k}`);
  const st = (pty: string) => status[pty.slice(4)];
  act(() => useStore.setState({
    workspaces: [owner(opts.rootPane ?? twoPanes), other, ...TASKS],
    activeWorkspaceId: opts.active ?? 'w1',
    sidebarSortMode: 'attention',
    sidebarAttentionFirst: true,
    sidebarPinnedIds: [],
    sidebarNewAt: {},
    sidebarTaskGroupExpanded: {},
    surfaceAgent: Object.fromEntries(ptys.map((p) => [p, { name: 'Claude Code', status: st(p) }])),
    surfaceAgentStatus: Object.fromEntries(ptys.filter((p) => !['running', 'idle'].includes(st(p))).map((p) => [p, st(p)])),
    surfaceActivityAt: Object.fromEntries(ptys.filter((p) => st(p) !== 'idle').map((p) => [p, NOW])),
    surfaceTurnOpenAt: Object.fromEntries(ptys.filter((p) => st(p) === 'running').map((p) => [p, NOW])),
    agentClockMs: NOW,
    missionByPaneGroup: {},
    fanoutLineage: { t1: 'w1', t2: 'w1', t3: 'w1' },
    fanoutSpawnOwner: {},
    fanoutProvenance: {},
    fanoutRefreshSettled: true,
    fanoutOrigin: opts.origins ?? { t1: byPane1(), t2: byPane1(), t3: byPane2() },
  } as never));
}

const group = (key: string) => document.querySelector(`[data-task-group="${key}"]`) as HTMLElement | null;
const namesIn = (el: Element | null) =>
  el ? [...el.querySelectorAll('[data-task-group-list] .sidebar-row')].map((r) => r.textContent?.match(/alpha one|alpha two|beta/)?.[0]) : [];
/** Top-level rows only (nested task rows live inside a task list). */
const topRows = () => [...document.querySelectorAll('.sidebar-row')]
  .filter((r) => !r.closest('[data-pane-tasks]'))
  .map((r) => r.textContent?.match(/^(Workspace 1|bee)/)?.[0]);

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.useFakeTimers({ now: NOW });
  const stub = (): unknown => new Proxy(() => Promise.resolve([]), { get: (_t, key) => (key === 'then' ? undefined : stub()) });
  (window as unknown as { electronAPI: unknown }).electronAPI = new Proxy({ platform: 'win32' } as Record<string, unknown>, {
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

describe('fan-out tasks under the requesting pane', () => {
  it('splits the tree by requesting pane, inside the owner row, with no "by" line or "requested" badge', () => {
    seed();
    act(() => root.render(<Sidebar />));
    expect(namesIn(group('pane:w1:s1'))).toEqual(['alpha one', 'alpha two']);
    expect(namesIn(group('pane:w1:s2'))).toEqual(['beta']);
    // Nested inside the owner's roster, not a workspace-level group.
    expect(group('pane:w1:s1')?.closest('[data-workspace-agent-roster]')).not.toBeNull();
    expect(group('w1')).toBeNull();
    expect(group('closedPane:w1')).toBeNull();
    // The pane row carries the fold toggle and its task count.
    expect(group('pane:w1:s1')?.querySelector('[data-pane-task-toggle]')?.getAttribute('data-pane-task-toggle')).toBe('2');
    // #1575's requester line and badge are gone.
    expect(container.querySelector('[data-task-requester]')).toBeNull();
    expect(container.querySelector('[data-roster-requested]')).toBeNull();
    expect(container.textContent).not.toMatch(/requested|by w1-1|Started by you|Requester unknown/);
  });

  it('moves a closed pane\'s tasks to the owner\'s trailing "From closed pane" group', () => {
    seed();
    act(() => root.render(<Sidebar />));
    expect(namesIn(group('pane:w1:s2'))).toEqual(['beta']);
    // Pane 2 closes.
    act(() => useStore.setState({ workspaces: [owner(p1), other, ...TASKS] } as never));
    expect(group('pane:w1:s2')).toBeNull();
    const closed = group('closedPane:w1')!;
    expect(closed.textContent).toContain('From closed pane');
    // Open by default while the owner is active.
    expect(namesIn(closed)).toEqual(['beta']);
    expect(namesIn(group('pane:w1:s1'))).toEqual(['alpha one', 'alpha two']);
  });

  it('files GUI, orchestrator and legacy (no origin) tasks in the trailing group', () => {
    seed({ origins: { t1: { kind: 'gui' }, t2: { kind: 'orchestrator' }, t3: undefined } });
    act(() => root.render(<Sidebar />));
    expect(group('pane:w1:s1')).toBeNull();
    expect(namesIn(group('closedPane:w1'))).toEqual(['alpha one', 'alpha two', 'beta']);
  });

  it('keeps an owner-gone task in the workspace-level "From closed workspace" group', () => {
    seed();
    act(() => useStore.setState({ fanoutLineage: { t1: 'w1', t2: 'w1', t3: 'closed-ws' } } as never));
    act(() => root.render(<Sidebar />));
    expect(namesIn(group('pane:w1:s2'))).toEqual([]);
    expect(group('closedPane:w1')).toBeNull();
    const orphans = group(ORPHAN_GROUP_KEY)!;
    expect(orphans.textContent).toContain('From closed workspace');
    expect(namesIn(orphans)).toEqual(['beta']);
  });

  it('folds per pane, and the fold survives a re-sort', () => {
    seed({ active: 'bee' });
    act(() => root.render(<Sidebar />));
    // w1 is not active: open its roster to see the pane rows.
    const chip = [...document.querySelectorAll('button[aria-controls="roster-list-w1"]')][0] as HTMLButtonElement;
    act(() => { chip.click(); });
    // Not active, nothing needs you: both pane groups start folded.
    expect(namesIn(group('pane:w1:s1'))).toEqual([]);
    const toggle = (key: string) => group(key)!.querySelector('[data-pane-task-toggle]') as HTMLButtonElement;
    act(() => { toggle('pane:w1:s1').click(); });
    expect(namesIn(group('pane:w1:s1'))).toEqual(['alpha one', 'alpha two']);
    expect(namesIn(group('pane:w1:s2'))).toEqual([]);
    expect(useStore.getState().sidebarTaskGroupExpanded['pane:w1:s1']).toBe(true);
    // Re-sort: bee starts running and moves; the fold state stays per pane.
    const before = topRows();
    act(() => useStore.setState({
      surfaceAgent: { ...useStore.getState().surfaceAgent, 'pty-bee': { name: 'Claude Code', status: 'running' } },
      surfaceActivityAt: { 'pty-bee': NOW },
      surfaceTurnOpenAt: { 'pty-bee': NOW },
    } as never));
    act(() => { vi.advanceTimersByTime(10_000); });
    expect(topRows()).toEqual(['bee', 'Workspace 1']);
    expect(before).toEqual(['Workspace 1', 'bee']);
    expect(namesIn(group('pane:w1:s1'))).toEqual(['alpha one', 'alpha two']);
    expect(namesIn(group('pane:w1:s2'))).toEqual([]);
  });

  it('a task that needs you lifts its owner, re-opens the roster and marks its pane row', () => {
    // bee is running (ranks above an idle workspace) and active; w1's roster is folded.
    seed({ active: 'bee', status: { bee: 'running' } });
    act(() => root.render(<Sidebar />));
    expect(topRows()).toEqual(['bee', 'Workspace 1']);
    expect(group('pane:w1:s2')).toBeNull();
    // beta (requested by pane 2) now asks for you.
    act(() => useStore.setState({
      surfaceAgent: { ...useStore.getState().surfaceAgent, 'pty-t3': { name: 'Claude Code', status: 'awaiting_input' } },
      surfaceAgentStatus: { 'pty-t3': 'awaiting_input' },
    } as never));
    act(() => { vi.advanceTimersByTime(10_000); });
    expect(topRows()).toEqual(['Workspace 1', 'bee']);
    // The roster opened on its own and pane 2's group is open on the task.
    expect(namesIn(group('pane:w1:s2'))).toEqual(['beta']);
    const paneToggle = group('pane:w1:s2')!.querySelector('[data-pane-task-toggle]')!;
    expect(paneToggle.getAttribute('data-pane-task-needs-you')).toBe('1');
    expect(paneToggle.getAttribute('aria-label')).toContain('1 need you');
    // Folded, the pane row's count carries the red.
    act(() => { (paneToggle as HTMLButtonElement).click(); });
    expect(group('pane:w1:s2')!.querySelector('[data-pane-task-red]')?.textContent).toBe('1');
    // Pane 1's group did not pick it up.
    expect(group('pane:w1:s1')!.querySelector('[data-pane-task-toggle]')!.getAttribute('data-pane-task-needs-you')).toBeNull();
  });

  it('keeps the roster open when its owner moves to the background while a task needs you', () => {
    seed({ status: { t3: 'awaiting_input' } });
    act(() => root.render(<Sidebar />));
    expect(namesIn(group('pane:w1:s2'))).toEqual(['beta']);
    act(() => { useStore.getState().setActiveWorkspace('bee'); });
    act(() => { vi.advanceTimersByTime(10_000); });
    expect(group('pane:w1:s2')).not.toBeNull();
    expect(namesIn(group('pane:w1:s2'))).toEqual(['beta']);
  });

  it('a nested task row selects the task, never the owner row it sits in', () => {
    seed();
    act(() => root.render(<Sidebar />));
    const beta = [...group('pane:w1:s2')!.querySelectorAll('[data-task-group-list] .sidebar-row')][0] as HTMLElement;
    act(() => { beta.click(); });
    expect(useStore.getState().activeWorkspaceId).toBe('t3');
    // The owner is no longer active, but the task you are in stays in view.
    expect(namesIn(group('pane:w1:s2'))).toEqual(['beta']);
  });
});
