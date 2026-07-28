// @vitest-environment jsdom
//
// Chat View steps aside when the pane's agent process dies.
//
// Killing `claude` leaves the PTY alive with a bare shell, so without this the
// lens renders a frozen conversation and the composer types into a shell that
// ignores it — no way back to an agent from inside Chat.
//
// The two properties this file exists for, in equal measure:
//   • the switch HAPPENS on the daemon's process-truth edge
//     (`agentProcessAlive === false`, AgentProcessTracker);
//   • the switch does NOT happen on anything softer — an unattributed pane
//     (`undefined`), a live agent, or a STALE `false` that the fresh reading
//     taken on entry contradicts (the "user just relaunched claude" case).
//     Ejecting a healthy pane is the worse bug of the two.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

vi.mock('../../Terminal/Terminal', () => ({
  default: (props: { visible?: boolean; surfaceId: string }) =>
    React.createElement('div', {
      'data-mock-terminal': props.surfaceId,
      'data-visible': props.visible === undefined ? 'default' : String(props.visible),
    }),
}));

vi.mock('../../Chat/ChatView', () => ({
  ChatView: (props: { ptyId: string }) =>
    React.createElement('div', { 'data-mock-chat': props.ptyId }),
}));

import { TerminalOrChat } from '../Pane';
import { useStore } from '../../../stores';
import { findLeaf } from '../../../../shared/paneUtils';
import type { Surface } from '../../../../shared/types';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const PTY = 'pty-liveness-1';
const SURFACE_ID = 'sf-liveness-1';

let container: HTMLDivElement;
let root: Root;
/** What the daemon's session list answers for this pane, per test. */
let listAnswer: Array<{ id: string; shell: string; agentProcessAlive?: boolean }> = [];

function surface(overrides: Partial<Surface> = {}): Surface {
  return {
    id: SURFACE_ID,
    ptyId: PTY,
    title: 'Terminal',
    shell: '',
    cwd: '/repo',
    surfaceType: 'terminal',
    ...overrides,
  };
}

/** Put the surface in the store too — setSurfaceChatMode walks the pane tree. */
function seedSurface(overrides: Partial<Surface> = {}): void {
  useStore.setState((s) => {
    const ws = s.workspaces.find((w) => w.id === s.activeWorkspaceId)!;
    const leaf = findLeaf(ws.rootPane, ws.rootPane.id);
    if (!leaf) return;
    leaf.surfaces.length = 0;
    leaf.surfaces.push(surface(overrides));
    leaf.activeSurfaceId = SURFACE_ID;
  });
}

function storedSurface(): Surface | undefined {
  const s = useStore.getState();
  const ws = s.workspaces.find((w) => w.id === s.activeWorkspaceId)!;
  return findLeaf(ws.rootPane, ws.rootPane.id)?.surfaces.find((sf) => sf.id === SURFACE_ID);
}

/** Mount, then let the entry reading resolve so the switch is armed. */
async function mount(sf: Surface): Promise<void> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(
      React.createElement(TerminalOrChat, {
        surface: sf,
        workspaceId: 'ws-1',
        isActive: true,
        isWorkspaceVisible: true,
        onPtyCreated: () => undefined,
      }),
    );
  });
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
}

beforeEach(() => {
  const state = useStore.getState();
  for (const w of [...state.workspaces]) state.removeWorkspace(w.id);
  state.addWorkspace();
  useStore.setState((s) => {
    // removeWorkspace refuses to drop the last workspace, so keep only the
    // fresh one — a leftover holding this id would be found first.
    s.workspaces = s.workspaces.filter((w) => w.id === s.activeWorkspaceId);
    s.agentAliveByPtyId = {};
    s.toasts = [];
    s.chatStatus = {};
  });
  listAnswer = [{ id: PTY, shell: 'zsh' }];
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    pty: { list: () => Promise.resolve(listAnswer) },
  };
});

afterEach(() => {
  act(() => { root.unmount(); });
  container.remove();
  delete (window as unknown as { electronAPI?: unknown }).electronAPI;
});

describe('Chat View — the agent process dies underneath the lens', () => {
  it('switches the surface back to the terminal and says why', async () => {
    listAnswer = [{ id: PTY, shell: 'zsh', agentProcessAlive: false }];
    seedSurface({ chatMode: true });
    await mount(surface({ chatMode: true }));

    expect(storedSurface()?.chatMode).toBeUndefined();
    expect(useStore.getState().toasts.map((t) => t.message)).toEqual([
      'The agent in this pane exited — back to the terminal.',
    ]);
  });

  it('switches on a liveness update that arrives while Chat is open', async () => {
    seedSurface({ chatMode: true });
    await mount(surface({ chatMode: true }));
    expect(storedSurface()?.chatMode).toBe(true);

    await act(async () => {
      useStore.getState().hydrateAgentAlive({ [PTY]: false });
    });

    expect(storedSurface()?.chatMode).toBeUndefined();
    expect(useStore.getState().toasts).toHaveLength(1);
  });
});

describe('Chat View — a healthy pane is never ejected', () => {
  it('stays in Chat when the tracker never attributed a process (undefined)', async () => {
    seedSurface({ chatMode: true });
    await mount(surface({ chatMode: true }));

    expect(storedSurface()?.chatMode).toBe(true);
    expect(useStore.getState().toasts).toHaveLength(0);
  });

  it('stays in Chat while the agent process is alive', async () => {
    listAnswer = [{ id: PTY, shell: 'zsh', agentProcessAlive: true }];
    seedSurface({ chatMode: true });
    await mount(surface({ chatMode: true }));

    expect(storedSurface()?.chatMode).toBe(true);
    expect(useStore.getState().toasts).toHaveLength(0);
  });

  it('ignores a STALE dead flag the entry reading contradicts (agent relaunched)', async () => {
    // The 15 s poll left `false` behind; the agent has since been relaunched
    // and the daemon's list already says so. Acting on the store alone would
    // bounce the user out of Chat the moment they re-entered it.
    useStore.setState((s) => { s.agentAliveByPtyId[PTY] = false; });
    listAnswer = [{ id: PTY, shell: 'zsh', agentProcessAlive: true }];
    seedSurface({ chatMode: true });
    await mount(surface({ chatMode: true }));

    expect(storedSurface()?.chatMode).toBe(true);
    expect(useStore.getState().toasts).toHaveLength(0);
  });

  it('leaves a terminal-mode surface alone even with a dead agent', async () => {
    listAnswer = [{ id: PTY, shell: 'zsh', agentProcessAlive: false }];
    seedSurface();
    await mount(surface());

    expect(storedSurface()?.chatMode).toBeUndefined();
    expect(useStore.getState().toasts).toHaveLength(0);
    expect(container.querySelector('[data-mock-chat]')).toBeNull();
  });
});
