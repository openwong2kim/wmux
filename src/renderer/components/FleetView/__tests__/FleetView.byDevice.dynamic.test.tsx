// @vitest-environment jsdom
//
// The list grouped by device: Needs you stays one section on top (its rows
// name their device), then each device's head with its running rows and its
// Finished / Idle folds. A PC whose attachments are all stale keeps a row-less
// head. Keyboard order is the drawn order; the board shows no grouping.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import * as terminalTail from '../../../utils/terminalTail';
import FleetView from '../FleetView';
import { useStore } from '../../../stores';
import type { Workspace, Pane, Surface } from '../../../../shared/types';
import type { AttachedRemoteWorkspace } from '../../../stores/slices/remoteWorkspacesSlice';

const act = React.act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function surface(id: string, ptyId: string): Surface {
  return { id, ptyId, title: `${id} task`, shell: 'zsh', cwd: `/repo/${id}`, surfaceType: 'terminal' };
}
function remoteSurface(id: string, hostId: string, sessionId: string): Surface {
  return { id, ptyId: '', title: `${id} task`, shell: 'zsh', cwd: '', surfaceType: 'remote-terminal', remoteHostId: hostId, remoteSessionId: sessionId };
}
function leaf(id: string, surfaces: Surface[]): Pane {
  return { id, type: 'leaf', surfaces, activeSurfaceId: surfaces[0]?.id ?? '' };
}
function workspace(id: string, name: string, rootPane: Pane, activePaneId: string): Workspace {
  return { id, name, rootPane, activePaneId };
}
function attached(hostId: string, hostLabel: string, panes: AttachedRemoteWorkspace['panes'], stale = false): AttachedRemoteWorkspace {
  return { key: `${hostId}:rw`, hostId, hostLabel, workspaceId: 'rw', name: 'remote', panes, ...(stale ? { stale } : {}) };
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
function key(name: string): void {
  act(() => { document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true })); });
}
const heads = () => [...container.querySelectorAll<HTMLElement>('[data-fleet-device-head]')];

