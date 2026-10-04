// @vitest-environment jsdom
// Fleet hides settled workspaces (finished work, decided in main) behind a
// "Settled · n" chip; pressing it shows them. Snoozed workspaces stay visible.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import FleetView from '../FleetView';
import { useStore } from '../../../stores';
import type { Workspace, Pane, Surface } from '../../../../shared/types';

const act = React.act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function surface(id: string, ptyId: string): Surface {
  return { id, ptyId, title: id, shell: 'zsh', cwd: `/repo/${id}`, surfaceType: 'browser' };
}
function leaf(id: string, surfaces: Surface[]): Pane {
  return { id, type: 'leaf', surfaces, activeSurfaceId: surfaces[0]?.id ?? '' };
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
const cards = () => [...container.querySelectorAll('[data-fleet-card]')].map((el) => el.getAttribute('data-workspace-id'));
const chip = () => container.querySelector<HTMLButtonElement>('[data-fleet-stat="settled"]');

beforeEach(() => {
  act(() => { useStore.setState({ ...useStore.getInitialState(), locale: 'en' }); });
});
afterEach(() => {
  try { act(() => { root.unmount(); }); } catch { /* already unmounted */ }
  container.remove();
});

describe('Fleet settled chip', () => {
  it('hides settled workspaces by default, keeps snoozed ones, and shows them when pressed', async () => {
    act(() => useStore.setState({
      workspaces: agents(4),
      surfaceAgent: Object.fromEntries([0, 1, 2, 3].map((i) => [`pty-${i}`, { name: 'Claude Code', status: 'idle' as const }])),
      fleetIdleExpanded: true,
      workspaceSettle: {
        states: {
          'ws-1': { settled: { at: 1, reason: 'idle' } },
          'ws-2': { snoozedUntil: Date.now() + 60_000 },
          'ws-3': { settled: { at: 1, reason: 'pr' } },
        },
        idleDays: 3, hqWorkspaceId: null,
      },
    }));
    await mount();
    expect(cards().sort()).toEqual(['ws-0', 'ws-2']);
    expect(chip()?.textContent).toBe('Settled · 2');
    expect(chip()?.getAttribute('aria-pressed')).toBe('false');

    act(() => chip()!.click());
    expect(chip()?.getAttribute('aria-pressed')).toBe('true');
    expect(cards().sort()).toEqual(['ws-0', 'ws-1', 'ws-2', 'ws-3']);
  });

  it('draws no chip when nothing on the board is settled', async () => {
    act(() => useStore.setState({
      workspaces: agents(2),
      surfaceAgent: { 'pty-0': { name: 'Claude Code', status: 'idle' as const }, 'pty-1': { name: 'Claude Code', status: 'idle' as const } },
      fleetIdleExpanded: true,
      // Settled, but with nothing on the board: no chip (no dead gauges).
      workspaceSettle: { states: { 'ws-gone': { settled: { at: 1, reason: 'idle' } } }, idleDays: 3, hqWorkspaceId: null },
    }));
    await mount();
    expect(chip()).toBeNull();
    expect(cards().sort()).toEqual(['ws-0', 'ws-1']);
  });
});
