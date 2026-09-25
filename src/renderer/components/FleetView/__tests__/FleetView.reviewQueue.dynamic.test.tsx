// @vitest-environment jsdom
//
// Fleet "Ready to review": a finished, still-open fan-out task gets one row
// with its change summary; the row verbs reach the existing task paths (diff
// surface, task PR, task close); nothing is drawn when nothing waits; and the
// sidebar rollup's `N to review` link counts the same tasks and opens Fleet
// on this section.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import FleetView from '../FleetView';
import SidebarTaskGroup from '../../Sidebar/SidebarTaskGroup';
import { useStore } from '../../../stores';
import type { Workspace, Pane, Surface, AgentStatus } from '../../../../shared/types';
import type { WorkTask } from '../../../../shared/workTask';
import { resetReviewSummariesForTests } from '../reviewSummary';

const act = React.act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function surface(id: string, ptyId: string): Surface {
  return { id, ptyId, title: id, shell: 'zsh', cwd: `/repo/${id}`, surfaceType: 'terminal' };
}
function leaf(id: string, ptyId: string): Pane {
  return { id, type: 'leaf', surfaces: [surface(`s-${id}`, ptyId)], activeSurfaceId: `s-${id}` };
}
function workspace(id: string, name: string, pane: Pane): Workspace {
  return { id, name, rootPane: pane, activePaneId: pane.id };
}
function mission(id: string, extra: Partial<WorkTask> = {}): WorkTask {
  return {
    id,
    title: `Fix ${id}`,
    status: 'open',
    missionChannelId: `ch-${id}`,
    createdAt: 1,
    createdBy: { principalId: 'ws-o', verifiedWorkspaceId: 'ws-o' },
    owner: { principalId: 'ws-o', verifiedWorkspaceId: 'ws-o' },
    branch: `wmux/${id}`,
    worktreePath: `/wt/${id}`,
    ...extra,
  } as WorkTask;
}

let container: HTMLDivElement;
let root: Root;
const diffSummary = vi.fn();
const close = vi.fn();
const createPr = vi.fn();
const dispose = vi.fn();
const addDiffSurface = vi.fn();

function mount(element: React.ReactElement = React.createElement(FleetView)): void {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => { root.render(element); });
}

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    await Promise.resolve();
  });
}

function reviewRow(wsId: string): HTMLButtonElement | null {
  return container.querySelector<HTMLButtonElement>(`[data-fleet-review-row][data-workspace-id="${wsId}"]`);
}

function key(element: Element, name: string): void {
  act(() => { element.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true })); });
}

function setAgents(status: Record<string, AgentStatus>): void {
  const surfaceAgent: Record<string, { name: string; status: AgentStatus }> = {};
  const surfaceAgentStatus: Record<string, AgentStatus> = {};
  const surfaceTurnOpenAt: Record<string, number> = {};
  for (const [pty, st] of Object.entries(status)) {
    surfaceAgent[pty] = { name: 'Claude Code', status: st };
    if (st === 'running') surfaceTurnOpenAt[pty] = Date.now();
    else surfaceAgentStatus[pty] = st;
  }
  act(() => { useStore.setState({ surfaceAgent, surfaceAgentStatus, surfaceTurnOpenAt, agentClockMs: Date.now() }); });
}

beforeEach(() => {
  resetReviewSummariesForTests();
  diffSummary.mockReset().mockResolvedValue({ ok: true, stateKey: 'k1', files: 2, additions: 3, deletions: 1, untracked: 0, binary: 1 });
  close.mockReset().mockResolvedValue({ ok: true });
  createPr.mockReset().mockResolvedValue({ ok: true, prUrl: 'https://github.com/o/r/pull/9' });
  dispose.mockReset();
  addDiffSurface.mockReset();
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    pty: { write: vi.fn(), dispose },
    diff: { summary: diffSummary },
    workTask: { close, createPr },
  };
  act(() => {
    useStore.setState({
      ...useStore.getInitialState(),
      locale: 'en',
      fleetActiveTab: 'fleet',
      fleetViewVisible: true,
      workspaces: [
        workspace('ws-o', 'owner project', leaf('po', 'pty-o')),
        workspace('ws-t1', 'wtask: Fix t1', leaf('p1', 'pty-1')),
        workspace('ws-t2', 'wtask: Fix t2', leaf('p2', 'pty-2')),
      ],
      missionByPaneGroup: { 'ws-t1': mission('t1'), 'ws-t2': mission('t2') },
      surfaceTurnEndAt: { 'pty-1': Date.now() - 5 * 60_000 },
      addDiffSurface,
    });
  });
  setAgents({ 'pty-1': 'complete', 'pty-2': 'running' });
});

