// @vitest-environment jsdom
//
// PC rail, "This computer only" in the file tree: with another computer on
// screen it names that computer's files and never reads or watches a folder
// on this disk, not even the local workspace's.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import FileTreePanel from '../FileTreePanel';
import { useStore } from '../../../stores';
import { DEFAULT_PC_RAIL_PERSISTED, formatShadowWorkspaceId } from '../../../../shared/pcRail';
import type { Workspace } from '../../../../shared/types';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function workspace(id: string, cwd: string): Workspace {
  return {
    id, name: id,
    rootPane: { id: `p-${id}`, type: 'leaf', activeSurfaceId: `s-${id}`, surfaces: [{ id: `s-${id}`, ptyId: `pty-${id}`, title: id, shell: 'zsh', cwd, surfaceType: 'terminal' }] },
    activePaneId: `p-${id}`,
    metadata: { cwd },
  } as Workspace;
}

const SHADOW = formatShadowWorkspaceId('h1', 'ws-remote') as string;
let container: HTMLDivElement;
let root: Root;
let readDir: ReturnType<typeof vi.fn>;
let watch: ReturnType<typeof vi.fn>;

const flush = async () => { for (let i = 0; i < 10; i++) await act(async () => { await Promise.resolve(); }); };
const remoteNote = () => container.querySelector('[data-filetree-remote]')?.textContent ?? null;

beforeEach(() => {
  readDir = vi.fn(async () => [{ name: 'README.md', path: '/code/local/README.md', isDirectory: false }]);
  watch = vi.fn();
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    fs: { readDir, watch, unwatch: vi.fn(), onChanged: vi.fn(() => () => undefined), readFile: vi.fn() },
  };
  act(() => useStore.setState({
    workspaces: [workspace('a', '/code/local'), workspace(SHADOW, '/Users/remote/repo')],
    activeWorkspaceId: 'a',
    pcRailHosts: [{ id: 'h1', label: 'office-mac' }],
    pcRail: { ...DEFAULT_PC_RAIL_PERSISTED },
  }));
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  useStore.setState({ pcRailHosts: [], pcRail: { ...DEFAULT_PC_RAIL_PERSISTED } });
  delete (window as unknown as { electronAPI?: unknown }).electronAPI;
});

describe('FileTreePanel with another computer on screen', () => {
  it('this computer: reads the workspace folder as before', async () => {
    act(() => root.render(createElement(FileTreePanel, { position: 'right' })));
    await flush();
    expect(readDir).toHaveBeenCalledWith('/code/local');
    expect(remoteNote()).toBeNull();
  });

  it('a remote computer selected: names its files and reads nothing', async () => {
    act(() => useStore.setState({ pcRail: { ...DEFAULT_PC_RAIL_PERSISTED, activePcId: 'h1' } }));
    act(() => root.render(createElement(FileTreePanel, { position: 'right' })));
    await flush();
    expect(remoteNote()).toBe("Files on office-mac aren't shown yet");
    expect(readDir).not.toHaveBeenCalled();
    expect(watch).not.toHaveBeenCalled();
  });

  it('a shadow workspace active: its remote cwd is never read from this disk', async () => {
    act(() => useStore.setState({ activeWorkspaceId: SHADOW }));
    act(() => root.render(createElement(FileTreePanel, { position: 'right' })));
    await flush();
    expect(remoteNote()).toBe("Files on office-mac aren't shown yet");
    expect(readDir).not.toHaveBeenCalled();
    expect(watch).not.toHaveBeenCalled();
  });
});
