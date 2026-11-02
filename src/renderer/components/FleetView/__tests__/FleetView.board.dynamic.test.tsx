// @vitest-environment jsdom
//
// The Board layout: the list's rows in four columns (Needs you, Running,
// Finished, Idle). ↑↓ move inside a column, ←→ to the neighbouring non-empty
// one, Enter jumps like a list row, and the List | Board switch in the header
// is a store setting.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import * as terminalTail from '../../../utils/terminalTail';
import FleetView from '../FleetView';
import { useStore } from '../../../stores';
import type { Workspace, Pane, Surface } from '../../../../shared/types';

const act = React.act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function surface(id: string, ptyId: string): Surface {
  return { id, ptyId, title: `${id} task`, shell: 'zsh', cwd: `/repo/${id}`, surfaceType: 'terminal' };
}
function leaf(id: string, surfaces: Surface[]): Pane {
  return { id, type: 'leaf', surfaces, activeSurfaceId: surfaces[0]?.id ?? '' };
}
function workspace(id: string, name: string, rootPane: Pane, activePaneId: string): Workspace {
  return { id, name, rootPane, activePaneId };
}

let container: HTMLDivElement;
let root: Root;

function mount(): void {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => { root.render(React.createElement(FleetView)); });
}

async function flushRaf(): Promise<void> {
  await act(async () => {
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  });
}

function card(ptyId: string): HTMLButtonElement {
  return container.querySelector<HTMLButtonElement>(`[data-fleet-card][data-pty-id="${ptyId}"]`)!;
}
function focusedPty(): string | undefined {
  return (document.activeElement as HTMLElement | null)?.dataset.ptyId;
}
function key(name: string): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true });
  act(() => { document.activeElement!.dispatchEvent(event); });
  return event;
}

