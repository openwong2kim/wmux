// @vitest-environment jsdom
// The Fleet page as a board: the layout follows how many agents there are
// (none → a call to action and recent work; up to 3 → one list; 4–19 →
// columns; 20+ → compact cards), and `a` opens the Approvals tab on the request
// waiting on the focused agent — it never approves anything itself.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import FleetView from '../FleetView';
import { useStore } from '../../../stores';
import * as resolveInbox from '../../../utils/resolveInboxItem';
import type { Workspace, Pane, Surface } from '../../../../shared/types';

const act = React.act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function surface(id: string, ptyId: string): Surface {
  return { id, ptyId, title: id, shell: 'zsh', cwd: `/repo/${id}`, surfaceType: 'browser' };
}
function leaf(id: string, surfaces: Surface[]): Pane {
  return { id, type: 'leaf', surfaces, activeSurfaceId: surfaces[0]?.id ?? '' };
}
/** Idle agents (an agent identity on each pane). */
function agentIdentities(count: number) {
  return Object.fromEntries(Array.from({ length: count }, (_, i) => [`pty-${i}`, { name: 'Claude Code', status: 'idle' as const }]));
}
function agents(count: number): Workspace[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `ws-${i}`, name: `proj-${i}`, rootPane: leaf(`p${i}`, [surface(`s${i}`, `pty-${i}`)]), activePaneId: `p${i}`,
  }));
}

let container: HTMLDivElement;
let root: Root;
async function mount(): Promise<void> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => { root.render(React.createElement(FleetView)); });
  await act(async () => { await new Promise<void>((resolve) => requestAnimationFrame(() => resolve())); });
}
const layout = () => container.querySelector('.wmux-board')?.getAttribute('data-layout');

beforeEach(() => {
  act(() => { useStore.setState({ ...useStore.getInitialState(), locale: 'en' }); });
});
afterEach(() => {
  try { act(() => { root.unmount(); }); } catch { /* already unmounted */ }
  container.remove();
  vi.restoreAllMocks();
});

describe('Fleet board layout', () => {
  it('with no agents (plain shells only) shows one call to action and the three newest finished tasks', async () => {
    const done = (id: string, at: string) => ({
      id, status: { state: 'completed', timestamp: at }, metadata: { title: `Task ${id}` },
    });
    act(() => useStore.setState({
      workspaces: agents(2),
      a2aTasks: Object.fromEntries([
        ['t1', done('t1', '2026-10-03T01:00:00Z')], ['t2', done('t2', '2026-10-03T03:00:00Z')],
        ['t3', done('t3', '2026-10-03T02:00:00Z')], ['t4', done('t4', '2026-10-03T00:00:00Z')],
        ['t5', { id: 't5', status: { state: 'working', timestamp: '2026-10-03T04:00:00Z' }, metadata: { title: 'Task t5' } }],
      ]) as unknown as ReturnType<typeof useStore.getState>['a2aTasks'],
    }));
    await mount();
    expect(layout()).toBe('empty');
    const empty = container.querySelector('[data-fleet-empty]')!;
    expect(empty.querySelectorAll('[data-fleet-new-agent]')).toHaveLength(1);
    expect([...empty.querySelectorAll('li')].map((li) => li.textContent)).toEqual([
      expect.stringContaining('Task t2'), expect.stringContaining('Task t3'), expect.stringContaining('Task t1'),
    ]);
    // Nothing to count: no summary strip, no key hints, no search.
    expect(container.querySelector('[data-fleet-summary]')).toBeNull();
    expect(container.querySelector('input[type=search]')).toBeNull();
  });

  it('with no agents still offers the way into waiting approvals', async () => {
    act(() => useStore.setState({
      workspaces: agents(2),
      pendingExecuteApprovals: {
        r1: { requestId: 'r1', senderWorkspaceId: 'ws-x', receiverWorkspaceId: 'ws-0', command: 'ls', createdAt: Date.now() },
      } as unknown as ReturnType<typeof useStore.getState>['pendingExecuteApprovals'],
      pendingExecuteApprovalOrder: ['r1'],
    }));
    await mount();
    expect(layout()).toBe('empty');
    const stat = container.querySelector<HTMLButtonElement>('[data-fleet-stat="approvals"]')!;
    expect(stat).not.toBeNull();
    expect(container.querySelector('[data-fleet-stat="idle"]')).toBeNull();
    act(() => stat.click());
    expect(container.querySelector('[data-fleet-panel="approvals"]')).not.toBeNull();
  });

  it('is one list up to three agents, columns from four, and compact cards from twenty', async () => {
    act(() => useStore.setState({ workspaces: agents(3), surfaceAgent: agentIdentities(3) }));
    await mount();
    expect(layout()).toBe('list');
    act(() => useStore.setState({ workspaces: agents(4), surfaceAgent: agentIdentities(4), fleetIdleExpanded: true }));
    expect(layout()).toBe('board');
    expect(container.querySelector('[data-fleet-card]')?.hasAttribute('data-dense')).toBe(false);
    act(() => useStore.setState({ workspaces: agents(20), surfaceAgent: agentIdentities(20), fleetIdleExpanded: true }));
    expect(layout()).toBe('dense');
    expect(container.querySelector('[data-fleet-card]')?.getAttribute('data-dense')).toBe('true');
  });
});

