// @vitest-environment jsdom
//
// "Open a wmux pane here" on an external session, through the real store and
// the real pane funnel: a session in WSL gets a WSL shell in its distro at its
// Linux folder, never the default (Windows) shell handed a /home path.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { EmptyLeafFunnel } from '../../Layout/EmptyLeafFunnel';
import { openPaneInSessionFolder } from '../ExternalSessionPopover';
import { useStore } from '../../../stores';
import { createWorkspace, type Workspace } from '../../../../shared/types';
import { getWorkspaceLeafPanes } from '../../../../shared/paneUtils';
import type { ExternalSession } from '../../../../shared/externalSessions';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
let create: ReturnType<typeof vi.fn>;

function session(patch: Partial<ExternalSession>): ExternalSession {
  return {
    id: 'claude:s1', agent: 'claude', agentSessionId: 's1', cwd: '/home/dev/app',
    where: { kind: 'unknown', wslDistro: 'Ubuntu-24.04' }, state: 'idle', lastSignalAt: 1, startedAt: 0,
    ...patch,
  };
}

/** One workspace with one live terminal leaf (not empty: the funnel leaves it alone). */
function seedWorkspace(): string {
  const ws = createWorkspace('existing');
  const leaf = ws.rootPane;
  if (leaf.type !== 'leaf') throw new Error('fixture expects a leaf root');
  leaf.surfaces = [{ id: 'surf-1', ptyId: 'pty-1', title: 'pwsh', shell: 'pwsh.exe', cwd: 'C:\\code' } as never];
  leaf.activeSurfaceId = 'surf-1';
  act(() => useStore.setState({
    workspaces: [ws], activeWorkspaceId: ws.id, paneGate: 'ready', projectPaneSeed: {}, splitCwdSeed: {}, splitInheritsCwd: true,
  }));
  return ws.id;
}

function workspace(id: string | null): Workspace {
  const ws = useStore.getState().workspaces.find((w) => w.id === id);
  if (!ws) throw new Error(`no workspace ${id}`);
  return ws;
}

const mount = () => act(() => root.render(createElement(EmptyLeafFunnel)));
const createdWith = () => create.mock.calls[0][0] as Record<string, unknown>;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  create = vi.fn().mockReturnValue(new Promise(() => undefined));
  (window as unknown as { electronAPI: unknown }).electronAPI = { pty: { create, dispose: vi.fn() }, metadata: {} };
  act(() => useStore.setState({ workspaces: [], projectPaneSeed: {}, splitCwdSeed: {}, paneGate: 'ready', defaultShell: undefined }));
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  delete (window as unknown as { electronAPI?: unknown }).electronAPI;
  act(() => useStore.setState({ workspaces: [], projectPaneSeed: {}, splitCwdSeed: {} }));
});

describe('open a wmux pane where an external session runs', () => {
  it('a WSL session outside any workspace: a new workspace whose pane is a WSL shell in that distro and folder', () => {
    seedWorkspace();
    act(() => openPaneInSessionFolder(session({}), undefined));
    const ws = workspace(useStore.getState().activeWorkspaceId);
    expect(ws.name).not.toBe('existing');
    // No Linux startup folder for the other shells a later pane may run.
    expect(ws.profile?.startupCwd).toBeUndefined();
    mount();
    expect(create).toHaveBeenCalledTimes(1);
    expect(createdWith()).toMatchObject({ shell: 'wsl.exe', wslDistro: 'Ubuntu-24.04', cwd: '/home/dev/app', workspaceId: ws.id, spawnKind: 'user-shell' });
    // Consumed: a re-run of the funnel cannot replay it.
    expect(useStore.getState().projectPaneSeed).toEqual({});
  });

  it('a WSL session in a workspace: the split beside it is a WSL shell, not a split seeded with a /home path', () => {
    const wsId = seedWorkspace();
    act(() => openPaneInSessionFolder(session({}), wsId));
    const ws = workspace(wsId);
    expect(getWorkspaceLeafPanes(ws)).toHaveLength(2);
    expect(useStore.getState().splitCwdSeed).toEqual({});
    mount();
    expect(createdWith()).toMatchObject({ shell: 'wsl.exe', wslDistro: 'Ubuntu-24.04', cwd: '/home/dev/app', workspaceId: wsId });
  });

  it('the workspace profile\'s pane command (written for its own shell) is not typed into the WSL shell', () => {
    const wsId = seedWorkspace();
    act(() => useStore.setState((s) => {
      const ws = s.workspaces.find((w) => w.id === wsId);
      if (ws) ws.profile = { defaultPaneCommand: '.\\.venv\\Scripts\\Activate.ps1', env: { A: '1' } };
    }));
    act(() => openPaneInSessionFolder(session({}), wsId));
    mount();
    const options = createdWith();
    expect(options).toMatchObject({ shell: 'wsl.exe', env: { A: '1' } });
    expect(options.initialCommand).toBeUndefined();
  });

  it('a session outside WSL keeps the folder-only behaviour', () => {
    seedWorkspace();
    act(() => openPaneInSessionFolder(session({ cwd: 'C:\\code\\api', where: { kind: 'terminal', label: 'WezTerm' } }), undefined));
    const ws = workspace(useStore.getState().activeWorkspaceId);
    expect(ws.profile?.startupCwd).toBe('C:\\code\\api');
    mount();
    const options = createdWith();
    expect(options.cwd).toBe('C:\\code\\api');
    expect(options).not.toHaveProperty('wslDistro');
    expect(options.shell).not.toBe('wsl.exe');
  });

  it('a WSL session whose folder is not a Linux path opens no WSL shell', () => {
    seedWorkspace();
    act(() => openPaneInSessionFolder(session({ cwd: 'relative/dir' }), undefined));
    mount();
    expect(createdWith()).not.toHaveProperty('wslDistro');
  });
});
