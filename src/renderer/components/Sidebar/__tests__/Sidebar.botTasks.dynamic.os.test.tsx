// @vitest-environment jsdom
// 2026-10-13 — a bot's fan-out workers live on the Bots page: the
// Workspaces sidebar leaves them out of the task groups and the header count,
// the collapsed rail and the Ctrl+N digits too. Human / GUI / orchestrator
// tasks are unchanged. The worker the owner is in is not listed either
// (2026-10-14: a bot's worker opens inside the Bots page).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import Sidebar from '../Sidebar';
import { useStore } from '../../../stores';
import { selectShortcutWorkspaces } from '../workspaceFilter';
import { botTaskOwners, isBotTask, ownerFleetState, selectOwnerWorkspaces, withoutBotTasks } from '../botTasks';
import type { Pane, Surface, Workspace } from '../../../../shared/types';
import type { FanoutOrigin } from '../../../../shared/fanoutOrigin';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const BOT = 'bot-0000000a';
const surface = (id: string, ptyId: string): Surface => ({ id, ptyId, title: '', shell: 'zsh', cwd: '/r', surfaceType: 'terminal' });
const leaf = (id: string, s: Surface): Pane => ({ id, type: 'leaf', ordinal: 1, surfaces: [s], activeSurfaceId: s.id }) as Pane;
const ws = (id: string, name: string): Workspace =>
  ({ id, name, wsOrdinal: 1, rootPane: leaf(`${id}-p`, surface(`${id}-s`, `pty-${id}`)), activePaneId: `${id}-p` }) as Workspace;
const HQ = ws('hq', 'Workspace 1');
const OTHER = ws('bee', 'bee');
const HUMAN = ws('t1', 'wtask: alpha');
const GUI = ws('t2', 'wtask: gamma');
const BOTW = ws('t3', 'wtask: beta');

const origins = (): Record<string, FanoutOrigin> => ({
  t1: { kind: 'pane', paneId: 'hq-p', surfaceId: 'hq-s', label: 'w1-1 · Claude Code' },
  t2: { kind: 'gui' },
  t3: { kind: 'bot', botId: BOT },
});

function seed(active = 'hq') {
  act(() => useStore.setState({
    workspaces: [HQ, OTHER, HUMAN, GUI, BOTW],
    activeWorkspaceId: active,
    activeRemoteKey: null,
    sidebarVisible: true,
    sidebarSearch: '',
    sidebarSortMode: 'manual',
    sidebarPinnedIds: [],
    sidebarNewAt: {},
    sidebarTaskGroupExpanded: {},
    missionByPaneGroup: {},
    fanoutLineage: { t1: 'hq', t2: 'hq', t3: 'hq' },
    fanoutSpawnOwner: {},
    fanoutProvenance: {},
    fanoutRefreshSettled: true,
    fanoutOrigin: origins(),
  } as never));
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

const text = () => container.textContent ?? '';
const total = () => container.querySelector('[data-sidebar-total]')?.textContent;

describe('bot workers leave the Workspaces sidebar', () => {
  it('drops bot-origin tasks from the task groups and the header count; other tasks stay', () => {
    seed();
    act(() => root.render(<Sidebar />));
    expect(text()).toContain('alpha');
    expect(text()).toContain('gamma');
    expect(text()).not.toContain('beta');
    // hq, bee and the two human/GUI tasks: the bot worker is not counted.
    expect(total()).toBe('4');
  });

  it('a bot worker the owner is in is not listed either', () => {
    seed('t3');
    act(() => root.render(<Sidebar />));
    expect(text()).not.toContain('beta');
    expect(total()).toBe('4');
  });

  it('the Ctrl+N digits skip bot workers, the active one too', () => {
    seed();
    expect(selectShortcutWorkspaces(useStore.getState()).map((w) => w.id)).toEqual(['hq', 'bee', 't1', 't2']);
    seed('t3');
    expect(selectShortcutWorkspaces(useStore.getState()).map((w) => w.id)).toEqual(['hq', 'bee', 't1', 't2']);
  });
});

describe('botTasks helpers', () => {
  const list = [{ id: 'hq' }, { id: 't3' }, { id: 't1' }, { id: 't2' }];

  it('a task is a bot\'s by its bot origin, open workspaces only', () => {
    const owners = botTaskOwners(list, { ...origins(), gone: { kind: 'bot', botId: BOT } });
    expect(owners).toEqual({ t3: BOT });
    expect(isBotTask('t3', owners)).toBe(true);
    expect(isBotTask('t2', owners)).toBe(false);
    expect(isBotTask('t1', owners)).toBe(false);
    expect(isBotTask(undefined, owners)).toBe(false);
    // The same answer is the same object (a subscriber does not re-render).
    expect(botTaskOwners([...list], { ...origins() })).toBe(owners);
  });

  it('withoutBotTasks keeps every other row in place, and the same array when nothing leaves', () => {
    const owners = botTaskOwners(list, origins());
    expect(withoutBotTasks(list, owners).map((w) => w.id)).toEqual(['hq', 't1', 't2']);
    const plain = [{ id: 'hq' }, { id: 't1' }];
    expect(withoutBotTasks(plain, owners)).toBe(plain);
    expect(withoutBotTasks(list, botTaskOwners([{ id: 'hq' }], {}))).toBe(list);
  });

  it('selectOwnerWorkspaces is the store\'s own array with no bot worker, and a stable filtered one with', () => {
    const plain = [HQ, OTHER];
    expect(selectOwnerWorkspaces({ workspaces: plain, fanoutOrigin: {} })).toBe(plain);
    const all = [HQ, OTHER, BOTW];
    const o = origins();
    const first = selectOwnerWorkspaces({ workspaces: all, fanoutOrigin: o });
    expect(first.map((w) => w.id)).toEqual(['hq', 'bee']);
    expect(selectOwnerWorkspaces({ workspaces: all, fanoutOrigin: o })).toBe(first);
    // Fleet's counts read the store itself while there is no bot worker.
    const plainState = { workspaces: plain, fanoutOrigin: {}, other: 1 };
    expect(ownerFleetState(plainState)).toBe(plainState);
    expect(ownerFleetState({ workspaces: all, fanoutOrigin: o, other: 1 })).toEqual({ workspaces: first, fanoutOrigin: o, other: 1 });
  });
});
