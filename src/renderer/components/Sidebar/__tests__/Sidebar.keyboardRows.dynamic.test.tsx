// @vitest-environment jsdom
// Sidebar critique (2026-10-05): rows are a keyboard tree with one Tab stop,
// a needs-you row says its question, an error row says so and never sinks,
// the rail names each workspace with its status, and the order is one press
// away in the header.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import Sidebar from '../Sidebar';
import MiniSidebar from '../MiniSidebar';
import { useStore } from '../../../stores';
import type { AgentStatus, Pane, Workspace } from '../../../../shared/types';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NOW = 50_000_000;
function ws(id: string): Workspace {
  const rootPane: Pane = {
    id: `${id}-p`, type: 'leaf', activeSurfaceId: `${id}-s`,
    surfaces: [{ id: `${id}-s`, ptyId: `pty-${id}`, title: '', shell: 'zsh', cwd: '/r', surfaceType: 'terminal' }],
  };
  return { id, name: id, rootPane, activePaneId: `${id}-p`, metadata: { gitBranch: `feat/${id}` } };
}
/** `ago` minutes per workspace: the newest activity stamp. */
function seed(statuses: Record<string, AgentStatus>, opts: { active?: string; mode?: 'attention' | 'manual'; ago?: Record<string, number>; questions?: Record<string, string> } = {}) {
  const ids = Object.keys(statuses);
  act(() => useStore.setState({
    workspaces: ids.map(ws),
    activeWorkspaceId: opts.active ?? '',
    activeRemoteKey: null,
    sidebarSortMode: opts.mode ?? 'manual',
    sidebarPinnedIds: [],
    sidebarNewAt: {},
    surfaceAgent: Object.fromEntries(ids.map((id) => [`pty-${id}`, { name: 'Claude Code', status: statuses[id] }])),
    surfaceAgentStatus: Object.fromEntries(ids.filter((id) => !['running', 'idle'].includes(statuses[id])).map((id) => [`pty-${id}`, statuses[id]])),
    surfaceActivityAt: Object.fromEntries(ids.map((id) => [`pty-${id}`, NOW - (opts.ago?.[id] ?? 1) * 60_000])),
    surfaceTurnOpenAt: Object.fromEntries(ids.filter((id) => statuses[id] === 'running').map((id) => [`pty-${id}`, NOW])),
    surfacePendingQuestion: Object.fromEntries(Object.entries(opts.questions ?? {}).map(([id, q]) => [`pty-${id}`, q])),
    agentClockMs: NOW,
    missionByPaneGroup: {},
    fanoutLineage: {},
    fanoutSpawnOwner: {},
  } as never));
}
const rows = () => [...document.querySelectorAll<HTMLElement>('[data-sidebar-tree] [data-sidebar-row]')];
const rowOf = (id: string) => document.querySelector<HTMLElement>(`[data-sidebar-row="${id}"]`)!;
const key = (el: HTMLElement, k: string, init: KeyboardEventInit = {}) =>
  act(() => { el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init })); });

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.useFakeTimers({ now: NOW });
  const stub = (): unknown => new Proxy(() => Promise.resolve([]), { get: (_t, k) => (k === 'then' ? undefined : stub()) });
  (window as unknown as { electronAPI: unknown }).electronAPI = new Proxy({ platform: 'win32' } as Record<string, unknown>, {
    get: (t, k: string) => (k in t ? t[k] : stub()),
  });
  // jsdom lays nothing out; the list keeps rows that have a box.
  Element.prototype.getClientRects = function () { return [{}] as unknown as DOMRectList; };
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
});

