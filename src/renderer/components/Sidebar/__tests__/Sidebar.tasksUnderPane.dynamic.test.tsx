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
import { isOwnTaskRowPress } from '../WorkspaceAgentRoster';
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
    expect(namesIn(group('pane:w1:p1'))).toEqual(['alpha one', 'alpha two']);
    expect(namesIn(group('pane:w1:p2'))).toEqual(['beta']);
    // Nested inside the owner's roster, not a workspace-level group.
    expect(group('pane:w1:p1')?.closest('[data-workspace-agent-roster]')).not.toBeNull();
    expect(group('w1')).toBeNull();
    expect(group('closedPane:w1')).toBeNull();
    // The pane row carries the fold toggle and its task count.
    expect(group('pane:w1:p1')?.querySelector('[data-pane-task-toggle]')?.getAttribute('data-pane-task-toggle')).toBe('2');
    // #1575's requester line and badge are gone.
    expect(container.querySelector('[data-task-requester]')).toBeNull();
    expect(container.querySelector('[data-roster-requested]')).toBeNull();
    expect(container.textContent).not.toMatch(/requested|by w1-1|Started by you|Requester unknown/);
  });

  it('moves a closed pane\'s tasks to the owner\'s trailing "From closed pane" group', () => {
    seed();
    act(() => root.render(<Sidebar />));
    expect(namesIn(group('pane:w1:p2'))).toEqual(['beta']);
    // Pane 2 closes.
    act(() => useStore.setState({ workspaces: [owner(p1), other, ...TASKS] } as never));
    expect(group('pane:w1:p2')).toBeNull();
    const closed = group('closedPane:w1')!;
    expect(closed.textContent).toContain('From closed pane');
    // Open by default while the owner is active.
    expect(namesIn(closed)).toEqual(['beta']);
    expect(namesIn(group('pane:w1:p1'))).toEqual(['alpha one', 'alpha two']);
  });

  it('files GUI, orchestrator and legacy (no origin) tasks in the trailing group', () => {
    seed({ origins: { t1: { kind: 'gui' }, t2: { kind: 'orchestrator' }, t3: undefined } });
    act(() => root.render(<Sidebar />));
    expect(group('pane:w1:p1')).toBeNull();
    expect(namesIn(group('closedPane:w1'))).toEqual(['alpha one', 'alpha two', 'beta']);
  });

  it('keeps an owner-gone task in the workspace-level "From closed workspace" group', () => {
    seed();
    act(() => useStore.setState({ fanoutLineage: { t1: 'w1', t2: 'w1', t3: 'closed-ws' } } as never));
    act(() => root.render(<Sidebar />));
    expect(namesIn(group('pane:w1:p2'))).toEqual([]);
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
    expect(namesIn(group('pane:w1:p1'))).toEqual([]);
    const toggle = (key: string) => group(key)!.querySelector('[data-pane-task-toggle]') as HTMLButtonElement;
    act(() => { toggle('pane:w1:p1').click(); });
    expect(namesIn(group('pane:w1:p1'))).toEqual(['alpha one', 'alpha two']);
    expect(namesIn(group('pane:w1:p2'))).toEqual([]);
    expect(useStore.getState().sidebarTaskGroupExpanded['pane:w1:p1']).toBe(true);
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
    expect(namesIn(group('pane:w1:p1'))).toEqual(['alpha one', 'alpha two']);
    expect(namesIn(group('pane:w1:p2'))).toEqual([]);
  });

  it('a task that needs you lifts its owner, re-opens the roster and marks its pane row', () => {
    // bee is running (ranks above an idle workspace) and active; w1's roster is folded.
    seed({ active: 'bee', status: { bee: 'running' } });
    act(() => root.render(<Sidebar />));
    expect(topRows()).toEqual(['bee', 'Workspace 1']);
    expect(group('pane:w1:p2')).toBeNull();
    // beta (requested by pane 2) now asks for you.
    act(() => useStore.setState({
      surfaceAgent: { ...useStore.getState().surfaceAgent, 'pty-t3': { name: 'Claude Code', status: 'awaiting_input' } },
      surfaceAgentStatus: { 'pty-t3': 'awaiting_input' },
    } as never));
    act(() => { vi.advanceTimersByTime(10_000); });
    expect(topRows()).toEqual(['Workspace 1', 'bee']);
    // The roster opened on its own and pane 2's group is open on the task.
    expect(namesIn(group('pane:w1:p2'))).toEqual(['beta']);
    const paneToggle = group('pane:w1:p2')!.querySelector('[data-pane-task-toggle]')!;
    expect(paneToggle.getAttribute('data-pane-task-needs-you')).toBe('1');
    expect(paneToggle.getAttribute('aria-label')).toContain('1 need you');
    // Folded, the pane row's count carries the red.
    act(() => { (paneToggle as HTMLButtonElement).click(); });
    expect(group('pane:w1:p2')!.querySelector('[data-pane-task-red]')?.textContent).toBe('1');
    // Pane 1's group did not pick it up.
    expect(group('pane:w1:p1')!.querySelector('[data-pane-task-toggle]')!.getAttribute('data-pane-task-needs-you')).toBeNull();
  });

  it('keeps the roster open when its owner moves to the background while a task needs you', () => {
    seed({ status: { t3: 'awaiting_input' } });
    act(() => root.render(<Sidebar />));
    expect(namesIn(group('pane:w1:p2'))).toEqual(['beta']);
    act(() => { useStore.getState().setActiveWorkspace('bee'); });
    act(() => { vi.advanceTimersByTime(10_000); });
    expect(group('pane:w1:p2')).not.toBeNull();
    expect(namesIn(group('pane:w1:p2'))).toEqual(['beta']);
  });

  it('a nested task row selects the task, never the owner row it sits in', () => {
    seed();
    act(() => root.render(<Sidebar />));
    const beta = [...group('pane:w1:p2')!.querySelectorAll('[data-task-group-list] .sidebar-row')][0] as HTMLElement;
    act(() => { beta.click(); });
    expect(useStore.getState().activeWorkspaceId).toBe('t3');
    // The owner is no longer active, but the task you are in stays in view.
    expect(namesIn(group('pane:w1:p2'))).toEqual(['beta']);
  });
});

