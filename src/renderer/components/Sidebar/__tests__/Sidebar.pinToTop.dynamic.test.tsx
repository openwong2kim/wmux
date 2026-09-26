// @vitest-environment jsdom
// Pinned to top (2026-09-26): the row menu offers Pin to top in every order,
// the pinned group leads the full sidebar and the rail in every order, and
// Ctrl+N follows the same pinned-first stored order.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import Sidebar from '../Sidebar';
import MiniSidebar from '../MiniSidebar';
import { useKeyboard } from '../../../hooks/useKeyboard';
import { useStore } from '../../../stores';
import type { AgentStatus, Pane, Workspace } from '../../../../shared/types';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NOW = 50_000_000;
function ws(id: string): Workspace {
  const rootPane: Pane = {
    id: `${id}-p`, type: 'leaf', activeSurfaceId: `${id}-s`,
    surfaces: [{ id: `${id}-s`, ptyId: `pty-${id}`, title: '', shell: 'zsh', cwd: '/r', surfaceType: 'terminal' }],
  };
  return { id, name: id, rootPane, activePaneId: `${id}-p` };
}
function seed(statuses: Record<string, AgentStatus>, mode: 'attention' | 'manual', pinned: string[] = []) {
  const ids = Object.keys(statuses);
  act(() => useStore.setState({
    workspaces: ids.map(ws),
    activeWorkspaceId: '',
    sidebarSortMode: mode,
    sidebarAttentionFirst: mode === 'attention',
    sidebarPinnedIds: pinned,
    sidebarNewAt: {},
    surfaceAgent: Object.fromEntries(ids.map((id) => [`pty-${id}`, { name: 'Claude Code', status: statuses[id] }])),
    surfaceAgentStatus: Object.fromEntries(ids.filter((id) => !['running', 'idle'].includes(statuses[id])).map((id) => [`pty-${id}`, statuses[id]])),
    surfaceActivityAt: Object.fromEntries(ids.filter((id) => statuses[id] !== 'idle').map((id) => [`pty-${id}`, NOW])),
    surfaceTurnOpenAt: Object.fromEntries(ids.filter((id) => statuses[id] === 'running').map((id) => [`pty-${id}`, NOW])),
    agentClockMs: NOW,
    missionByPaneGroup: {},
    fanoutLineage: {},
    fanoutSpawnOwner: {},
  } as never));
}
const shown = () => [...document.querySelectorAll('.sidebar-row')].map((r) => r.textContent?.match(/^[a-z]+/)?.[0]);
const row = (id: string) => [...document.querySelectorAll('.sidebar-row')].find((r) => r.textContent?.startsWith(id)) as HTMLElement;
const pinGlyphOn = (id: string) => row(id).querySelector('[data-sidebar-pinned]') !== null;
function openMenu(id: string) {
  act(() => { row(id).dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 })); });
  return document.querySelector('[data-workspace-action="pin"]') as HTMLButtonElement | null;
}

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.useFakeTimers({ now: NOW });
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
  vi.useRealTimers();
});

describe('Pin to top — row menu', () => {
  for (const mode of ['attention', 'manual'] as const) {
    it(`is offered in ${mode} mode and pins the row to the top at once`, () => {
      seed({ a: 'running', b: 'idle', c: 'idle' }, mode);
      act(() => root.render(<Sidebar />));
      // Pointer in the list: a status re-sort would wait, a pin must not.
      const list = container.querySelector('.wmux-sidebar .overflow-y-auto') as HTMLElement;
      act(() => { list.dispatchEvent(new MouseEvent('pointerover', { bubbles: true })); });
      const item = openMenu('c');
      expect(item?.textContent).toBe('Pin to top');
      act(() => { item!.click(); });
      expect(shown()[0]).toBe('c');
      expect(pinGlyphOn('c')).toBe(true);
      expect(useStore.getState().workspaces.map((w) => w.id)).toEqual(['c', 'a', 'b']);
      // And back: Unpin returns it to the top of the rest.
      const again = openMenu('c');
      expect(again?.textContent).toBe('Unpin');
      act(() => { again!.click(); });
      expect(pinGlyphOn('c')).toBe(false);
      expect(useStore.getState().sidebarPinnedIds).toEqual([]);
    });
  }
});

