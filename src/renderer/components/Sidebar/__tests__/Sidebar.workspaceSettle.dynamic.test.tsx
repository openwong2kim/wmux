// @vitest-environment jsdom
// Workspace settle / snooze in the sidebar: grouped rows leave the main list
// for collapsed Snoozed / Settled groups (pinned wins), the rail moves them to
// its end, and the row menu sends the verbs to main.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import Sidebar from '../Sidebar';
import MiniSidebar from '../MiniSidebar';
import { useStore } from '../../../stores';
import type { Pane, Workspace } from '../../../../shared/types';
import type { WorkspaceSettleMap } from '../../../../shared/workspaceSettle';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NOW = new Date(2026, 9, 4, 10, 0).getTime();
function ws(id: string): Workspace {
  const rootPane: Pane = {
    id: `${id}-p`, type: 'leaf', activeSurfaceId: `${id}-s`,
    surfaces: [{ id: `${id}-s`, ptyId: `pty-${id}`, title: '', shell: 'zsh', cwd: '/r', surfaceType: 'terminal' }],
  };
  return { id, name: id, rootPane, activePaneId: `${id}-p` };
}
function seed(states: WorkspaceSettleMap, pinned: string[] = []) {
  act(() => useStore.setState({
    workspaces: ['a', 'b', 'c', 'd'].map(ws),
    activeWorkspaceId: '',
    sidebarSortMode: 'manual',
    sidebarAttentionFirst: false,
    sidebarPinnedIds: pinned,
    sidebarNewAt: {},
    missionByPaneGroup: {},
    fanoutLineage: {},
    fanoutSpawnOwner: {},
    workspaceSettle: { states, idleDays: 3 },
    workspaceSettleGroupsOpen: {},
  } as never));
}
const mainRows = () => [...document.querySelectorAll('.sidebar-row')]
  .filter((r) => !r.closest('[data-workspace-settle-group]'))
  .map((r) => r.textContent?.match(/^[a-z]+/)?.[0]);
const group = (kind: string) => document.querySelector(`[data-workspace-settle-group="${kind}"]`) as HTMLElement | null;
const row = (id: string) => [...document.querySelectorAll('.sidebar-row')].find((r) => r.textContent?.startsWith(id)) as HTMLElement;

let container: HTMLDivElement;
let root: Root;
let command: ReturnType<typeof vi.fn>;
beforeEach(() => {
  vi.useFakeTimers({ now: NOW });
  command = vi.fn(async () => ({ ok: true, snapshot: useStore.getState().workspaceSettle }));
  const stub = (): unknown => new Proxy(() => Promise.resolve([]), { get: (_t, key) => (key === 'then' ? undefined : stub()) });
  (window as unknown as { electronAPI: unknown }).electronAPI = new Proxy({ platform: 'win32', workspaceSettle: { command } } as Record<string, unknown>, {
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

describe('Sidebar settle groups', () => {
  it('moves snoozed and settled rows into collapsed groups; pinned wins; an expired snooze stays', () => {
    seed({
      b: { settled: { at: 1, reason: 'idle' } },
      c: { snoozedUntil: NOW + 60_000 },
      d: { snoozedUntil: NOW - 1 },
      a: { settled: { at: 1, reason: 'manual' } },
    }, ['a']);
    act(() => root.render(<Sidebar />));
    expect(mainRows()).toEqual(['a', 'd']);

    const settled = group('settled')!;
    const header = settled.querySelector('button')!;
    expect(header.textContent).toContain('Settled (1)');
    expect(header.getAttribute('aria-expanded')).toBe('false');
    const list = document.getElementById(header.getAttribute('aria-controls')!)!;
    expect(list).not.toBeNull();
    expect(list.hidden).toBe(true);
    // Snoozed comes first.
    expect(group('snoozed')!.compareDocumentPosition(settled) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    act(() => { header.click(); });
    expect(header.getAttribute('aria-expanded')).toBe('true');
    expect(list.hidden).toBe(false);
    expect(list.textContent).toContain('b');
  });

  it('draws no group when nothing is grouped', () => {
    seed({});
    act(() => root.render(<Sidebar />));
    expect(group('settled')).toBeNull();
    expect(group('snoozed')).toBeNull();
  });

  it('moves grouped rows to the end of the compact rail', () => {
    seed({ a: { settled: { at: 1, reason: 'idle' } }, b: { snoozedUntil: NOW + 60_000 } });
    act(() => root.render(<MiniSidebar />));
    const titles = [...container.querySelectorAll('button[title]')].map((b) => b.getAttribute('title'))
      .filter((t) => /^[a-z0-9]+ \(Ctrl\+\d\)$/.test(t ?? ''));
    // Grouped rows keep their stored Ctrl+N number on the rail.
    expect(titles).toEqual(['c (Ctrl+3)', 'd (Ctrl+4)', 'a (Ctrl+1)', 'b (Ctrl+2)']);
  });
});

describe('Row menu verbs', () => {
  const action = (name: string) => document.querySelector(`[data-workspace-action="${name}"]`) as HTMLButtonElement | null;
  function openMenu(id: string) {
    act(() => { row(id).dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 })); });
  }

  it('settles an idle workspace and refuses up front for a pinned one', () => {
    seed({}, ['b']);
    act(() => root.render(<Sidebar />));
    openMenu('a');
    expect(action('settle')!.disabled).toBe(false);
    act(() => { action('settle')!.click(); });
    expect(command).toHaveBeenCalledWith({ op: 'settle', workspaceId: 'a' });
    openMenu('b');
    expect(action('settle')!.disabled).toBe(true);
    expect(action('snooze')).toBeNull();
  });

  it('offers Unsettle / Unsnooze for a grouped workspace', () => {
    seed({ c: { snoozedUntil: NOW + 60_000 }, b: { settled: { at: 1, reason: 'pr' } } });
    act(() => root.render(<Sidebar />));
    act(() => { group('snoozed')!.querySelector('button')!.click(); });
    act(() => { group('settled')!.querySelector('button')!.click(); });
    openMenu('c');
    act(() => { action('unsnooze')!.click(); });
    expect(command).toHaveBeenCalledWith({ op: 'unsnooze', workspaceId: 'c' });
    openMenu('b');
    expect(action('settle')).toBeNull();
    act(() => { action('unsettle')!.click(); });
    expect(command).toHaveBeenCalledWith({ op: 'unsettle', workspaceId: 'b' });
  });

  it('snoozes with a preset, sending its end time', () => {
    seed({});
    act(() => root.render(<Sidebar />));
    openMenu('a');
    act(() => { action('snooze')!.click(); });
    const presets = [...document.querySelectorAll('[data-snooze-preset]')].map((el) => el.getAttribute('data-snooze-preset'));
    expect(presets).toEqual(['1h', 'tonight', 'tomorrow', 'nextWeek']);
    act(() => { (document.querySelector('[data-snooze-preset="1h"]') as HTMLButtonElement).click(); });
    expect(command).toHaveBeenCalledWith({ op: 'snooze', workspaceId: 'a', until: NOW + 60 * 60 * 1000 });
  });
});