beforeEach(() => {
  vi.spyOn(terminalTail, 'tailForPtyOrDaemon').mockResolvedValue([]);
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    pty: { write: () => undefined, dispose: () => undefined },
  };
  act(() => {
    useStore.setState({
      ...useStore.getInitialState(),
      locale: 'en',
      fleetActiveTab: 'fleet',
      fleetSortMode: 'attention',
      appRoute: 'fleet',
      fleetViewVisible: true,
      fleetGroupBy: 'device',
      workspaces: [
        workspace('ws-1', 'w1', leaf('p1', [surface('s1', 'pty-1')]), 'p1'),
        workspace('ws-2', 'w2', leaf('p2', [surface('s2', 'pty-2')]), 'p2'),
        workspace('ws-3', 'w3', leaf('p3', [surface('s3', 'pty-3')]), 'p3'),
        workspace('ws-b', 'wb', leaf('pb', [remoteSurface('sb', 'host-b', 'sess-b')]), 'pb'),
        workspace('ws-c', 'wc', leaf('pc', [remoteSurface('sc', 'host-b', 'sess-c')]), 'pc'),
      ],
      surfaceAgent: Object.fromEntries(['pty-1', 'pty-2', 'pty-3'].map((p) => [p, { name: 'Claude Code', status: 'idle' as const }])),
      // Here: pty-1 asks, pty-2 runs, pty-3 is idle. On beta: one asks, one runs.
      surfaceAgentStatus: { 'pty-1': 'awaiting_input' },
      surfacePendingQuestion: { 'pty-1': 'Apply the migration?' },
      surfaceTurnOpenAt: { 'pty-2': Date.now() },
      agentClockMs: Date.now(),
      remoteWorkspaces: [
        attached('host-b', 'beta', [
          { sessionId: 'sess-b', agentName: 'Codex', agentStatus: 'awaiting_input' },
          { sessionId: 'sess-c', agentName: 'Codex', agentStatus: 'running' },
        ]),
        attached('host-off', 'office', [{ sessionId: 'sess-o', agentName: 'Codex', agentStatus: 'running' }], true),
      ],
    });
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  try { act(() => { root.unmount(); }); } catch { /* already unmounted */ }
  container.remove();
  document.body.innerHTML = '';
});

describe('FleetView — the list grouped by device', () => {
  it('keeps Needs you on top across devices, naming each row\'s device, then a head per device', async () => {
    mount();
    await flushRaf();
    const needsYou = [...container.querySelectorAll<HTMLElement>('[data-fleet-card][data-status="awaiting_input"]')];
    expect(needsYou).toHaveLength(2);
    expect(needsYou.map((el) => el.querySelector('[data-fleet-device]')?.textContent).sort()).toEqual(['This computer', 'beta']);
    // Named in words, so not again as the "@host" glyph.
    expect(container.querySelector('[data-fleet-card][data-workspace-id="ws-b"] [data-fleet-remote]')).toBeNull();
    // The Needs you head counts both, once; no device head counts them again.
    expect(container.querySelector('[data-fleet-section="needsYou"] .wmux-board-col-count')?.textContent).toBe('2');
    expect(heads().map((h) => h.dataset.fleetDeviceHead)).toEqual(['local', 'host-b', 'host-off']);
    expect(heads().map((h) => h.textContent)).toEqual([
      'This computerRunning 1 · Idle 1', 'betaOnline · Running 1', 'officeDisconnected',
    ]);
    // Rows under their own device's head do not repeat the host.
    const betaRunning = container.querySelector<HTMLElement>('[data-fleet-card][data-status="running"][data-workspace-id="ws-c"]');
    expect(betaRunning?.querySelector('[data-fleet-remote]')).toBeNull();
    expect(betaRunning?.querySelector('[data-fleet-device]')).toBeNull();
  });

  it('moves the keyboard in the drawn order, through each device\'s fold', async () => {
    mount();
    await flushRaf();
    const drawn = [...container.querySelectorAll<HTMLElement>('[data-fleet-key]')].map((el) => el.dataset.fleetKey);
    const visited = [(document.activeElement as HTMLElement).dataset.fleetKey];
    for (let i = 1; i < drawn.length; i++) {
      key('ArrowDown');
      await flushRaf();
      visited.push((document.activeElement as HTMLElement).dataset.fleetKey);
    }
    expect(visited).toEqual(drawn);
    expect(drawn).toContain('fleet:idle-toggle:local');
  });

  it('keeps a device\'s fold when Fleet is closed and opened again', async () => {
    mount();
    await flushRaf();
    const toggle = () => container.querySelector<HTMLButtonElement>('[data-fleet-key="fleet:idle-toggle:local"]')!;
    expect(toggle().getAttribute('aria-expanded')).toBe('false');
    act(() => toggle().click());
    act(() => { root.unmount(); });
    container.remove();
    mount();
    await flushRaf();
    expect(toggle().getAttribute('aria-expanded')).toBe('true');
    expect(container.querySelector('[data-fleet-card][data-workspace-id="ws-3"]')).not.toBeNull();
  });

  it('a PC the rail still reaches is not drawn as disconnected, and a host carries the rail\'s name', async () => {
    act(() => useStore.setState({
      pcRailHosts: [{ id: 'host-b', label: 'office' }, { id: 'host-off', label: 'home' }],
      pcRailHostStatus: { 'host-b': 'connected', 'host-off': 'connected' },
    }));
    mount();
    await flushRaf();
    expect(heads().map((h) => h.dataset.fleetDeviceHead)).toEqual(['local', 'host-b']);
    expect(heads()[1].textContent).toBe('officeOnline · Running 1');
    act(() => useStore.setState({ pcRailHostStatus: { 'host-b': 'connected', 'host-off': 'unreachable' } }));
    await flushRaf();
    expect(heads().map((h) => h.textContent)).toContain('homeDisconnected');
  });

  it('a search narrows each device and drops the row-less head', async () => {
    mount();
    await flushRaf();
    const search = container.querySelector<HTMLInputElement>('input[type=search]')!;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(search, 'w3');
      search.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await flushRaf();
    expect(heads().map((h) => h.dataset.fleetDeviceHead)).toEqual(['local']);
    expect([...container.querySelectorAll<HTMLElement>('[data-fleet-card]')].map((el) => el.dataset.workspaceId)).toEqual(['ws-3']);
  });

  it('the board keeps its status columns and does not offer the grouping', async () => {
    act(() => useStore.getState().setFleetLayout('board'));
    mount();
    await flushRaf();
    expect(container.querySelector('[data-testid="fleet-group-by"]')).toBeNull();
    expect(heads()).toHaveLength(0);
  });
});
