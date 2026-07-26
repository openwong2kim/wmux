// @vitest-environment jsdom
//
// The popover used to carry TWO working directories: `fsCwd` (from the derived
// SessionLocation) for `fs.readDir`, and a separately-walked `cwd` for
// `git.status`. Nothing reconciled them, so a WSL pane could list one
// directory's files and badge another directory's git status. Both reads now
// address the same location.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { SessionData, Workspace } from '../../../../shared/types';
import { useStore } from '../../../stores';
import FileExplorerPopover from '../FileExplorerPopover';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// The component reads `window.electronAPI` lazily inside its effect, so
// installing the bridge at module scope is enough.
const readDir = vi.fn(async () => [] as unknown[]);
const status = vi.fn(async () => '');

(window as unknown as { electronAPI: unknown }).electronAPI = {
  fs: { readDir },
  git: { status },
};

/** A workspace whose active surface is a WSL terminal, with a host-shaped
 *  `metadata.cwd` that disagrees with it — the disagreement the second cwd
 *  used to leak into `git.status`. */
function wslWorkspace(): Workspace {
  return {
    id: 'ws-1',
    name: 'Alpha',
    metadata: { cwd: 'C:\\dev\\mirror' },
    rootPane: {
      id: 'pane-1',
      type: 'leaf',
      surfaces: [{
        id: 'surf-1',
        ptyId: 'pty-1',
        title: 'term',
        shell: 'wsl.exe',
        cwd: '/home/me/proj',
        location: { domain: 'wsl', cwd: '/home/me/proj', shell: 'wsl.exe', distro: 'Ubuntu' },
      }],
      activeSurfaceId: 'surf-1',
    },
    activePaneId: 'pane-1',
  } as unknown as Workspace;
}

let container: HTMLDivElement;
let root: Root;

beforeEach(async () => {
  readDir.mockClear();
  status.mockClear();
  const data: SessionData = {
    workspaces: [wslWorkspace()],
    activeWorkspaceId: 'ws-1',
    sidebarVisible: true,
  } as SessionData;
  act(() => { useStore.getState().loadSession(data); });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('FileExplorerPopover — one location for both reads', () => {
  it('addresses git.status with the same location fs.readDir gets', async () => {
    await act(async () => { root.render(createElement(FileExplorerPopover)); });

    const expected = {
      domain: 'wsl',
      cwd: '/home/me/proj',
      shell: 'wsl.exe',
      distro: 'Ubuntu',
    };
    expect(readDir).toHaveBeenCalledWith('/home/me/proj', expected);
    expect(status).toHaveBeenCalledTimes(1);
    expect(status).toHaveBeenCalledWith(expected);
  });
});