afterEach(() => {
  try { act(() => { root.unmount(); }); } catch { /* already unmounted */ }
  container.remove();
  document.body.innerHTML = '';
});

describe('FleetView — Ready to review', () => {
  it('lists the finished open task with owner, branch, change summary and elapsed time', async () => {
    mount();
    await settle();
    const sections = Array.from(container.querySelectorAll<HTMLElement>('[data-fleet-section]')).map((el) => el.dataset.fleetSection);
    // Between Needs you (the finished pane) and Running.
    expect(sections).toEqual(['needsYou', 'review', 'running', 'idle']);
    const row = reviewRow('ws-t1')!;
    expect(row).not.toBeNull();
    expect(reviewRow('ws-t2')).toBeNull();
    expect(row.textContent).toContain('Fix t1');
    expect(row.textContent).toContain('owner project');
    expect(row.querySelector('[data-fleet-review-branch]')?.textContent).toBe('wmux/t1');
    expect(diffSummary).toHaveBeenCalledWith('/wt/t1', undefined);
    expect(row.querySelector('[data-fleet-review-changes]')?.getAttribute('data-fleet-review-changes')).toBe('2:3:1');
    expect(row.textContent).toContain('2 files changed');
    expect(row.querySelector('[data-fleet-elapsed]')?.textContent).toBe('5m');
  });

  it('draws no section when nothing is ready (an agent still running)', async () => {
    setAgents({ 'pty-1': 'running', 'pty-2': 'running' });
    mount();
    await settle();
    expect(container.querySelector('[data-fleet-section="review"]')).toBeNull();
    expect(container.querySelector('[data-fleet-review-row]')).toBeNull();
  });

  it('drops a closed or detached task from the queue', async () => {
    act(() => { useStore.setState({ missionByPaneGroup: { 'ws-t1': mission('t1', { detachedAt: 2 }), 'ws-t2': mission('t2') } }); });
    mount();
    await settle();
    expect(container.querySelector('[data-fleet-section="review"]')).toBeNull();
  });

  it('the ⋮ menu carries the review verbs; Open diff opens the task diff surface and closes Fleet', async () => {
    mount();
    await settle();
    const trigger = reviewRow('ws-t1')!.parentElement!.querySelector<HTMLButtonElement>('[data-fleet-row-trigger]')!;
    act(() => { trigger.click(); });
    const items = Array.from(document.body.querySelectorAll<HTMLElement>('[data-pane-menu-action]'));
    expect(items.map((el) => el.dataset.paneMenuAction)).toEqual(['diff', 'pr', 'jump', 'close']);
    expect(items[1].textContent).toContain('Create PR');
    act(() => { items[0].click(); });
    expect(addDiffSurface).toHaveBeenCalledWith('p1', 't1', 'diff: Fix t1', 'ws-t1', 'ws-o');
    expect(useStore.getState().fleetViewVisible).toBe(false);
  });

  it('Backspace asks first (Cancel focused), then closes through the task close path', async () => {
    mount();
    await settle();
    const row = reviewRow('ws-t1')!;
    act(() => { row.focus(); });
    key(row, 'Backspace');
    const cancel = container.querySelector<HTMLButtonElement>('[data-fleet-review-cancel]')!;
    expect(document.activeElement).toBe(cancel);
    expect(close).not.toHaveBeenCalled();
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-fleet-review-confirm="close"]')!.click(); });
    await settle();
    expect(close).toHaveBeenCalledWith('t1', 'ws-o');
    expect(dispose).toHaveBeenCalledWith('pty-1');
    expect(useStore.getState().workspaces.map((w) => w.id)).not.toContain('ws-t1');
  });

  it('keeps a task whose worktree is dirty and says why', async () => {
    close.mockResolvedValue({ ok: false, reason: 'dirty' });
    mount();
    await settle();
    const row = reviewRow('ws-t1')!;
    act(() => { row.focus(); });
    key(row, 'Backspace');
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-fleet-review-confirm="close"]')!.click(); });
    await settle();
    expect(useStore.getState().workspaces.map((w) => w.id)).toContain('ws-t1');
    expect(useStore.getState().toasts.some((toast) => toast.level === 'warn' && /Uncommitted/.test(toast.message))).toBe(true);
  });

  it('p creates a PR after a confirm when the task has none, and opens it when it has one', async () => {
    mount();
    await settle();
    const row = reviewRow('ws-t1')!;
    act(() => { row.focus(); });
    key(row, 'p');
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-fleet-review-confirm="pr"]')!.click(); });
    await settle();
    expect(createPr).toHaveBeenCalledWith('t1', 'ws-o');

    const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    act(() => {
      useStore.setState({ missionByPaneGroup: { 'ws-t1': mission('t1', { prUrl: 'https://github.com/o/r/pull/9' }), 'ws-t2': mission('t2') } });
    });
    await settle();
    const again = reviewRow('ws-t1')!;
    expect(again.textContent).toContain('PR linked');
    act(() => { again.focus(); });
    key(again, 'p');
    expect(open).toHaveBeenCalledWith('https://github.com/o/r/pull/9', '_blank');
    open.mockRestore();
  });
});