describe('keyboard: workspace rows are a tree with one Tab stop', () => {
  it('makes the selected row the only Tab stop, with treeitem semantics', () => {
    seed({ a: 'idle', b: 'idle', c: 'idle' }, { active: 'b' });
    act(() => root.render(<Sidebar />));
    expect(container.querySelector('[role="tree"]')).not.toBeNull();
    expect(rows().map((r) => r.getAttribute('role'))).toEqual(['treeitem', 'treeitem', 'treeitem']);
    expect(rows().filter((r) => r.tabIndex === 0).map((r) => r.dataset.sidebarRow)).toEqual(['b']);
    expect(rowOf('b').getAttribute('aria-selected')).toBe('true');
  });

  it('moves with ↑ ↓ Home End, carries the Tab stop along, and opens with Enter', () => {
    seed({ a: 'idle', b: 'idle', c: 'idle' }, { active: 'a' });
    act(() => root.render(<Sidebar />));
    act(() => rowOf('a').focus());
    key(rowOf('a'), 'ArrowDown');
    expect(document.activeElement).toBe(rowOf('b'));
    expect(rowOf('b').tabIndex).toBe(0);
    expect(rowOf('a').tabIndex).toBe(-1);
    key(rowOf('b'), 'End');
    expect(document.activeElement).toBe(rowOf('c'));
    key(rowOf('c'), 'ArrowDown');
    expect(document.activeElement).toBe(rowOf('c'));
    key(rowOf('c'), 'Home');
    expect(document.activeElement).toBe(rowOf('a'));
    key(rowOf('a'), 'ArrowDown');
    key(rowOf('b'), 'Enter');
    expect(useStore.getState().activeWorkspaceId).toBe('b');
  });

  it('keeps row actions out of the Tab order until their row has focus', () => {
    seed({ a: 'idle', b: 'idle' }, { active: 'a' });
    act(() => root.render(<Sidebar />));
    const actionsOf = (id: string) => [...rowOf(id).querySelectorAll<HTMLButtonElement>('[data-workspace-action]')];
    expect(actionsOf('a').length).toBeGreaterThan(0);
    expect(actionsOf('a').every((b) => b.tabIndex === -1)).toBe(true);
    act(() => rowOf('a').focus());
    expect(actionsOf('a').every((b) => b.tabIndex === 0)).toBe(true);
    expect(actionsOf('b').every((b) => b.tabIndex === -1)).toBe(true);
  });

  it('opens the roster with → and folds it with ←', () => {
    seed({ a: 'running', b: 'idle' }, { active: 'b' });
    act(() => root.render(<Sidebar />));
    expect(rowOf('a').getAttribute('aria-expanded')).toBe('false');
    act(() => rowOf('a').focus());
    key(rowOf('a'), 'ArrowRight');
    expect(rowOf('a').getAttribute('aria-expanded')).toBe('true');
    key(rowOf('a'), 'ArrowLeft');
    expect(rowOf('a').getAttribute('aria-expanded')).toBe('false');
  });
});

describe('the question on the row', () => {
  it('shows a needs-you row\'s question (sanitized, one line) instead of its branch, and keeps the label', () => {
    seed({ a: 'awaiting_input', b: 'idle' }, { active: 'b', questions: { a: 'Keep the‮ legacy route,\n or remove it?' } });
    act(() => root.render(<Sidebar />));
    const q = rowOf('a').querySelector('[data-row-question]');
    expect(q?.textContent).toBe('Keep the legacy route, or remove it?');
    expect(rowOf('a').textContent).not.toContain('feat/a');
    expect(rowOf('b').textContent).toContain('feat/b');
    // The label is never a hover casualty.
    const label = rowOf('a').querySelector('[data-row-needs-you]') as HTMLElement;
    expect(label.className).not.toMatch(/group-hover:hidden/);
    expect(rowOf('a').getAttribute('aria-label')).toBe('a, Needs you, Keep the legacy route, or remove it?');
  });
});

describe('errors: their own tier', () => {
  it('says Error and sorts an old error above a fresh finish and idle rows', () => {
    seed({ fin: 'complete', idle: 'idle', err: 'error' }, { mode: 'attention', ago: { fin: 1, idle: 2, err: 300 } });
    act(() => root.render(<Sidebar />));
    expect(rows().map((r) => r.dataset.sidebarRow)).toEqual(['err', 'fin', 'idle']);
    expect(rowOf('err').querySelector('[data-row-error]')?.textContent).toBe('Error');
    expect(rowOf('err').querySelector('[data-row-needs-you]')).toBeNull();
  });
});

describe('header order control', () => {
  it('names the current order and switches it from the header', () => {
    seed({ a: 'idle', b: 'idle', c: 'idle' }, { mode: 'manual' });
    act(() => root.render(<Sidebar />));
    const button = container.querySelector<HTMLButtonElement>('[data-sidebar-sort-toggle]')!;
    expect(button.getAttribute('aria-label')).toBe('Order: Manual');
    act(() => button.click());
    const recent = container.querySelector<HTMLButtonElement>('[data-sort-option="recent"]')!;
    expect(container.querySelector('[data-sort-option="manual"]')?.getAttribute('aria-checked')).toBe('true');
    act(() => recent.click());
    expect(useStore.getState().sidebarSortMode).toBe('recent');
    expect(container.querySelector('[data-sidebar-sort-menu]')).toBeNull();
  });
});

describe('mini rail', () => {
  it('names each workspace with its status and draws the status by shape', () => {
    seed({ a: 'awaiting_input', b: 'error', c: 'idle' }, { questions: { a: 'Which one?' }, ago: { c: 10 } });
    act(() => root.render(<MiniSidebar />));
    const btn = (id: string) => container.querySelector<HTMLButtonElement>(`[data-rail-workspace="${id}"]`)!;
    expect(btn('a').getAttribute('aria-label')).toBe('a, Needs you');
    expect(btn('b').getAttribute('aria-label')).toBe('b, Error');
    expect(btn('c').getAttribute('aria-label')).toBe('c');
    expect(btn('a').querySelector('[data-status-mark]')?.getAttribute('data-status-mark')).toBe('ring');
    expect(btn('b').querySelector('[data-status-mark]')?.getAttribute('data-status-mark')).toBe('cross');
    // No text glyphs stand in for a status.
    expect(btn('a').textContent).not.toMatch(/[●✕○]/);
  });
});
