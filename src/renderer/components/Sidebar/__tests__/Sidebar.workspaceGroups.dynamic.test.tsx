// @vitest-environment jsdom
// #3069 — user-defined workspace groups in the sidebar: grouped rows list under
// a collapsible header with a count, pinned and settled rows keep their own
// places, and the row and header menus file, rename and delete.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import Sidebar from '../Sidebar';
import { useStore } from '../../../stores';
import type { Pane, Workspace } from '../../../../shared/types';
import type { WorkspaceGroup } from '../../../../shared/workspaceGroups';
import type { WorkspaceSettleMap } from '../../../../shared/workspaceSettle';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function ws(id: string, groupId?: string): Workspace {
  const rootPane: Pane = {
    id: `${id}-p`, type: 'leaf', activeSurfaceId: `${id}-s`,
    surfaces: [{ id: `${id}-s`, ptyId: `pty-${id}`, title: '', shell: 'zsh', cwd: '/r', surfaceType: 'terminal' }],
  };
  return { id, name: id, rootPane, activePaneId: `${id}-p`, ...(groupId ? { groupId } : {}) };
}
function seed(opts: { groups: WorkspaceGroup[]; members?: Record<string, string>; pinned?: string[]; settle?: WorkspaceSettleMap }) {
  act(() => useStore.setState({
    workspaces: ['a', 'b', 'c', 'd'].map((id) => ws(id, opts.members?.[id])),
    workspaceGroups: opts.groups,
    workspaceGroupRenamingId: null,
    activeWorkspaceId: '',
    sidebarSortMode: 'manual',
    sidebarAttentionFirst: false,
    sidebarPinnedIds: opts.pinned ?? [],
    sidebarNewAt: {},
    missionByPaneGroup: {},
    fanoutLineage: {},
    fanoutSpawnOwner: {},
    workspaceSettle: { states: opts.settle ?? {}, idleDays: 3, hqWorkspaceId: null },
    workspaceSettleGroupsOpen: {},
  } as never));
}
const section = (id: string) => document.querySelector(`[data-workspace-group="${id}"]`) as HTMLElement | null;
const head = (id: string) => document.querySelector(`[data-workspace-group-head="${id}"]`) as HTMLButtonElement | null;
const rowsIn = (el: Element) => [...el.querySelectorAll('.sidebar-row')].map((r) => r.textContent?.match(/^[a-z]+/)?.[0]);
const topRows = () => [...document.querySelectorAll('.sidebar-row')]
  .filter((r) => !r.closest('[data-workspace-group]') && !r.closest('[data-workspace-settle-group]'))
  .map((r) => r.textContent?.match(/^[a-z]+/)?.[0]);
const row = (id: string) => [...document.querySelectorAll('.sidebar-row')].find((r) => r.textContent?.startsWith(id)) as HTMLElement;

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  const stub = (): unknown => new Proxy(() => Promise.resolve([]), { get: (_t, key) => (key === 'then' ? undefined : key === 'onChanged' ? () => () => undefined : stub()) });
  (window as unknown as { electronAPI: unknown }).electronAPI = new Proxy({} as Record<string, unknown>, {
    get: (t, key: string) => (key in t ? t[key] : stub()),
  });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
});