describe('Pin to top — order', () => {
  it('keeps the pinned group on top and unsorted in Attention; only the rest re-sorts', () => {
    // pb needs you but stays second in the group; x needs you and leads the rest.
    seed({ pa: 'idle', pb: 'awaiting_input', idle: 'idle', x: 'awaiting_input' }, 'attention', ['pa', 'pb']);
    act(() => root.render(<Sidebar />));
    expect(shown()).toEqual(['pa', 'pb', 'x', 'idle']);
    // Pinned rows show their Ctrl+N hint even in a sorted order: it matches.
    expect(row('pa').textContent).toContain('^1');
    expect(row('idle').textContent).not.toContain('^');
  });

  it('the rail shows the same pinned-first order, numbered as stored', () => {
    // `a` is running and would sort above the idle p2 without the group.
    seed({ p1: 'idle', p2: 'idle', a: 'running' }, 'attention', ['p1', 'p2']);
    act(() => root.render(<MiniSidebar />));
    const titles = [...container.querySelectorAll('button[title]')].map((b) => b.getAttribute('title')).filter((t) => /^[a-z0-9]+ \(Ctrl\+\d\)$/.test(t ?? ''));
    expect(titles).toEqual(['p1 (Ctrl+1)', 'p2 (Ctrl+2)', 'a (Ctrl+3)']);
  });

  it('Ctrl+1 jumps to the first pinned row (the displayed top)', () => {
    seed({ a: 'idle', b: 'idle', c: 'idle' }, 'manual');
    act(() => useStore.getState().toggleSidebarPin('c'));
    function Harness(): null { useKeyboard(); return null; }
    act(() => root.render(<><Sidebar /><Harness /></>));
    expect(shown()[0]).toBe('c');
    act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ctrlKey: true, key: '1', code: 'Digit1' })); });
    expect(useStore.getState().activeWorkspaceId).toBe('c');
  });
});

// A drop pins or unpins in Manual, so its source must be the row the user
// actually dragged: never dataTransfer text from outside, never a stale index.
function fireDrag(el: Element, type: string, text = ''): Event {
  const data: Record<string, string> = { 'text/plain': text };
  const e = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(e, 'dataTransfer', {
    value: { getData: (k: string) => data[k] ?? '', setData: (k: string, v: string) => { data[k] = v; }, dropEffect: 'none', effectAllowed: 'all' },
  });
  // Below the row's midpoint (jsdom rects are all zero).
  Object.defineProperty(e, 'clientY', { value: 1 });
  act(() => { el.dispatchEvent(e); });
  return e;
}
const railButton = (id: string) =>
  [...container.querySelectorAll('button[title]')].find((b) => b.getAttribute('title')?.startsWith(`${id} (`)) as HTMLElement;
const stored = () => useStore.getState().workspaces.map((w) => w.id);

describe('Pin to top — drag source', () => {
  it('the rail ignores text dragged in from outside (no drop target, no pin)', () => {
    seed({ a: 'idle', b: 'idle', c: 'idle' }, 'manual', ['a']);
    act(() => root.render(<MiniSidebar />));
    // "2 errors" used to parse as stored index 2 and pin `c` beside `a`.
    expect(fireDrag(railButton('a'), 'dragover', '2 errors').defaultPrevented).toBe(false);
    fireDrag(railButton('a'), 'drop', '2 errors');
    expect(stored()).toEqual(['a', 'b', 'c']);
    expect(useStore.getState().sidebarPinnedIds).toEqual(['a']);
  });

  it('a rail drag onto a pinned row still pins, resolved by id', () => {
    seed({ a: 'idle', b: 'idle', c: 'idle' }, 'manual', ['a']);
    act(() => root.render(<MiniSidebar />));
    fireDrag(railButton('c'), 'dragstart');
    expect(fireDrag(railButton('a'), 'dragover').defaultPrevented).toBe(true);
    fireDrag(railButton('a'), 'drop');
    expect(stored()).toEqual(['a', 'c', 'b']);
    expect(useStore.getState().sidebarPinnedIds).toEqual(['a', 'c']);
  });

  it('the full sidebar moves the dragged row even if another closed mid-drag', () => {
    document.elementFromPoint = () => null;
    seed({ p: 'idle', a: 'idle', b: 'idle', c: 'idle' }, 'manual', ['p']);
    act(() => root.render(<Sidebar />));
    fireDrag(row('b'), 'dragstart');
    // `a` closes mid-drag: `b`'s dragstart index now names `c`.
    act(() => useStore.setState({ workspaces: useStore.getState().workspaces.filter((w) => w.id !== 'a') }));
    fireDrag(row('p'), 'drop');
    expect(useStore.getState().sidebarPinnedIds).toEqual(['p', 'b']);
    expect(stored()).toEqual(['p', 'b', 'c']);
  });
});
