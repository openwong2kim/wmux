// @vitest-environment jsdom
// A workspace row's hover cluster drops the "Open in File Explorer" and
// "Copy session info" buttons when their sidebar settings are off; the close
// button always stays.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import Sidebar from '../Sidebar';
import { useStore } from '../../../stores';
import { EMPTY_FILTER } from '../workspaceFilter';
import type { Pane, Workspace } from '../../../../shared/types';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function ws(id: string): Workspace {
  const rootPane: Pane = {
    id: `${id}-p`, type: 'leaf', activeSurfaceId: `${id}-s`,
    surfaces: [{ id: `${id}-s`, ptyId: `pty-${id}`, title: '', shell: 'zsh', cwd: '/r', surfaceType: 'terminal' }],
  };
  return { id, name: id, rootPane, activePaneId: `${id}-p` };
}
function seed(explorer: boolean, copyInfo: boolean) {
  act(() => useStore.setState({
    workspaces: [ws('a')],
    activeWorkspaceId: 'a',
    activeRemoteKey: null,
    sidebarSortMode: 'manual',
    sidebarPinnedIds: [],
    sidebarBookmarkedIds: [],
    sidebarNewAt: {},
    sidebarFilter: EMPTY_FILTER,
    sidebarSearch: '',
    sidebarVisible: true,
    sidebarShowExplorerButton: explorer,
    sidebarShowCopyInfoButton: copyInfo,
    surfaceAgent: {}, surfaceAgentStatus: {}, surfaceTurnOpenAt: {}, surfaceActivityAt: {},
    agentClockMs: Date.now(),
    missionByPaneGroup: {}, fanoutLineage: {}, fanoutSpawnOwner: {},
    remoteWorkspaces: [],
  } as never));
}
const action = (name: string) => document.querySelector(`[data-workspace-action="${name}"]`);

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  const stub = (): unknown => new Proxy(() => Promise.resolve([]), { get: (_t, key) => (key === 'then' ? undefined : stub()) });
  (window as unknown as { electronAPI: unknown }).electronAPI = new Proxy({ platform: 'win32' } as Record<string, unknown>, {
    get: (t, key: string) => (key in t ? t[key] : stub()),
  });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('workspace row buttons', () => {
  it('shows both buttons by default', () => {
    seed(true, true);
    act(() => root.render(<Sidebar />));
    expect(action('explorer')).not.toBeNull();
    expect(action('copy-info')).not.toBeNull();
    expect(action('close')).not.toBeNull();
  });

  it('hides each button on its own setting, keeping close', () => {
    seed(false, true);
    act(() => root.render(<Sidebar />));
    expect(action('explorer')).toBeNull();
    expect(action('copy-info')).not.toBeNull();
    act(() => useStore.setState({ sidebarShowExplorerButton: true, sidebarShowCopyInfoButton: false } as never));
    expect(action('explorer')).not.toBeNull();
    expect(action('copy-info')).toBeNull();
    expect(action('close')).not.toBeNull();
  });
});