describe('Fleet board keys', () => {
  it('a opens the Approvals tab on the request waiting on the focused agent and never approves', async () => {
    const resolve = vi.spyOn(resolveInbox, 'resolveInboxItem').mockImplementation(() => undefined);
    const now = Date.now();
    act(() => useStore.setState({
      workspaces: agents(2),
      surfaceAgentStatus: { 'pty-0': 'awaiting_input', 'pty-1': 'awaiting_input' },
      // Two waiting requests: ws-0's is the SECOND row, so landing on it
      // proves `a` picks the matching row, not the first one.
      pendingExecuteApprovals: {
        r1: { requestId: 'r1', senderWorkspaceId: 'ws-x', receiverWorkspaceId: 'ws-1', command: 'ls', createdAt: now },
        r0: { requestId: 'r0', senderWorkspaceId: 'ws-x', receiverWorkspaceId: 'ws-0', command: 'rm -rf build', createdAt: now },
      } as unknown as ReturnType<typeof useStore.getState>['pendingExecuteApprovals'],
      pendingExecuteApprovalOrder: ['r1', 'r0'],
    }));
    await mount();
    const card = (ws: string) => container.querySelector<HTMLButtonElement>(`[data-fleet-card][data-workspace-id="${ws}"]`)!;
    expect(card('ws-0').querySelector('[data-fleet-chip="approval"]')).not.toBeNull();
    act(() => card('ws-0').focus());
    act(() => card('ws-0').dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true })));
    await act(async () => { await new Promise<void>((r) => requestAnimationFrame(() => r())); });
    expect(useStore.getState().fleetActiveTab).toBe('approvals');
    const panel = container.querySelector('[data-fleet-panel="approvals"]')!;
    expect(panel).not.toBeNull();
    const rows = panel.querySelectorAll<HTMLElement>('[role=option]');
    expect(rows).toHaveLength(2);
    expect(document.activeElement).toBe(rows[1]);
    expect(resolve).not.toHaveBeenCalled();
  });

  it('a on an agent with nothing waiting opens the approvals list', async () => {
    const resolve = vi.spyOn(resolveInbox, 'resolveInboxItem').mockImplementation(() => undefined);
    act(() => useStore.setState({
      workspaces: agents(2),
      surfaceAgentStatus: { 'pty-0': 'awaiting_input', 'pty-1': 'awaiting_input' },
      pendingExecuteApprovals: {
        r1: { requestId: 'r1', senderWorkspaceId: 'ws-x', receiverWorkspaceId: 'ws-0', command: 'ls', createdAt: Date.now() },
      } as unknown as ReturnType<typeof useStore.getState>['pendingExecuteApprovals'],
      pendingExecuteApprovalOrder: ['r1'],
    }));
    await mount();
    const card = (ws: string) => container.querySelector<HTMLButtonElement>(`[data-fleet-card][data-workspace-id="${ws}"]`)!;
    expect(card('ws-1').querySelector('[data-fleet-chip="approval"]')).toBeNull();
    act(() => card('ws-1').focus());
    act(() => card('ws-1').dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true })));
    expect(useStore.getState().fleetActiveTab).toBe('approvals');
    expect(container.querySelector('[data-fleet-panel="approvals"]')).not.toBeNull();
    expect(resolve).not.toHaveBeenCalled();
  });

});

describe('Fleet board idle column', () => {
  it('names up to five idle agents while folded, with the rest as +N more', async () => {
    act(() => useStore.setState({ workspaces: agents(8), surfaceAgent: agentIdentities(8), fleetIdleExpanded: false }));
    await mount();
    expect(container.querySelectorAll('[data-fleet-card]')).toHaveLength(0);
    const peek = container.querySelector('[data-fleet-idle-peek]')!;
    expect(peek.querySelectorAll('.wmux-board-idle-row')).toHaveLength(5);
    const more = [...peek.querySelectorAll('button')].find((b) => b.textContent === '+3 more')!;
    act(() => more.click());
    expect(useStore.getState().fleetIdleExpanded).toBe(true);
    expect(container.querySelectorAll('[data-fleet-card]')).toHaveLength(8);
    expect(container.querySelector('[data-fleet-idle-peek]')).toBeNull();
  });
});

describe('Fleet board and Moa', () => {
  it('leaves Moa\'s HQ workspace off the board and its counts: Moa is the main bot, not a worker', async () => {
    act(() => useStore.setState({ workspaces: agents(5), surfaceAgent: agentIdentities(5), fleetIdleExpanded: true, moa: null, moaHqSeed: 'ws-0' }));
    await mount();
    expect(container.querySelector('[data-fleet-card][data-workspace-id="ws-0"]')).toBeNull();
    expect(container.querySelectorAll('[data-fleet-card]')).toHaveLength(4);
    expect(container.querySelector('[data-fleet-stat="idle"]')?.textContent).toContain('4');
  });
});
