// @vitest-environment jsdom
// The collapsed rail follows the PC switcher: with a paired computer selected
// its avatars are that computer's workspaces (no new-workspace button), and
// This computer brings the local avatars back.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import MiniSidebar from '../MiniSidebar';
import { useStore } from '../../../stores';
import type { Workspace } from '../../../../shared/types';
import type { PcRailWorkspaceRow } from '../../../../shared/pcRail';

function local(id: string): Workspace {
  return {
    id, name: id, activePaneId: `${id}-p`,
    rootPane: { id: `${id}-p`, type: 'leaf', activeSurfaceId: `${id}-s`, surfaces: [{ id: `${id}-s`, ptyId: `pty-${id}`, title: '', shell: 'zsh', cwd: '/r' }] },
  };
}
const rows: PcRailWorkspaceRow[] = [
  { id: 'rw-a', name: 'api', order: 0, panes: [{ sessionId: 's-a' }] },
  { id: 'rw-b', name: 'beta', order: 1, panes: [{ sessionId: 's-b' }] },
];

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  const stub = (): unknown => new Proxy(() => Promise.resolve([]), { get: (_t, key) => (key === 'then' ? undefined : stub()) });
  (window as unknown as { electronAPI: unknown }).electronAPI = new Proxy({ platform: 'darwin' } as Record<string, unknown>, {
    get: (t, key: string) => (key in t ? t[key] : stub()),
  });
  act(() => useStore.setState((s) => ({
    workspaces: [local('one'), local('two')],
    activeWorkspaceId: 'one',
    pcRailHosts: [{ id: 'h1', label: 'office-mac' }],
    pcRailHostsLoaded: true,
    pcRailHostStatus: { h1: 'reachable' },
    pcRailFeeds: { h1: { workspaces: rows, fetchedAt: Date.now(), failedTicks: 0 } },
    pcRail: { ...s.pcRail, activePcId: 'h1' },
  })));
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  act(() => useStore.setState((s) => ({ pcRailHosts: [], pcRailFeeds: {}, pcRail: { ...s.pcRail, activePcId: 'local' } })));
});

describe('collapsed rail scoped to the selected computer', () => {
  it("lists the host's workspaces and opens one as a shadow", () => {
    act(() => root.render(<MiniSidebar rail collapsed />));
    const avatars = [...container.querySelectorAll<HTMLElement>('[data-host-rail-workspace]')];
    expect(avatars.map((a) => a.textContent)).toEqual(['A1', 'B2']);
    expect(container.querySelector('[data-rail-workspace]')).toBeNull();
    expect(container.querySelector('[data-mini-add-workspace]')).toBeNull();
    act(() => avatars[1].click());
    expect(useStore.getState().activeWorkspaceId).toBe('shadow:h1:rw-b');
  });

  it('shows the local avatars again for This computer', () => {
    act(() => useStore.setState((s) => ({ pcRail: { ...s.pcRail, activePcId: 'local' } })));
    act(() => root.render(<MiniSidebar rail collapsed />));
    expect(container.querySelector('[data-host-rail-workspace]')).toBeNull();
    expect(container.querySelectorAll('[data-rail-workspace]').length).toBe(2);
    expect(container.querySelector('[data-mini-add-workspace]')).not.toBeNull();
  });
});