describe('FleetView — Ready to review, review fixes', () => {
  it('reuses cached counts when the worktree state key is unchanged, and shows a failed read as unavailable', async () => {
    mount();
    await settle();
    act(() => { root.unmount(); });
    container.remove();
    diffSummary.mockResolvedValue({ ok: true, stateKey: 'k1', unchanged: true });
    mount();
    await settle();
    expect(diffSummary).toHaveBeenLastCalledWith('/wt/t1', 'k1');
    expect(reviewRow('ws-t1')!.querySelector('[data-fleet-review-changes]')?.getAttribute('data-fleet-review-changes')).toBe('2:3:1');

    resetReviewSummariesForTests();
    act(() => { root.unmount(); });
    container.remove();
    diffSummary.mockResolvedValue({ ok: false, error: 'git failed' });
    mount();
    await settle();
    const changes = reviewRow('ws-t1')!.querySelector('[data-fleet-review-changes]');
    expect(changes?.getAttribute('data-fleet-review-changes')).toBe('unavailable');
    expect(changes?.textContent).toBe('Changes unavailable');
  });

  it('refuses a second close while one runs, and shows it in progress', async () => {
    let finish: (v: unknown) => void = () => undefined;
    close.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    mount();
    await settle();
    const row = reviewRow('ws-t1')!;
    act(() => { row.focus(); });
    key(row, 'Backspace');
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-fleet-review-confirm="close"]')!.click(); });
    await settle();
    expect(container.querySelector('[data-fleet-review-busy="close"]')?.textContent).toBe('Closing…');
    const again = reviewRow('ws-t1')!;
    act(() => { again.focus(); });
    key(again, 'Backspace');
    expect(container.querySelector('[data-fleet-review-confirm]')).toBeNull();
    expect(close).toHaveBeenCalledTimes(1);
    await act(async () => { finish({ ok: false, reason: 'dirty' }); });
    await settle();
    expect(container.querySelector('[data-fleet-review-busy]')).toBeNull();
  });

  it('a finished action leaves another row\'s open confirm and its focus alone', async () => {
    setAgents({ 'pty-1': 'complete', 'pty-2': 'complete' });
    act(() => { useStore.setState({ surfaceTurnEndAt: { 'pty-1': Date.now() - 60_000, 'pty-2': Date.now() - 120_000 } }); });
    let finish: (v: unknown) => void = () => undefined;
    createPr.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    mount();
    await settle();
    const r1 = reviewRow('ws-t1')!;
    act(() => { r1.focus(); });
    key(r1, 'p');
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-fleet-review-confirm="pr"]')!.click(); });
    await settle();
    // Now open t2's close confirm while t1's PR is still running.
    const r2 = reviewRow('ws-t2')!;
    act(() => { r2.focus(); });
    key(r2, 'Backspace');
    await settle();
    const cancel = container.querySelector<HTMLButtonElement>('[data-fleet-review="ws-t2"] [data-fleet-review-cancel]')!;
    expect(document.activeElement).toBe(cancel);
    await act(async () => { finish({ ok: true, prUrl: 'https://github.com/o/r/pull/3' }); });
    await settle();
    expect(container.querySelector('[data-fleet-review="ws-t2"] [data-fleet-review-cancel]')).not.toBeNull();
    expect(document.activeElement).toBe(cancel);
  });

  it('verb keys do nothing while the row\'s confirm is open', async () => {
    mount();
    await settle();
    const row = reviewRow('ws-t1')!;
    act(() => { row.focus(); });
    key(row, 'Backspace');
    // Focus back on the row with the confirm still open: d must not open the diff.
    act(() => { row.focus(); });
    key(row, 'd');
    expect(addDiffSurface).not.toHaveBeenCalled();
    expect(container.querySelector('[data-fleet-review-confirm="close"]')).not.toBeNull();
  });

  it('Close chosen from the ⋮ menu leaves focus on Cancel', async () => {
    mount();
    await settle();
    const trigger = reviewRow('ws-t1')!.parentElement!.querySelector<HTMLButtonElement>('[data-fleet-row-trigger]')!;
    act(() => { trigger.focus(); trigger.click(); });
    const closeItem = document.body.querySelector<HTMLElement>('[data-pane-menu-action="close"]')!;
    act(() => { closeItem.click(); });
    await settle();
    expect(document.activeElement).toBe(container.querySelector('[data-fleet-review-cancel]'));
  });

  it('a sidebar review request waits for the queue to hydrate before it is consumed', async () => {
    setAgents({ 'pty-1': 'running', 'pty-2': 'running' });
    act(() => { useStore.setState({ fleetFocusReview: true }); });
    mount();
    await settle();
    expect(useStore.getState().fleetFocusReview).toBe(true);
    setAgents({ 'pty-1': 'complete', 'pty-2': 'running' });
    await settle();
    await settle();
    expect(useStore.getState().fleetFocusReview).toBe(false);
    expect(document.activeElement).toBe(reviewRow('ws-t1'));
  });

  it('Open diff lands in the zoomed pane, not a hidden first pane', async () => {
    const two: Pane = { id: 'b1', type: 'branch', direction: 'horizontal', children: [leaf('p1', 'pty-1'), leaf('p1b', 'pty-1b')] };
    act(() => {
      useStore.setState({
        workspaces: useStore.getState().workspaces.map((w) => (w.id === 'ws-t1' ? { ...w, rootPane: two, activePaneId: 'p1b' } : w)),
        zoomedPaneId: 'p1b',
      });
    });
    setAgents({ 'pty-1': 'complete', 'pty-1b': 'complete', 'pty-2': 'running' });
    mount();
    await settle();
    const row = reviewRow('ws-t1')!;
    act(() => { row.focus(); });
    key(row, 'd');
    expect(addDiffSurface).toHaveBeenCalledWith('p1b', 't1', 'diff: Fix t1', 'ws-t1', 'ws-o');
  });
});

