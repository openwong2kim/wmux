/**
 * PC rail, PR4 — shadow workspaces.
 *
 * A shadow is another computer's workspace projected into `state.workspaces`.
 * The properties pinned here are the ones that keep it from leaking into this
 * computer: every id is namespaced, a host's ids can never alias local ones,
 * nothing local is created inside it, closing it closes nothing on the host,
 * and it never reaches session.json.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useStore } from '../index';
import {
  buildShadowWorkspace,
  findRemoteSurface,
  isShadowWorkspace,
  reconcileShadowWorkspace,
  shadowsToEvict,
  withoutShadowWorkspaces,
  type ShadowCopy,
} from '../shadowWorkspace';
import type { Pane, PaneLeaf, SessionData, Workspace } from '../../../shared/types';
import type { PcRailWorkspaceRow } from '../../../shared/pcRail';
import { getWorkspaceRemoteSessions } from '../../../shared/paneUtils';

const COPY: ShadowCopy = {
  browserNotShown: 'Browser on office-mac — not shown',
  openElsewhere: (ws) => `Open in ${ws}`,
  terminal: 'Terminal',
};
const none = () => null;

function leaves(p: Pane, out: PaneLeaf[] = []): PaneLeaf[] {
  if (p.type === 'leaf') out.push(p);
  else p.children.forEach((c) => leaves(c, out));
  return out;
}
const allIds = (p: Pane): string[] => (p.type === 'leaf' ? [p.id, ...p.surfaces.map((s) => s.id)] : [p.id, ...p.children.flatMap(allIds)]);

function row(over: Partial<PcRailWorkspaceRow> = {}): PcRailWorkspaceRow {
  return {
    id: 'rw1',
    name: 'api',
    panes: [{ sessionId: 's1', shell: 'zsh', cwd: '/srv' }, { sessionId: 's2' }],
    ...over,
  };
}

const splitLayout: PcRailWorkspaceRow['layout'] = {
  root: {
    kind: 'split', direction: 'horizontal', sizes: [50, 50], children: [
      { kind: 'leaf', paneId: 'p1', surfaces: [{ surfaceId: 'a', kind: 'terminal', ptyId: 's1' }], activeIndex: 0 },
      { kind: 'leaf', paneId: 'p2', surfaces: [{ surfaceId: 'b', kind: 'terminal', ptyId: 's2' }, { surfaceId: 'c', kind: 'browser', title: 'docs' }], activeIndex: 1 },
    ],
  },
  activePaneId: 'p2',
  unplaced: [],
};

describe('buildShadowWorkspace', () => {
  it('builds the host split tree with non-owned remote tabs and a placeholder for a browser', () => {
    const ws = buildShadowWorkspace('h1', row({ layout: splitLayout }), COPY, none)!;
    expect(ws.id).toBe('shadow:h1:rw1');
    expect(isShadowWorkspace(ws)).toBe(true);
    expect(ws.rootPane.type).toBe('branch');
    const [l1, l2] = leaves(ws.rootPane);
    expect(l1.surfaces[0]).toMatchObject({ surfaceType: 'remote-terminal', remoteHostId: 'h1', remoteSessionId: 's1', remoteWorkspaceId: 'rw1', ptyId: '' });
    expect(l1.surfaces[0].remoteOwned).toBeUndefined();
    expect(l2.surfaces[1]).toMatchObject({ surfaceType: 'placeholder', title: 'Browser on office-mac — not shown' });
    expect(l2.activeSurfaceId).toBe(l2.surfaces[1].id);
    expect(ws.activePaneId).toBe(l2.id);
    // Nothing the tree holds can close a session on the host.
    expect(getWorkspaceRemoteSessions(ws)).toEqual([]);
  });

  it('namespaces every pane, split and tab id, so host ids that equal local ones never alias', () => {
    const local = ['pane-1', 'surface-1', 'ws-local'];
    const hostile = row({
      id: 'ws-local',
      layout: {
        root: { kind: 'leaf', paneId: 'pane-1', surfaces: [{ surfaceId: 'surface-1', kind: 'terminal', ptyId: 's1' }] },
        unplaced: ['s2'],
      },
    });
    const ws = buildShadowWorkspace('h1', hostile, COPY, none)!;
    expect(ws.id).toBe('shadow:h1:ws-local');
    for (const id of allIds(ws.rootPane)) {
      expect(id.startsWith('shadow:h1:ws-local#')).toBe(true);
      expect(local).not.toContain(id);
    }
    // The same remote id on two hosts gives two shadows.
    expect(buildShadowWorkspace('h2', hostile, COPY, none)!.id).toBe('shadow:h2:ws-local');
  });

  it('falls back to one leaf with one tab per pane when the host sends no layout and no name (locked desktop)', () => {
    const ws = buildShadowWorkspace('h1', row({ name: '' }), COPY, none)!;
    expect(ws.name).toBe('rw1');
    expect(ws.rootPane.type).toBe('leaf');
    const leaf = ws.rootPane as PaneLeaf;
    expect(leaf.surfaces.map((s) => s.remoteSessionId)).toEqual(['s1', 's2']);
    expect(leaf.activeSurfaceId).toBe(leaf.surfaces[0].id);
  });

  it('adds unplaced sessions to the first leaf', () => {
    const ws = buildShadowWorkspace('h1', row({
      layout: { root: { kind: 'leaf', paneId: 'p1', surfaces: [{ surfaceId: 'a', kind: 'terminal', ptyId: 's1' }] }, unplaced: ['s2'] },
    }), COPY, none)!;
    expect((ws.rootPane as PaneLeaf).surfaces.map((s) => s.remoteSessionId)).toEqual(['s1', 's2']);
  });

  it('shows a session already open elsewhere as an "Open in" placeholder, never a second viewer', () => {
    const ws = buildShadowWorkspace('h1', row(), COPY, (id) => (id === 's2' ? 'Mine' : null))!;
    const tabs = (ws.rootPane as PaneLeaf).surfaces;
    expect(tabs[1]).toMatchObject({ surfaceType: 'placeholder', title: 'Open in Mine' });
    expect(tabs.filter((s) => s.surfaceType === 'remote-terminal')).toHaveLength(1);
  });

  it('builds nothing for an empty row or a host id that cannot form a shadow id', () => {
    expect(buildShadowWorkspace('h1', row({ panes: [], empty: true }), COPY, none)).toBeNull();
    expect(buildShadowWorkspace('bad:id', row(), COPY, none)).toBeNull();
  });
});

describe('reconcileShadowWorkspace', () => {
  const base = () => buildShadowWorkspace('h1', row({ layout: splitLayout }), COPY, none)!;

  it('removes a tab whose session the host no longer lists and collapses its leaf', () => {
    const next = reconcileShadowWorkspace(base(), 'h1', row({ panes: [{ sessionId: 's1' }] }));
    expect(next.kind).toBe('update');
    if (next.kind !== 'update') return;
    // p2 keeps its browser placeholder; only the gone session's tab is removed.
    const tabs = leaves(next.rootPane).flatMap((l) => l.surfaces.map((s) => s.remoteSessionId ?? s.surfaceType));
    expect(tabs).toEqual(['s1', 'placeholder']);
  });

  it('adds a newly listed session as a tab, and is unchanged when nothing moved', () => {
    const ws = base();
    expect(reconcileShadowWorkspace(ws, 'h1', row({ layout: splitLayout })).kind).toBe('unchanged');
    const next = reconcileShadowWorkspace(ws, 'h1', row({ panes: [...row().panes, { sessionId: 's3' }] }));
    expect(next.kind).toBe('update');
    if (next.kind === 'update') expect(leaves(next.rootPane)[0].surfaces.map((s) => s.remoteSessionId)).toEqual(['s1', 's3']);
  });

  it('closes the shadow when its row is gone or its last session went', () => {
    expect(reconcileShadowWorkspace(base(), 'h1', null).kind).toBe('close');
    expect(reconcileShadowWorkspace(base(), 'h1', row({ panes: [{ sessionId: 'other' }] })).kind).toBe('update');
    const flat = buildShadowWorkspace('h1', row({ panes: [{ sessionId: 's1' }] }), COPY, none)!;
    expect(reconcileShadowWorkspace(flat, 'h1', row({ panes: [], empty: true })).kind).toBe('close');
  });

  it('folds an empty leaf left by a local split', () => {
    const ws = base();
    const withEmpty: Workspace = {
      ...ws,
      rootPane: { id: 'x', type: 'branch', direction: 'vertical', children: [ws.rootPane, { id: 'e', type: 'leaf', surfaces: [], activeSurfaceId: '' }] },
    };
    const next = reconcileShadowWorkspace(withEmpty, 'h1', row({ layout: splitLayout }));
    expect(next.kind).toBe('update');
    if (next.kind === 'update') expect(leaves(next.rootPane).every((l) => l.surfaces.length > 0)).toBe(true);
  });
});

describe('shadowsToEvict', () => {
  it('closes the least recently used shadows past the limit, never the active one', () => {
    expect(shadowsToEvict(['a', 'b', 'c'], 'a', {})).toEqual([]);
    expect(shadowsToEvict(['a', 'b', 'c', 'd'], 'a', { a: 1, b: 5, c: 3, d: 4 })).toEqual(['c']);
    expect(shadowsToEvict(['a', 'b', 'c', 'd', 'e'], 'b', { b: 0 })).toEqual(['a', 'c']);
  });
});

// ── Store: open, exclusions, close, persistence ──────────────────────────────

function local(id: string): Workspace {
  return {
    id, name: id,
    rootPane: { id: `${id}-pane`, type: 'leaf', surfaces: [{ id: `${id}-surf`, ptyId: `${id}-pty`, title: 't', shell: 'zsh', cwd: '/x' }], activeSurfaceId: `${id}-surf` },
    activePaneId: `${id}-pane`,
  };
}

const dispose = vi.fn();
const sessionClose = vi.fn();

beforeEach(() => {
  dispose.mockReset();
  sessionClose.mockReset();
  (globalThis as { window?: unknown }).window = {
    electronAPI: { pty: { dispose }, remote: { sessionClose } },
  };
  useStore.getState().loadSession({ workspaces: [local('ws-1'), local('ws-2')], activeWorkspaceId: 'ws-1', sidebarVisible: true } as unknown as SessionData);
  useStore.setState({
    pcRailHosts: [{ id: 'h1', label: 'office-mac' }],
    pcRailHostsLoaded: true,
    pcRailFeeds: {
      h1: {
        workspaces: [row({ layout: splitLayout }), row({ id: 'rw2', name: 'web', panes: [{ sessionId: 's9' }] }),
          row({ id: 'rw3', panes: [{ sessionId: 's10' }] }), row({ id: 'rw4', panes: [{ sessionId: 's11' }] })],
        fetchedAt: 1, failedTicks: 0,
      },
    },
  });
});

afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
});

const ids = () => useStore.getState().workspaces.map((w) => w.id);

describe('shadow workspaces in the store', () => {
  it('opens a shadow from the feed row, activates it, and reuses it on the next open', () => {
    const id = useStore.getState().openShadowWorkspace('h1', 'rw1');
    expect(id).toBe('shadow:h1:rw1');
    expect(useStore.getState().activeWorkspaceId).toBe(id);
    expect(useStore.getState().openShadowWorkspace('h1', 'rw1')).toBe(id);
    expect(ids().filter((w) => w === id)).toHaveLength(1);
  });

  it('keeps at most three shadows, closing the least recently used', () => {
    const st = () => useStore.getState();
    for (const r of ['rw1', 'rw2', 'rw3', 'rw4']) st().openShadowWorkspace('h1', r);
    expect(ids().filter((w) => w.startsWith('shadow:'))).toEqual(['shadow:h1:rw2', 'shadow:h1:rw3', 'shadow:h1:rw4']);
  });

  it('closing a shadow detaches only: no session close, no pty dispose, and a local workspace comes back', () => {
    const id = useStore.getState().openShadowWorkspace('h1', 'rw1')!;
    useStore.getState().closeShadowWorkspace(id);
    expect(ids()).toEqual(['ws-1', 'ws-2']);
    expect(useStore.getState().activeWorkspaceId).toBe('ws-1');
    expect(sessionClose).not.toHaveBeenCalled();
    expect(dispose).not.toHaveBeenCalled();
  });

  it('never lets a shadow stand in for the last local workspace', () => {
    useStore.getState().openShadowWorkspace('h1', 'rw1');
    useStore.getState().removeWorkspace('ws-2');
    useStore.getState().removeWorkspace('ws-1');
    expect(ids()).toContain('ws-1');
  });

  it('refuses archive and duplicate of a shadow', () => {
    const id = useStore.getState().openShadowWorkspace('h1', 'rw1')!;
    useStore.getState().duplicateWorkspace(id);
    useStore.getState().archiveWorkspace(id);
    expect(ids()).toEqual(['ws-1', 'ws-2', id]);
    expect(useStore.getState().archivedWorkspaces).toEqual([]);
  });

  it('refuses a local shell or file inside a shadow, and ends the shell', () => {
    const id = useStore.getState().openShadowWorkspace('h1', 'rw1')!;
    const ws = () => useStore.getState().workspaces.find((w) => w.id === id)!;
    const leaf = leaves(ws().rootPane)[0];
    const before = leaf.surfaces.length;
    useStore.getState().addSurface(leaf.id, 'local-pty', 'zsh', '/', id);
    useStore.getState().addEditorSurface(leaf.id, '/etc/hosts');
    expect(leaves(ws().rootPane)[0].surfaces).toHaveLength(before);
    expect(dispose).toHaveBeenCalledWith('local-pty');
  });

  it('refuses a second tab for a remote session that is already open', () => {
    useStore.getState().openShadowWorkspace('h1', 'rw1');
    useStore.getState().setActiveWorkspace('ws-1');
    useStore.getState().addRemoteSurface('ws-1-pane', 'h1', 's1', '', '', 'ws-1', false, 'rw1');
    expect(findRemoteSurface(useStore.getState(), 'h1', 's1')?.workspaceId).toBe('shadow:h1:rw1');
    const localLeaf = useStore.getState().workspaces.find((w) => w.id === 'ws-1')!.rootPane as PaneLeaf;
    expect(localLeaf.surfaces.some((s) => s.surfaceType === 'remote-terminal')).toBe(false);
  });

  it('reconciles against the feed: a vanished row closes its shadow', () => {
    const id = useStore.getState().openShadowWorkspace('h1', 'rw2')!;
    useStore.setState((s) => ({ pcRailFeeds: { h1: { ...s.pcRailFeeds.h1, workspaces: s.pcRailFeeds.h1.workspaces.filter((w) => w.id !== 'rw2') } } }));
    useStore.getState().reconcileShadowWorkspaces('h1');
    expect(ids()).not.toContain(id);
  });

  it('never restores a shadow from session.json', () => {
    useStore.getState().loadSession({
      workspaces: [local('ws-1'), { ...local('x'), id: 'shadow:h1:rw1' }],
      activeWorkspaceId: 'shadow:h1:rw1',
      sidebarVisible: true,
    } as unknown as SessionData);
    expect(ids()).toEqual(['ws-1']);
    expect(useStore.getState().activeWorkspaceId).toBe('ws-1');
  });
});

describe('exclusions outside the store', () => {
  const read = (rel: string) => fs.readFileSync(path.join(__dirname, '..', '..', rel), 'utf-8');

  it('session save writes local workspaces only and never a shadow as the active one', () => {
    const src = read('components/Layout/AppLayout.tsx');
    expect(src.match(/withoutShadowWorkspaces\(buildSessionData\(dumped\), useStore\.getState\(\)\)/g)).toHaveLength(2);
    expect(src.match(/buildSessionData\(dumped\)/g)).toHaveLength(2);
    const data = { workspaces: [local('ws-1'), { ...local('x'), id: 'shadow:h1:rw1' }], activeWorkspaceId: 'shadow:h1:rw1' } as unknown as SessionData;
    const saved = withoutShadowWorkspaces(data, { pcRail: { lastWorkspaceByPc: { local: 'ws-1' } } });
    expect(saved.workspaces.map((w) => w.id)).toEqual(['ws-1']);
    expect(saved.activeWorkspaceId).toBe('ws-1');
    const plain = { workspaces: [local('ws-1')], activeWorkspaceId: 'ws-1' } as unknown as SessionData;
    expect(withoutShadowWorkspaces(plain, {})).toBe(plain);
  });

  it('the empty-leaf funnel spawns no shell in a shadow, and the sidebars list none', () => {
    expect(read('components/Layout/EmptyLeafFunnel.tsx')).toMatch(/if \(isShadowWorkspaceId\(activeWorkspace\.id\)\) return;/);
    expect(read('components/Sidebar/Sidebar.tsx')).toContain('workspaces.filter((w) => !isShadowWorkspaceId(w.id))');
    expect(read('components/Sidebar/MiniSidebar.tsx')).toContain('allWorkspaces.filter((w) => !isShadowWorkspaceId(w.id))');
  });
});
