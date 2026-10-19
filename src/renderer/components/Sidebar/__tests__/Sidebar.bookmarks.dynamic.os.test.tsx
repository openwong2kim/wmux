// @vitest-environment jsdom
// Workspace bookmarks: the row menu bookmarks a workspace without moving it
// and marks the row with a neutral glyph; the filter's "Bookmarked only"
// narrows the list and Ctrl+N numbers its rows 1, 2, …; a hidden
// selection is called out like under any filter; with nothing bookmarked the
// empty list says how to bookmark.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import Sidebar from '../Sidebar';
import { useStore } from '../../../stores';
import { EMPTY_FILTER, selectShortcutWorkspaces } from '../workspaceFilter';
import type { Pane, Workspace } from '../../../../shared/types';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function ws(id: string): Workspace {
  const rootPane: Pane = {
    id: `${id}-p`, type: 'leaf', activeSurfaceId: `${id}-s`,
    surfaces: [{ id: `${id}-s`, ptyId: `pty-${id}`, title: '', shell: 'zsh', cwd: '/r', surfaceType: 'terminal' }],
  };
  return { id, name: id, rootPane, activePaneId: `${id}-p` };
}
function seed(ids: string[], active: string, bookmarked: string[] = []) {
  act(() => useStore.setState({
    workspaces: ids.map(ws),
    activeWorkspaceId: active,
    activeRemoteKey: null,
    sidebarSortMode: 'manual',
    sidebarPinnedIds: [],
    sidebarBookmarkedIds: bookmarked,
    sidebarNewAt: {},
    sidebarFilter: EMPTY_FILTER,
    sidebarSearch: '',
    sidebarVisible: true,
    surfaceAgent: {}, surfaceAgentStatus: {}, surfaceTurnOpenAt: {}, surfaceActivityAt: {},
    agentClockMs: Date.now(),
    missionByPaneGroup: {}, fanoutLineage: {}, fanoutSpawnOwner: {},
    remoteWorkspaces: [],
  } as never));
}
const rows = () => [...document.querySelectorAll('.sidebar-row')].map((r) => r.textContent?.match(/^[a-z]+/)?.[0]);
const row = (id: string) => [...document.querySelectorAll('.sidebar-row')].find((r) => r.textContent?.startsWith(id)) as HTMLElement;
const q = <T extends Element>(sel: string) => document.querySelector<T>(sel);
const glyphOn = (id: string) => row(id).querySelector('[data-sidebar-bookmarked]') !== null;
function openMenu(id: string) {
  act(() => { row(id).dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 })); });
  return q<HTMLButtonElement>('[data-workspace-action="bookmark"]');
}

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

describe('Workspace bookmarks', () => {
  it('bookmarks from the row menu without moving the row, and takes it back', () => {
    seed(['a', 'b', 'c'], 'a');
    act(() => root.render(<Sidebar />));
    const item = openMenu('c');
    expect(item?.textContent).toBe('Bookmark');
    act(() => { item!.click(); });
    expect(useStore.getState().sidebarBookmarkedIds).toEqual(['c']);
    expect(rows()).toEqual(['a', 'b', 'c']);
    expect(useStore.getState().workspaces.map((w) => w.id)).toEqual(['a', 'b', 'c']);
    expect(glyphOn('c')).toBe(true);
    expect(glyphOn('a')).toBe(false);
    const again = openMenu('c');
    expect(again?.textContent).toBe('Remove bookmark');
    act(() => { again!.click(); });
    expect(useStore.getState().sidebarBookmarkedIds).toEqual([]);
    expect(glyphOn('c')).toBe(false);
  });

  it('"Bookmarked only" narrows the list; Ctrl+N numbers the rows it keeps', () => {
    seed(['a', 'b', 'c', 'd'], 'c', ['d', 'b']);
    act(() => root.render(<Sidebar />));
    act(() => q<HTMLButtonElement>('[data-sidebar-search-toggle]')!.click());
    act(() => q<HTMLButtonElement>('[data-filter-option="sidebar.filter.bookmarked"]')!.click());
    expect(useStore.getState().sidebarFilter.bookmarked).toBe(true);
    // Stored order, not bookmark order.
    expect(rows()).toEqual(['b', 'd']);
    expect(q('[data-sidebar-total-compact]')!.textContent).toBe('2/4');
    const digit = (id: string) => row(id).querySelector('[data-shortcut-number]')?.getAttribute('data-shortcut-number');
    expect(digit('b')).toBe('1');
    expect(digit('d')).toBe('2');
    // Ctrl+N reaches the same rows the sidebar numbers.
    expect(selectShortcutWorkspaces(useStore.getState()).map((w) => w.id)).toEqual(['b', 'd']);
    // The selected workspace is not bookmarked: called out, still selected.
    expect(q('[data-ws-filter-hidden-active]')).not.toBeNull();
    expect(useStore.getState().activeWorkspaceId).toBe('c');
    // Its chip removes the check.
    act(() => { q('[data-ws-filter-search]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
    act(() => q<HTMLButtonElement>('[data-ws-filter-chip="sidebar.filter.bookmarked"] button')!.click());
    expect(rows()).toEqual(['a', 'b', 'c', 'd']);
  });

  it('with nothing bookmarked, the empty list says how to bookmark', () => {
    seed(['a', 'b', 'c'], 'a');
    act(() => useStore.setState({ sidebarFilter: { ...EMPTY_FILTER, bookmarked: true } }));
    act(() => root.render(<Sidebar />));
    expect(rows()).toEqual([]);
    const empty = q('[data-ws-filter-empty]')!.textContent;
    expect(empty).toContain('No bookmarked workspaces yet');
    expect(empty).not.toContain('No workspaces match');
  });
});

describe('Ctrl+N under a narrowed sidebar', () => {
  it('search text numbers the matching rows too', () => {
    seed(['alpha', 'beta', 'gamma'], 'alpha');
    act(() => useStore.setState({ sidebarSearch: 'a', sidebarVisible: true } as never));
    expect(selectShortcutWorkspaces(useStore.getState()).map((w) => w.id)).toEqual(['alpha', 'beta', 'gamma']);
    act(() => useStore.setState({ sidebarSearch: 'gam' } as never));
    expect(selectShortcutWorkspaces(useStore.getState()).map((w) => w.id)).toEqual(['gamma']);
  });

  it('the collapsed rail lists every workspace, so the digits reach all of them', () => {
    seed(['a', 'b', 'c'], 'a', ['c']);
    act(() => useStore.setState({ sidebarFilter: { ...EMPTY_FILTER, bookmarked: true }, sidebarVisible: false } as never));
    expect(selectShortcutWorkspaces(useStore.getState()).map((w) => w.id)).toEqual(['a', 'b', 'c']);
    act(() => useStore.setState({ sidebarVisible: true } as never));
    expect(selectShortcutWorkspaces(useStore.getState()).map((w) => w.id)).toEqual(['c']);
  });
});
