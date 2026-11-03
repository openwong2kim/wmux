// @vitest-environment jsdom
// The collapsed rail keeps the sidebar's filter: a facet (and the search
// text, both in the store) narrows its avatars the way it narrows the
// expanded list, and the Ctrl+N digits it shows are the ones the keyboard
// reaches (selectShortcutWorkspaces) in both states.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import MiniSidebar from '../MiniSidebar';
import { useStore } from '../../../stores';
import { EMPTY_FILTER, selectShortcutWorkspaces } from '../workspaceFilter';
import type { Workspace } from '../../../../shared/types';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function local(id: string): Workspace {
  return {
    id, name: id, activePaneId: `${id}-p`,
    rootPane: { id: `${id}-p`, type: 'leaf', activeSurfaceId: `${id}-s`, surfaces: [{ id: `${id}-s`, ptyId: `pty-${id}`, title: '', shell: 'zsh', cwd: '/r' }] },
  };
}

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  const stub = (): unknown => new Proxy(() => Promise.resolve([]), { get: (_t, key) => (key === 'then' ? undefined : key === 'onChanged' ? () => () => undefined : stub()) });
  (window as unknown as { electronAPI: unknown }).electronAPI = new Proxy({ platform: 'darwin' } as Record<string, unknown>, {
    get: (t, key: string) => (key in t ? t[key] : stub()),
  });
  act(() => useStore.setState((s) => ({
    workspaces: ['a', 'b', 'c', 'd'].map(local),
    activeWorkspaceId: 'a',
    activeRemoteKey: null,
    sidebarSortMode: 'manual',
    sidebarPinnedIds: [],
    sidebarBookmarkedIds: ['d', 'b'],
    sidebarFilter: EMPTY_FILTER,
    sidebarSearch: '',
    sidebarVisible: false,
    pcRail: { ...s.pcRail, activePcId: 'local' },
  })));
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  act(() => useStore.setState({ sidebarFilter: EMPTY_FILTER, sidebarSearch: '', sidebarBookmarkedIds: [], sidebarVisible: true }));
});

const avatars = () => [...container.querySelectorAll<HTMLElement>('[data-rail-workspace]')];
const ids = () => avatars().map((a) => a.getAttribute('data-rail-workspace'));

describe('collapsed rail under the sidebar filter', () => {
  it('lists only the workspaces a facet keeps, and all of them again once it is cleared', () => {
    act(() => useStore.setState({ sidebarFilter: { ...EMPTY_FILTER, bookmarked: true } }));
    act(() => root.render(<MiniSidebar rail collapsed />));
    // Stored order, not bookmark order; the hidden active workspace is not listed.
    expect(ids()).toEqual(['b', 'd']);
    expect(avatars().map((a) => a.textContent)).toEqual(['B1', 'D2']);
    act(() => useStore.setState({ sidebarFilter: EMPTY_FILTER }));
    expect(ids()).toEqual(['a', 'b', 'c', 'd']);
  });

  it('numbers the rows the Ctrl+N digits reach, collapsed and expanded alike', () => {
    act(() => useStore.setState({ sidebarFilter: { ...EMPTY_FILTER, bookmarked: true }, sidebarSearch: 'd' }));
    act(() => root.render(<MiniSidebar rail collapsed />));
    expect(ids()).toEqual(['d']);
    expect(avatars()[0].getAttribute('title')).toContain('(Ctrl+1)');
    expect(selectShortcutWorkspaces(useStore.getState()).map((w) => w.id)).toEqual(['d']);
    // Expanding (the real toggle) neither clears the filter nor moves the digits.
    act(() => useStore.getState().toggleSidebar());
    expect(useStore.getState().sidebarVisible).toBe(true);
    expect(useStore.getState().sidebarFilter.bookmarked).toBe(true);
    expect(selectShortcutWorkspaces(useStore.getState()).map((w) => w.id)).toEqual(['d']);
  });
});