describe('Sidebar workspace groups', () => {
  it('lists grouped rows under their header, pinned rows first and the rest after', () => {
    seed({
      groups: [{ id: 'g1', name: 'Client A' }, { id: 'g2', name: 'Infra' }],
      members: { b: 'g1', d: 'g1', c: 'g2', a: 'g2' },
      pinned: ['a'],
    });
    act(() => root.render(<Sidebar />));
    // a is pinned: pinned wins over its group.
    expect(topRows()).toEqual(['a']);
    expect(rowsIn(section('g1')!)).toEqual(['b', 'd']);
    expect(rowsIn(section('g2')!)).toEqual(['c']);
    expect(head('g1')!.textContent).toContain('Client A');
    expect(head('g1')!.textContent).toContain('2');
    expect(head('g1')!.getAttribute('aria-expanded')).toBe('true');
  });

  it('a settled workspace goes to Settled, not to its group', () => {
    seed({ groups: [{ id: 'g1', name: 'Client A' }], members: { b: 'g1', c: 'g1' }, settle: { b: { settled: { at: 1, reason: 'manual' } } } });
    act(() => root.render(<Sidebar />));
    expect(rowsIn(section('g1')!)).toEqual(['c']);
    expect(document.querySelector('[data-workspace-settle-group="settled"]')).not.toBeNull();
  });

  it('collapses and expands from the header, and remembers it in the store', () => {
    seed({ groups: [{ id: 'g1', name: 'Client A' }], members: { b: 'g1' } });
    act(() => root.render(<Sidebar />));
    act(() => { head('g1')!.click(); });
    expect(head('g1')!.getAttribute('aria-expanded')).toBe('false');
    expect(rowsIn(section('g1')!)).toEqual([]);
    expect(useStore.getState().workspaceGroups[0].collapsed).toBe(true);
    act(() => { head('g1')!.click(); });
    expect(rowsIn(section('g1')!)).toEqual(['b']);
  });

  it('draws an empty group with no count', () => {
    seed({ groups: [{ id: 'g1', name: 'Empty' }] });
    act(() => root.render(<Sidebar />));
    expect(head('g1')!.textContent).toBe('Empty');
    expect(topRows()).toEqual(['a', 'b', 'c', 'd']);
  });

  it('the row menu files a workspace into an existing group and takes it out again', () => {
    seed({ groups: [{ id: 'g1', name: 'Client A' }] });
    act(() => root.render(<Sidebar />));
    const openMenu = (id: string) => act(() => {
      row(id).dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }));
    });
    openMenu('c');
    act(() => { (document.querySelector('[data-workspace-action="move-to-group"]') as HTMLButtonElement).click(); });
    act(() => { (document.querySelector('[data-workspace-group-option="g1"]') as HTMLButtonElement).click(); });
    expect(rowsIn(section('g1')!)).toEqual(['c']);

    openMenu('c');
    act(() => { (document.querySelector('[data-workspace-action="move-to-group"]') as HTMLButtonElement).click(); });
    act(() => { (document.querySelector('[data-workspace-group-option="none"]') as HTMLButtonElement).click(); });
    expect(rowsIn(section('g1')!)).toEqual([]);
    expect(topRows()).toContain('c');
  });

  it('"New group…" makes a group holding the row and opens its name field', () => {
    seed({ groups: [] });
    act(() => root.render(<Sidebar />));
    act(() => {
      row('b').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }));
    });
    act(() => { (document.querySelector('[data-workspace-action="move-to-group"]') as HTMLButtonElement).click(); });
    act(() => { (document.querySelector('[data-workspace-group-option="new"]') as HTMLButtonElement).click(); });
    const [group] = useStore.getState().workspaceGroups;
    expect(group.name).toBe('New group');
    expect(rowsIn(section(group.id)!)).toEqual(['b']);
    const input = document.querySelector('[data-workspace-group-input]') as HTMLInputElement;
    expect(input).not.toBeNull();
    // Typing a name and pressing Enter renames the group in place.
    act(() => {
      const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      setValue.call(input, 'Client B');
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    expect(useStore.getState().workspaceGroups[0].name).toBe('Client B');
    expect(document.querySelector('[data-workspace-group-input]')).toBeNull();
  });

  it('the header menu deletes a group after a confirm, its rows back in the list', () => {
    seed({ groups: [{ id: 'g1', name: 'Client A' }], members: { b: 'g1', c: 'g1' } });
    act(() => root.render(<Sidebar />));
    act(() => {
      head('g1')!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }));
    });
    act(() => { (document.querySelector('[data-workspace-group-action="delete"]') as HTMLButtonElement).click(); });
    // Not yet: the group holds rows, so the menu asks first.
    expect(section('g1')).not.toBeNull();
    act(() => { (document.querySelector('[data-testid="workspace-group-delete-confirm"]') as HTMLButtonElement).click(); });
    expect(section('g1')).toBeNull();
    expect(topRows()).toEqual(['a', 'b', 'c', 'd']);
    expect(useStore.getState().workspaces.map((w) => w.id)).toEqual(['a', 'b', 'c', 'd']);
  });
});