describe('Sidebar rollup — N to review', () => {
  it('counts the tasks Fleet lists and opens Fleet on the review section', async () => {
    act(() => { useStore.setState({ fleetViewVisible: false }); });
    mount(React.createElement(SidebarTaskGroup, {
      groupKey: 'ws-o',
      taskIds: ['ws-t1', 'ws-t2'],
      ownerActive: true,
      ownerName: 'owner project',
      renderTask: (id: string) => React.createElement('span', null, id),
      onCloseWorkspace: () => undefined,
    }));
    const link = container.querySelector<HTMLButtonElement>('[data-task-to-review]')!;
    expect(link.dataset.taskToReview).toBe('1');
    expect(link.textContent).toBe('1 to review');
    act(() => { link.click(); });
    expect(useStore.getState().fleetViewVisible).toBe(true);
    expect(useStore.getState().fleetFocusReview).toBe(true);
  });

  it('draws nothing when no task is ready', () => {
    setAgents({ 'pty-1': 'running', 'pty-2': 'running' });
    mount(React.createElement(SidebarTaskGroup, {
      groupKey: 'ws-o',
      taskIds: ['ws-t1', 'ws-t2'],
      ownerActive: true,
      ownerName: 'owner project',
      renderTask: (id: string) => React.createElement('span', null, id),
      onCloseWorkspace: () => undefined,
    }));
    expect(container.querySelector('[data-task-to-review]')).toBeNull();
  });
});