beforeEach(() => {
  vi.spyOn(terminalTail, 'tailForPtyOrDaemon').mockResolvedValue([]);
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    pty: { write: () => undefined, dispose: () => undefined },
  };
  const ids = ['1', '2', '3', '4', '5'];
  act(() => {
    useStore.setState({
      ...useStore.getInitialState(),
      locale: 'en',
      fleetActiveTab: 'fleet',
      fleetSortMode: 'attention',
      appRoute: 'fleet',
      fleetViewVisible: true,
      workspaces: ids.map((n) => workspace(`ws-${n}`, `w${n}`, leaf(`p${n}`, [surface(`s${n}`, `pty-${n}`)]), `p${n}`)),
      surfaceAgent: Object.fromEntries(ids.map((n) => [`pty-${n}`, { name: 'Claude Code', status: 'idle' as const }])),
      // pty-1 asks, pty-2 and pty-5 run, pty-3 finished, pty-4 is idle.
      surfaceAgentStatus: { 'pty-1': 'awaiting_input', 'pty-3': 'complete' },
      surfacePendingQuestion: { 'pty-1': 'Apply the migration?' },
      surfaceTurnOpenAt: { 'pty-2': Date.now(), 'pty-5': Date.now() },
      surfaceOutputAt: { 'pty-3': Date.now() - 2 * 60_000 },
      agentClockMs: Date.now(),
    });
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  try { act(() => { root.unmount(); }); } catch { /* already unmounted */ }
  container.remove();
  document.body.innerHTML = '';
});

describe('FleetView — Board layout', () => {
  it('draws To hand out (empty, as the way to add) and the four status columns in order, each card in the column of its section', async () => {
    act(() => useStore.getState().setFleetLayout('board'));
    mount();
    await flushRaf();
    expect(container.querySelector('[data-fleet-view]')?.getAttribute('data-layout')).toBe('board');
    const columns = [...container.querySelectorAll<HTMLElement>('[data-board-column]')];
    expect(columns.map((c) => c.dataset.boardColumn)).toEqual(['handOut', 'running', 'needsYou', 'finished', 'idle']);
    expect(columns.map((c) => c.getAttribute('aria-label'))).toEqual(['To hand out', 'Running', 'Needs you', 'Finished', 'Idle']);
    const ptysIn = (column: string) => [...container.querySelectorAll<HTMLElement>(`[data-board-column="${column}"] [data-fleet-card]`)]
      .map((el) => el.dataset.ptyId);
    expect(ptysIn('needsYou')).toEqual(['pty-1']);
    expect(ptysIn('running').sort()).toEqual(['pty-2', 'pty-5']);
    expect(ptysIn('finished')).toEqual(['pty-3']);
    expect(ptysIn('idle')).toEqual(['pty-4']);
    // Nothing folds on the board: no Finished / Idle toggle rows.
    expect(container.querySelector('[data-fleet-finished-toggle], [data-fleet-idle-toggle]')).toBeNull();
  });

  it('↑↓ move inside a column and ←→ to the neighbouring column', async () => {
    act(() => useStore.getState().setFleetLayout('board'));
    mount();
    await flushRaf();
    const running = [...container.querySelectorAll<HTMLElement>('[data-board-column="running"] [data-fleet-card]')]
      .map((el) => el.dataset.ptyId);
    // Columns run Running, Needs you, Finished, Idle; focus starts on the
    // board's first card.
    expect(focusedPty()).toBe(running[0]);
    key('ArrowDown');
    await flushRaf();
    expect(focusedPty()).toBe(running[1]);
    // From the second Running card, → lands on Needs you's only card.
    key('ArrowRight');
    await flushRaf();
    expect(focusedPty()).toBe('pty-1');
    key('ArrowRight');
    await flushRaf();
    expect(focusedPty()).toBe('pty-3');
    key('ArrowRight');
    await flushRaf();
    expect(focusedPty()).toBe('pty-4');
    key('ArrowLeft');
    await flushRaf();
    expect(focusedPty()).toBe('pty-3');
    key('ArrowLeft');
    await flushRaf();
    expect(focusedPty()).toBe('pty-1');
    key('ArrowLeft');
    await flushRaf();
    expect(focusedPty()).toBe(running[0]);
    key('ArrowUp');
    await flushRaf();
    expect(focusedPty()).toBe(running[0]);
  });

  it('Space shows or hides the shared detail area and Enter jumps to the agent', async () => {
    act(() => useStore.getState().setFleetLayout('board'));
    mount();
    await flushRaf();
    expect(container.querySelector('[data-fleet-detail]')).toBeNull();
    key(' ');
    await flushRaf();
    expect(container.querySelector('[data-fleet-detail]')).not.toBeNull();
    key(' ');
    await flushRaf();
    expect(container.querySelector('[data-fleet-detail]')).toBeNull();
    // A deliberate move opens it, as on the list.
    key('ArrowRight');
    await flushRaf();
    expect(container.querySelector('[data-fleet-detail]')).not.toBeNull();
    const target = focusedPty()!;
    // Enter is left to the card button's native activation (a click), as on a list row.
    const enter = key('Enter');
    expect(enter.defaultPrevented).toBe(false);
    act(() => card(target).click());
    expect(useStore.getState().activeWorkspaceId).toBe(`ws-${target.slice('pty-'.length)}`);
    expect(useStore.getState().fleetViewVisible).toBe(false);
  });

  it('the List | Board switch in the header sets the store setting', async () => {
    mount();
    await flushRaf();
    expect(useStore.getState().fleetLayout).toBe('list');
    expect(container.querySelector('[data-fleet-board]')).toBeNull();
    const toggle = container.querySelector('[data-testid="fleet-layout"]')!;
    const board = [...toggle.querySelectorAll<HTMLButtonElement>('[role="radio"]')].find((b) => b.textContent === 'Board')!;
    act(() => board.click());
    expect(useStore.getState().fleetLayout).toBe('board');
    expect(container.querySelector('[data-fleet-board]')).not.toBeNull();
    expect(container.querySelector('.wmux-fleet-list')).toBeNull();
    const list = [...toggle.querySelectorAll<HTMLButtonElement>('[role="radio"]')].find((b) => b.textContent === 'List')!;
    act(() => list.click());
    expect(useStore.getState().fleetLayout).toBe('list');
    expect(container.querySelector('.wmux-fleet-list')).not.toBeNull();
  });

  it('the List | Board switch shows on an empty Fleet too', async () => {
    act(() => useStore.setState({ workspaces: [], surfaceAgent: {}, surfaceAgentStatus: {}, surfacePendingQuestion: {} }));
    mount();
    await flushRaf();
    expect(container.querySelector('[data-fleet-view]')?.getAttribute('data-layout')).toBe('empty');
    expect(container.querySelector('[data-fleet-empty]')).not.toBeNull();
    const toggle = container.querySelector('[data-testid="fleet-layout"]');
    expect(toggle).not.toBeNull();
    const board = [...toggle!.querySelectorAll<HTMLButtonElement>('[role="radio"]')].find((b) => b.textContent === 'Board')!;
    act(() => board.click());
    expect(useStore.getState().fleetLayout).toBe('board');
  });

  it('a status filter keeps only its column', async () => {
    act(() => useStore.getState().setFleetLayout('board'));
    mount();
    await flushRaf();
    act(() => container.querySelector<HTMLButtonElement>('[data-filter="running"]')!.click());
    expect([...container.querySelectorAll<HTMLElement>('[data-board-column]')].map((c) => c.dataset.boardColumn)).toEqual(['running']);
  });
});
