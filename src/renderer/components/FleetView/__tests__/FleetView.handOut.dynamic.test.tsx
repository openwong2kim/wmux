// @vitest-environment jsdom
//
// To hand out on the Fleet page: the list always has a way in (the zero row's
// "Add a task…"), open items stay under the empty page's call to action (a
// pick can still start a worktree or go to a company), and a pick that went
// through says only what is left to say.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import * as terminalTail from '../../../utils/terminalTail';
import FleetView from '../FleetView';
import { handOutPickNotices } from '../HandOutPopover';
import type { HandOutOption } from '../handOutTargets';
import { useStore } from '../../../stores';
import type { HandOutEntry } from '../../../../shared/handOut';
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
const item = (id: string, title: string): HandOutEntry =>
  ({ id, title, folder: '/repo', addedBy: { kind: 'owner' }, createdAt: Date.now() - 60_000, state: 'open' });

let container: HTMLDivElement;
let root: Root;
let items: HandOutEntry[] = [];

function mount(): void {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => { root.render(React.createElement(FleetView)); });
}

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  });
}

function seed(agents: boolean): void {
  act(() => {
    useStore.setState({
      ...useStore.getInitialState(),
      locale: 'en',
      fleetActiveTab: 'fleet',
      appRoute: 'fleet',
      fleetViewVisible: true,
      workspaces: agents ? [workspace('ws-1', 'w1', leaf('p1', [surface('s1', 'pty-1')]), 'p1')] : [],
      surfaceAgent: agents ? { 'pty-1': { name: 'Claude Code', status: 'idle' as const } } : {},
      surfaceTurnOpenAt: agents ? { 'pty-1': Date.now() } : {},
      agentClockMs: Date.now(),
    });
  });
}

beforeEach(() => {
  items = [];
  vi.spyOn(terminalTail, 'tailForPtyOrDaemon').mockResolvedValue([]);
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    pty: { write: () => undefined, dispose: () => undefined },
    handOut: { list: async () => items, onChanged: () => () => undefined },
  };
});

afterEach(() => {
  vi.restoreAllMocks();
  try { act(() => { root.unmount(); }); } catch { /* already unmounted */ }
  container.remove();
  document.body.innerHTML = '';
});

describe('FleetView — To hand out in the list', () => {
  it('draws the To hand out row at zero, after the agents, with "Add a task…" opening the form', async () => {
    seed(true);
    mount();
    await settle();
    const zero = container.querySelector<HTMLElement>('[data-fleet-hand-out-zero]');
    expect(zero?.dataset.fleetSection).toBe('handOut');
    expect(zero?.textContent).toContain('To hand out');
    const add = zero!.querySelector<HTMLButtonElement>('[data-fleet-hand-out-add-row]')!;
    expect(add.getAttribute('role')).toBe('option');
    act(() => add.click());
    expect(container.querySelector('[data-fleet-hand-out-form]')).not.toBeNull();
  });
});

describe('FleetView — an empty fleet with To hand out items', () => {
  it('keeps the call to action and lists the open items under it', async () => {
    items = [item('ho-1', 'Port the scrollback fix')];
    seed(false);
    mount();
    await settle();
    expect(container.querySelector('[data-fleet-view]')?.getAttribute('data-layout')).toBe('empty');
    expect(container.querySelector('[data-fleet-empty]')).not.toBeNull();
    expect(container.querySelector('[data-fleet-hand-out="ho-1"]')?.textContent).toContain('Port the scrollback fix');
  });

  it('draws the board column under it on the board', async () => {
    items = [item('ho-1', 'Port the scrollback fix')];
    seed(false);
    act(() => useStore.getState().setFleetLayout('board'));
    mount();
    await settle();
    expect(container.querySelector('[data-fleet-empty]')).not.toBeNull();
    const column = container.querySelector('[data-board-column="handOut"]');
    expect(column?.querySelector('[data-fleet-hand-out="ho-1"]')).not.toBeNull();
  });

  it('is unchanged with no items', async () => {
    seed(false);
    mount();
    await settle();
    expect(container.querySelector('[data-fleet-empty]')).not.toBeNull();
    expect(container.querySelector('[data-fleet-section="handOut"], [data-board-column="handOut"]')).toBeNull();
  });
});

describe('handOutPickNotices', () => {
  const t = (key: string, vars?: Record<string, string | number>) =>
    (key === 'git.handoff.why.user_typing' ? 'WHY' : vars ? `${key}(${Object.values(vars).join('|')})` : key);
  const pane = {
    kind: 'pane', key: 'pane:pty-1', name: '#dev-3', workspaceName: 'wmux', running: false, thisFolder: true, otherAgent: false,
    target: { workspaceId: 'ws-1', paneId: 'p1', ptyId: 'pty-1', agentName: 'Claude Code', agentSlug: 'claude' },
  } as HandOutOption;
  const worktree = { kind: 'worktree', key: 'worktree:ws-1', workspaceId: 'ws-1', folder: '/repo' } as HandOutOption;

  it('says nothing more for a delivered send', () => {
    expect(handOutPickNotices({ ok: true, linkId: 'l', delivered: true, assurance: 'assured' }, pane, 'T', t)).toEqual([]);
  });

  it('warns with the Git page\'s "check it started" when the paste is not known to have started a turn', () => {
    expect(handOutPickNotices({ ok: true, linkId: 'l', delivered: true, assurance: 'unverified' }, pane, 'T', t))
      .toEqual(['git.handoff.pasted(fleet.handOut.task|“T”|#dev-3|wmux)']);
  });

  it('says why a send was not delivered, in the Git page\'s words', () => {
    expect(handOutPickNotices({ ok: true, linkId: 'l', delivered: false, reason: 'user_typing' }, pane, 'T', t))
      .toEqual(['fleet.handOut.notDelivered(T|#dev-3) WHY']);
  });

  it('gives a worktree start only its preparation notice', () => {
    expect(handOutPickNotices({ ok: true, linkId: 'l', branch: 'b', prep: { missing: 0, refused: 0 } }, worktree, 'T', t)).toEqual([]);
    expect(handOutPickNotices({ ok: true, linkId: 'l', branch: 'b', prep: { skipped: 'untrusted', missing: 0, refused: 0 } }, worktree, 'T', t))
      .toEqual(['git.prepSkipped']);
  });
});
