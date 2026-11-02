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
      appRoute: 'fleet', fleetViewVisible: true,
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
  it('review-task Jump returns to Workspaces on that task', async () => {
    act(() => useStore.getState().setFleetViewVisible(true));
    mount();
    await settle();
    const row = reviewRow('ws-t1')!;
    act(() => row.focus());
    key(row, 'j');
    await settle();
    expect(useStore.getState().activeWorkspaceId).toBe('ws-t1');
    expect(useStore.getState().appRoute).toBe('workspaces');
    expect(useStore.getState().fleetViewVisible).toBe(false);
  });

  it('lists the finished open task with owner, branch, change summary and elapsed time', async () => {
    mount();
    await settle();
    const sections = Array.from(container.querySelectorAll<HTMLElement>('[data-fleet-section]')).map((el) => el.dataset.fleetSection);
    // After Needs you (empty here) and before the folded finished pane and
    // Running; To hand out's row ends the list even at zero.
    expect(sections).toEqual(['review', 'finished', 'running', 'idle', 'handOut']);
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

  it('names the requester: workspace › requesting pane, else who started it', async () => {
    act(() => { useStore.setState({ fanoutOrigin: { 'ws-t1': { kind: 'pane', paneId: 'po', surfaceId: 's-po', label: 'w0-0' } } }); });
    mount();
    await settle();
    const text = () => reviewRow('ws-t1')!.querySelector('[data-fleet-review-requester]')?.textContent;
    expect(text()).toBe('by w0-0 · owner project');
    act(() => { useStore.setState({ fanoutOrigin: { 'ws-t1': { kind: 'gui' } } }); });
    expect(text()).toBe('Started by you');
    expect(reviewRow('ws-t1')!.textContent).toContain('owner project');
    // Unknown says nothing rather than "Requester unknown".
    act(() => { useStore.setState({ fanoutOrigin: {}, fanoutProvenance: {} }); });
    expect(text()).toBeUndefined();
  });

  it('names the requester on a task row in every section, not only Ready to review', async () => {
    act(() => { useStore.setState({ fanoutOrigin: { 'ws-t2': { kind: 'pane', paneId: 'po', surfaceId: 's-po', label: 'w0-0' } } }); });
    mount();
    await settle();
    // ws-t2 is running: an ordinary Fleet card, not a review row.
    const card = container.querySelector('[data-fleet-card][data-workspace-id="ws-t2"]')!;
    expect(card.querySelector('[data-fleet-requester]')?.textContent).toBe('by w0-0 · owner project');
    // Its own line, not a segment of the meta line that would squeeze it.
    expect(card.querySelector('[data-fleet-requester]')?.closest('.wmux-fleet-context')).toBeNull();
    // A closed requester stamped in the old name-first order still leads with the coordinate.
    act(() => { useStore.setState({ fanoutOrigin: { 'ws-t2': { kind: 'pane', paneId: 'gone', surfaceId: 's-gone', label: 'Claude Code · w1-1' } } }); });
    expect(card.querySelector('[data-fleet-requester]')?.textContent).toBe('by w1-1 · Claude Code · closed · owner project');
    // A workspace that is not a fan-out task carries none.
    expect(container.querySelector('[data-fleet-card][data-workspace-id="ws-o"] [data-fleet-requester]')).toBeNull();
  });

  it('draws no section when nothing is ready (an agent still running)', async () => {
    setAgents({ 'pty-1': 'running', 'pty-2': 'running' });
    mount();
    await settle();
    expect(container.querySelector('[data-fleet-section="review"]')).toBeNull();
    expect(container.querySelector('[data-fleet-review-row]')).toBeNull();
  });

  it('drops a closed or detached task from the queue — its finished pane stays under Finished', async () => {
    act(() => { useStore.setState({ missionByPaneGroup: { 'ws-t1': mission('t1', { detachedAt: 2 }), 'ws-t2': mission('t2') }, fleetFinishedExpanded: true }); });
    mount();
    await settle();
    expect(container.querySelector('[data-fleet-review-row]')).toBeNull();
    expect(container.querySelector('[data-fleet-section="review"]')).toBeNull();
    expect(container.querySelector('[data-fleet-card][data-workspace-id="ws-t1"]')?.getAttribute('data-status')).toBe('complete');
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

  // #2388: a refused close offers Close and keep folder; an unpushed branch
  // does not (its next step is a push or a PR).
  const closeFromRow = async (): Promise<void> => {
    const row = reviewRow('ws-t1')!;
    act(() => { row.focus(); });
    key(row, 'Backspace');
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-fleet-review-confirm="close"]')!.click(); });
    await settle();
  };
  const keepFolderToast = () => useStore.getState().toasts.find((toast) => toast.action?.label === 'Close and keep folder');
  // A second tab in the task's pane: a plain shell, no agent in it.
  const addShellTab = (): void => {
    const p1: Pane = { id: 'p1', type: 'leaf', surfaces: [surface('s-p1', 'pty-1'), surface('s-p1-shell', 'pty-1-shell')], activeSurfaceId: 's-p1' };
    act(() => {
      useStore.setState({ workspaces: useStore.getState().workspaces.map((w) => (w.id === 'ws-t1' ? workspace('ws-t1', w.name, p1) : w)) });
    });
  };

  it('a refused close offers Close and keep folder, which closes the task keeping its folder', async () => {
    close.mockResolvedValueOnce({ ok: false, reason: 'error', error: 'could not verify all processes exited' });
    mount();
    await settle();
    expect(keepFolderToast()).toBeUndefined();
    await closeFromRow();
    const offered = keepFolderToast();
    expect(offered).toBeDefined();
    expect(useStore.getState().workspaces.map((w) => w.id)).toContain('ws-t1');
    close.mockResolvedValueOnce({ ok: true, taskId: 't1', archivePending: false, keptFolder: '/wt/t1' });
    await act(async () => { offered!.action!.onClick(); });
    await settle();
    expect(close).toHaveBeenLastCalledWith('t1', 'ws-o', { keepFolder: true });
    expect(useStore.getState().workspaces.map((w) => w.id)).not.toContain('ws-t1');
    expect(useStore.getState().toasts.some((toast) => toast.message === 'Task closed. Its folder was kept at /wt/t1.')).toBe(true);
  });

  // The task's own agent is the command its shell runs (OSC 133) until it
  // exits: that is the work the close ends, so it does not refuse the keep.
  it('Close and keep folder closes the task while its own finished agent is its shell\'s running command', async () => {
    act(() => { useStore.setState({ commandRunningByPtyId: { 'pty-1': true } } as never); });
    close.mockResolvedValueOnce({ ok: false, reason: 'error', error: 'could not verify all processes exited' });
    mount();
    await settle();
    await closeFromRow();
    const offered = keepFolderToast();
    expect(offered).toBeDefined();
    close.mockResolvedValueOnce({ ok: true, taskId: 't1', archivePending: false, keptFolder: '/wt/t1' });
    await act(async () => { offered!.action!.onClick(); });
    await settle();
    expect(close).toHaveBeenLastCalledWith('t1', 'ws-o', { keepFolder: true });
    expect(useStore.getState().workspaces.map((w) => w.id)).not.toContain('ws-t1');
    expect(useStore.getState().toasts.some((toast) => toast.message === 'Task closed. Its folder was kept at /wt/t1.')).toBe(true);
  });

  // The agent's process is known gone: the command its pane runs now is
  // something else, and the keep would end it.
  it('Close and keep folder closes nothing when the agent pane runs a command after its agent exited', async () => {
    close.mockResolvedValueOnce({ ok: false, reason: 'error', error: 'could not verify all processes exited' });
    mount();
    await settle();
    await closeFromRow();
    const offered = keepFolderToast();
    expect(offered).toBeDefined();
    act(() => { useStore.setState({ commandRunningByPtyId: { 'pty-1': true }, agentAliveByPtyId: { 'pty-1': false } } as never); });
    await act(async () => { offered!.action!.onClick(); });
    await settle();
    expect(close).toHaveBeenCalledTimes(1);
    expect(useStore.getState().workspaces.map((w) => w.id)).toContain('ws-t1');
  });

  // A command started in the task since the refusal: the action offered
  // then closes nothing, so it cannot end that work.
  it('a Close and keep folder offered earlier closes nothing once a command runs in the task', async () => {
    addShellTab();
    close.mockResolvedValueOnce({ ok: false, reason: 'error', error: 'could not verify all processes exited' });
    mount();
    await settle();
    await closeFromRow();
    const offered = keepFolderToast();
    expect(offered).toBeDefined();
    act(() => { useStore.setState({ commandRunningByPtyId: { 'pty-1': true, 'pty-1-shell': true } } as never); });
    await act(async () => { offered!.action!.onClick(); });
    await settle();
    expect(close).toHaveBeenCalledTimes(1);
    expect(useStore.getState().workspaces.map((w) => w.id)).toContain('ws-t1');
    expect(useStore.getState().toasts.some((toast) => toast.level === 'warn' && /Fix t1/.test(toast.message) && toast.action === undefined)).toBe(true);
  });

  it('a command started while Close and keep folder runs keeps the task\'s workspace open', async () => {
    addShellTab();
    close.mockResolvedValueOnce({ ok: false, reason: 'error', error: 'could not verify all processes exited' });
    mount();
    await settle();
    await closeFromRow();
    const offered = keepFolderToast();
    let answer!: (r: unknown) => void;
    close.mockImplementationOnce(() => new Promise((r) => { answer = r; }));
    await act(async () => { offered!.action!.onClick(); });
    act(() => { useStore.setState({ commandRunningByPtyId: { 'pty-1-shell': true } } as never); });
    await act(async () => { answer({ ok: true, taskId: 't1', archivePending: false, keptFolder: '/wt/t1' }); });
    await settle();
    expect(close).toHaveBeenLastCalledWith('t1', 'ws-o', { keepFolder: true });
    expect(useStore.getState().workspaces.map((w) => w.id)).toContain('ws-t1');
  });

  it('offers no Close and keep folder for an unpushed branch, nor after a close that worked', async () => {
    close.mockResolvedValueOnce({ ok: false, reason: 'unpushed', aheadCount: 2 });
    mount();
    await settle();
    await closeFromRow();
    expect(useStore.getState().toasts.some((toast) => /unpushed/.test(toast.message))).toBe(true);
    expect(keepFolderToast()).toBeUndefined();
    await closeFromRow();
    expect(useStore.getState().workspaces.map((w) => w.id)).not.toContain('ws-t1');
    expect(keepFolderToast()).toBeUndefined();
    expect(close.mock.calls.every((c) => c.length === 2)).toBe(true);
  });

  it('a close that kept the folder (its repository is gone) says where', async () => {
    close.mockResolvedValueOnce({ ok: true, taskId: 't1', archivePending: false, unmaterialized: true, keptFolder: '/wt/t1' });
    mount();
    await settle();
    await closeFromRow();
    expect(useStore.getState().toasts.some((toast) => toast.message === 'Task closed. Its folder was kept at /wt/t1.')).toBe(true);
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

  it('a GitLab merge request reads as MR: the create toast, the linked state and the Open verb', async () => {
    const mr = 'https://gitlab.example.com/group/proj/-/merge_requests/7';
    createPr.mockResolvedValueOnce({ ok: true, prUrl: mr, mrIid: 7 });
    mount();
    await settle();
    const row = reviewRow('ws-t1')!;
    act(() => { row.focus(); });
    key(row, 'p');
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-fleet-review-confirm="pr"]')!.click(); });
    await settle();
    const toast = useStore.getState().toasts.at(-1);
    expect(toast?.message).toBe(`MR created: ${mr}`);
    expect(toast?.action?.label).toBe('Open MR');

    act(() => {
      useStore.setState({ missionByPaneGroup: { 'ws-t1': mission('t1', { prUrl: mr }), 'ws-t2': mission('t2') } });
    });
    await settle();
    const again = reviewRow('ws-t1')!;
    expect(again.textContent).toContain('MR linked');
    expect(again.textContent).not.toContain('PR linked');
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
    act(() => { useStore.setState({ appRoute: 'workspaces', fleetViewVisible: false }); });
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