// Review round (#1581): each finding keeps a regression test here.
describe('fan-out tasks under the pane — review fixes', () => {
  const chip = () => document.querySelector('button[aria-controls="roster-list-w1"]') as HTMLButtonElement;

  it('a folded roster counts the tasks that need you in amber, with an accessible label, and re-opens for a second one', () => {
    seed({ active: 'bee', status: { t3: 'awaiting_input' } });
    act(() => root.render(<Sidebar />));
    // Opened on its own for beta; the user folds it anyway.
    expect(namesIn(group('pane:w1:p2'))).toEqual(['beta']);
    act(() => { chip().click(); });
    expect(group('pane:w1:p2')).toBeNull();
    const tasks = document.querySelector('[data-roster-chip-tasks]') as HTMLElement;
    expect(tasks.getAttribute('data-roster-chip-needs-you')).toBe('1');
    expect(tasks.querySelector('.text-\\[var\\(--accent-yellow\\)\\]')?.textContent).toBe('1');
    expect(chip().getAttribute('aria-label')).toContain('1 need you');
    // A second task starts needing you while folded: the roster opens again.
    act(() => useStore.setState({
      surfaceAgent: { ...useStore.getState().surfaceAgent, 'pty-t1': { name: 'Claude Code', status: 'awaiting_input' } },
      surfaceAgentStatus: { ...useStore.getState().surfaceAgentStatus, 'pty-t1': 'awaiting_input' },
    } as never));
    expect(namesIn(group('pane:w1:p1'))).toEqual(['alpha one', 'alpha two']);
  });

  it('renaming the owner keeps its nested tasks on screen', () => {
    seed();
    act(() => root.render(<Sidebar />));
    const owner = [...document.querySelectorAll('.sidebar-row')].find((r) => r.textContent?.startsWith('Workspace 1')) as HTMLElement;
    act(() => { owner.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); });
    expect(owner.querySelector('input')).not.toBeNull();
    expect(namesIn(group('pane:w1:p1'))).toEqual(['alpha one', 'alpha two']);
    expect(namesIn(group('pane:w1:p2'))).toEqual(['beta']);
  });

  it('a nested task row still drags itself; the owner row refuses a drag begun on its own roster', () => {
    seed();
    act(() => root.render(<Sidebar />));
    const taskRow = group('pane:w1:p2')!.querySelector('[data-task-group-list] .sidebar-row') as HTMLElement;
    const owner = [...document.querySelectorAll('.sidebar-row')].find((r) => r.textContent?.startsWith('Workspace 1')) as HTMLElement;
    const drag = (el: HTMLElement, pointerOn: Element) => {
      const original = document.elementFromPoint;
      document.elementFromPoint = () => pointerOn;
      const data: Record<string, string> = {};
      const ev = new Event('dragstart', { bubbles: true, cancelable: true });
      Object.defineProperty(ev, 'dataTransfer', { value: { setData: (k: string, v: string) => { data[k] = v; }, effectAllowed: '' } });
      act(() => { el.dispatchEvent(ev); });
      document.elementFromPoint = original;
      return { prevented: ev.defaultPrevented, data };
    };
    const onTask = drag(taskRow, taskRow.querySelector('span') ?? taskRow);
    expect(onTask.prevented).toBe(false);
    expect(onTask.data['text/plain']).toBeTruthy();
    const rosterRow = group('pane:w1:p1')!.querySelector('button') as HTMLElement;
    expect(drag(owner, rosterRow).prevented).toBe(true);
  });

  it('the roster lets only its own task rows keep their press default', () => {
    seed();
    act(() => root.render(<Sidebar />));
    const roster = document.getElementById('roster-list-w1')!;
    const list = group('pane:w1:p2')!.querySelector('[data-task-group-list]') as HTMLElement;
    const taskRow = list.querySelector('.sidebar-row') as HTMLElement;
    expect(isOwnTaskRowPress(taskRow, roster)).toBe(true);
    // The list's own padding is not a task row: the owner row must not drag from it.
    expect(isOwnTaskRowPress(list, roster)).toBe(false);
    // Seen from a roster that does not own the list (a nested one): not exempt.
    const other = document.createElement('div');
    expect(isOwnTaskRowPress(taskRow, other)).toBe(false);
  });

  it('keeps a muted pane row when the pane is open but its agent ended', () => {
    seed();
    act(() => useStore.setState({
      surfaceAgent: Object.fromEntries(Object.entries(useStore.getState().surfaceAgent).filter(([k]) => k !== 'pty-2')),
    } as never));
    act(() => root.render(<Sidebar />));
    expect(group('closedPane:w1')).toBeNull();
    const bare = document.querySelector('[data-roster-bare-pane="p2"]');
    expect(bare).not.toBeNull();
    expect(namesIn(group('pane:w1:p2'))).toEqual(['beta']);
  });

  it('a roster holding only agent-less panes with tasks says no false agent or stash count', () => {
    seed({ active: 'bee' });
    act(() => useStore.setState({
      surfaceAgent: Object.fromEntries(Object.entries(useStore.getState().surfaceAgent).filter(([k]) => k !== 'pty-1' && k !== 'pty-2')),
    } as never));
    act(() => root.render(<Sidebar />));
    const label = chip().getAttribute('aria-label') ?? '';
    expect(label).not.toMatch(/Stashed 0|Agents 0/);
    expect(label).toContain('3 tasks');
  });

  it('nested task rows use their own hover group, so hovering the owner reveals none of their chrome', () => {
    seed();
    act(() => root.render(<Sidebar />));
    const owner = [...document.querySelectorAll('.sidebar-row')].find((r) => r.textContent?.startsWith('Workspace 1')) as HTMLElement;
    const taskRow = group('pane:w1:p2')!.querySelector('[data-task-group-list] .sidebar-row') as HTMLElement;
    expect(owner.classList.contains('group')).toBe(true);
    expect(taskRow.classList.contains('group')).toBe(false);
    expect(taskRow.classList.contains('group/task')).toBe(true);
    // No element inside a task row listens to the owner's plain group hover.
    expect(taskRow.outerHTML).not.toMatch(/(^|\s|")group-hover:/);
    expect(taskRow.outerHTML).not.toMatch(/(^|\s|")group-focus-within:/);
  });

  it('the pane menu names its pane, and cancelling its close confirm does not switch workspace', () => {
    seed({ active: 'bee', status: { t1: 'complete', t2: 'complete' } });
    act(() => root.render(<Sidebar />));
    act(() => { chip().click(); });
    const menu = group('pane:w1:p1')!.querySelector('[data-task-group-menu]') as HTMLButtonElement;
    expect(menu.getAttribute('aria-label')).toMatch(/^Task group actions for .*w1-1/);
    act(() => { menu.click(); });
    const closeFinished = document.querySelector('[data-close-finished]') as HTMLButtonElement;
    act(() => { closeFinished.click(); });
    const confirm = document.querySelector('[data-workspace-close-confirm]') as HTMLElement;
    expect(confirm).not.toBeNull();
    const cancel = [...confirm.querySelectorAll('button')].find((b) => b.textContent === 'Cancel') as HTMLButtonElement;
    act(() => { cancel.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); cancel.click(); });
    expect(useStore.getState().activeWorkspaceId).toBe('bee');
  });

  it('drops a closed pane\'s fold state and all of a removed owner\'s', () => {
    seed();
    act(() => useStore.setState({ sidebarTaskGroupExpanded: { 'pane:w1:p1': true, 'pane:w1:p2': false, 'closedPane:w1': true, 'pane:bee:bp': true } } as never));
    act(() => { useStore.getState().closePane('p2', 'w1'); });
    expect(useStore.getState().sidebarTaskGroupExpanded).toEqual({ 'pane:w1:p1': true, 'closedPane:w1': true, 'pane:bee:bp': true });
    act(() => { useStore.getState().removeWorkspace('w1'); });
    expect(useStore.getState().sidebarTaskGroupExpanded).toEqual({ 'pane:bee:bp': true });
  });
});
