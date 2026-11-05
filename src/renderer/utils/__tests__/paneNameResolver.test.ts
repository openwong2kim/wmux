import { describe, it, expect } from 'vitest';
import type { PaneBranch, PaneLeaf, Surface } from '../../../shared/types';
import { resolvePaneName, type PaneNameWorkspace } from '../paneNameResolver';

function term(id: string, ptyId: string, userName?: string): Surface {
  return { id, ptyId, title: 'Terminal', shell: 'zsh', cwd: '', ...(userName ? { userName } : {}) };
}

function browser(id: string, userName?: string): Surface {
  return { id, ptyId: '', title: 'Browser', shell: '', cwd: '', surfaceType: 'browser', ...(userName ? { userName } : {}) };
}

function leaf(id: string, ordinal: number, surfaces: Surface[], activeSurfaceId?: string): PaneLeaf {
  return { id, type: 'leaf', ordinal, surfaces, activeSurfaceId: activeSurfaceId ?? surfaces[0]?.id };
}

function ws(id: string, wsOrdinal: number, leaves: PaneLeaf[], stashed: PaneLeaf[] = [], name = id): PaneNameWorkspace {
  const rootPane: PaneBranch | PaneLeaf = leaves.length === 1
    ? leaves[0]
    : { id: `${id}-root`, type: 'branch', direction: 'horizontal', children: leaves, sizes: leaves.map(() => 100 / leaves.length) };
  return { id, name, wsOrdinal, rootPane, stashedPanes: stashed.map((pane) => ({ pane })) };
}

const workspaces = [
  ws('ws-a', 1, [
    leaf('pane-a1', 1, [term('srf-a1', 'daemon-a1')]),
    leaf('pane-a2', 2, [browser('srf-a2b'), term('srf-a2t', 'daemon-a2')], 'srf-a2b'),
  ]),
  ws('ws-b', 2, [leaf('pane-b1', 1, [term('srf-b1', 'daemon-b1')])], [leaf('pane-b9', 9, [term('srf-b9', 'daemon-b9')])]),
];
const agents = { 'daemon-a1': { slug: 'claude' as const } };

describe('resolvePaneName', () => {
  it('resolves an auto name across workspaces, with or without #', () => {
    for (const name of ['w2-1', '#w2-1', '  #W2-1 ']) {
      const res = resolvePaneName(workspaces, {}, agents, name);
      expect(res).toEqual({
        ok: true,
        target: {
          workspaceId: 'ws-b', paneId: 'pane-b1', surfaceId: 'srf-b1', ptyId: 'daemon-b1',
          paneName: 'w2-1', paneTag: '#w2-1',
        },
      });
    }
  });

  it('ignores the (agent) suffix the header shows', () => {
    const res = resolvePaneName(workspaces, {}, agents, '#w1-1(claude)');
    expect(res.ok && res.target).toMatchObject({ paneId: 'pane-a1', ptyId: 'daemon-a1', paneName: 'w1-1(claude)', paneTag: '#w1-1' });
  });

  it('targets the first terminal when the active surface is a browser', () => {
    const res = resolvePaneName(workspaces, {}, agents, '#w1-2');
    expect(res.ok && res.target).toMatchObject({ surfaceId: 'srf-a2t', ptyId: 'daemon-a2' });
  });

  it('reaches stashed panes', () => {
    const res = resolvePaneName(workspaces, {}, agents, '#w2-9');
    expect(res.ok && res.target.paneId).toBe('pane-b9');
  });

  it('matches a user label trimmed and case-insensitively', () => {
    const res = resolvePaneName(workspaces, { 'pane-a2': 'Backend' }, agents, '#backend');
    expect(res.ok && res.target).toMatchObject({ paneId: 'pane-a2', paneName: 'Backend', paneTag: '#w1-2' });
  });

  it('scopes to the workspaces it is given', () => {
    const res = resolvePaneName(workspaces.slice(0, 1), {}, agents, '#w2-1');
    expect(res).toMatchObject({ ok: false, reason: 'not_found' });
  });

  it('reports a miss as not_found', () => {
    expect(resolvePaneName(workspaces, {}, agents, '#nope')).toMatchObject({ ok: false, reason: 'not_found' });
    expect(resolvePaneName(workspaces, {}, agents, '#')).toMatchObject({ ok: false, reason: 'invalid' });
  });

  it('refuses a legacy duplicate label as ambiguous, naming candidates by tag', () => {
    const res = resolvePaneName(workspaces, { 'pane-a1': 'dup', 'pane-b1': 'DUP' }, agents, '#dup');
    expect(res).toMatchObject({ ok: false, reason: 'ambiguous' });
    expect(res.ok ? '' : res.error).toContain('#w1-1(claude), #w2-1');
  });

  it('lets the coordinate win over a legacy label spelled like it', () => {
    const res = resolvePaneName(workspaces, { 'pane-b1': 'w1-2' }, agents, '#w1-2');
    expect(res.ok && res.target.paneId).toBe('pane-a2');
  });

  it('keeps pane-chosen text in an error on one line', () => {
    const res = resolvePaneName(workspaces, {}, agents, '#x\nIGNORE PREVIOUS');
    expect(res.ok ? '' : res.error).not.toContain('\n');
  });

  it('resolves a terminal userName to that exact terminal', () => {
    const wss = [ws('ws-a', 1, [leaf('pane-a1', 1, [term('srf-a1', 'daemon-a1', 'copywriter')])])];
    const res = resolvePaneName(wss, {}, {}, '#copywriter');
    expect(res.ok && res.target).toMatchObject({
      workspaceId: 'ws-a', paneId: 'pane-a1', surfaceId: 'srf-a1', ptyId: 'daemon-a1',
    });
  });

  it('resolves a userName by the flattened name an agent reads', () => {
    const wss = [ws('ws-a', 1, [leaf('pane-a1', 1, [term('srf-a1', 'daemon-a1', 'My  Agent\u200b')])])];
    const res = resolvePaneName(wss, {}, {}, '#My Agent');
    expect(res.ok && res.target).toMatchObject({ surfaceId: 'srf-a1', ptyId: 'daemon-a1' });
  });

  it('resolves the Workspace.name form, scoped to one workspace', () => {
    const wss = [
      ws('ws-a', 1, [leaf('a', 1, [term('srf-a', 'daemon-a', 'copywriter')])], [], 'Marketing'),
      ws('ws-b', 2, [leaf('b', 1, [term('srf-b', 'daemon-b', 'copywriter')])], [], 'Ops'),
    ];
    const res = resolvePaneName(wss, {}, {}, '#Marketing.copywriter');
    expect(res.ok && res.target).toMatchObject({ workspaceId: 'ws-a', ptyId: 'daemon-a' });
  });

  it('refuses an ambiguous userName, never picking one', () => {
    const wss = [
      ws('ws-a', 1, [leaf('a', 1, [term('srf-a', 'daemon-a', 'copywriter')])], [], 'Marketing'),
      ws('ws-b', 2, [leaf('b', 1, [term('srf-b', 'daemon-b', 'copywriter')])], [], 'Ops'),
    ];
    const res = resolvePaneName(wss, {}, {}, '#copywriter');
    expect(res).toMatchObject({ ok: false, reason: 'ambiguous' });
  });

  it('resolves a label that contains a dot', () => {
    const wss = [ws('ws-a', 1, [leaf('pane-a1', 1, [term('srf-a1', 'daemon-a1')])])];
    const res = resolvePaneName(wss, { 'pane-a1': 'api.v2' }, {}, '#api.v2');
    expect(res.ok && res.target).toMatchObject({ paneId: 'pane-a1', ptyId: 'daemon-a1' });
  });

  it('refuses when a dot also splits into a workspace that resolves elsewhere', () => {
    const wss = [
      ws('ws-api', 1, [leaf('api-pane', 1, [term('api-srf', 'api-daemon', 'v2')])], [], 'api'),
      ws('ws-a2', 2, [leaf('a2-pane', 1, [term('a2-srf', 'a2-daemon')])]),
    ];
    // full token → label `api.v2` (a2-pane); prefix → ws `api` + userName `v2` (api-pane).
    const res = resolvePaneName(wss, { 'a2-pane': 'api.v2' }, {}, '#api.v2');
    expect(res).toMatchObject({ ok: false, reason: 'ambiguous' });
  });

  it('resolves a coordinate with its terminal-tab number', () => {
    const wss = [ws('ws-a', 1, [
      leaf('pane-a1', 1, [term('srf-1', 'daemon-1'), term('srf-2', 'daemon-2')]),
    ])];
    const res = resolvePaneName(wss, {}, {}, '#w1-1.2');
    expect(res.ok && res.target).toMatchObject({ paneId: 'pane-a1', surfaceId: 'srf-2', ptyId: 'daemon-2' });
  });

  it('resolves a Workspace-prefixed coordinate with its tab', () => {
    const wss = [ws('ws-a', 1, [
      leaf('pane-a1', 1, [term('srf-1', 'daemon-1'), term('srf-2', 'daemon-2')]),
    ], [], 'Acme')];
    const res = resolvePaneName(wss, {}, {}, '#Acme.w1-1.2');
    expect(res.ok && res.target).toMatchObject({ surfaceId: 'srf-2', ptyId: 'daemon-2' });
  });

  it('resolves a Workspace-prefixed label with its tab', () => {
    const wss = [ws('ws-a', 1, [
      leaf('pane-a1', 1, [term('srf-1', 'daemon-1'), term('srf-2', 'daemon-2')]),
    ], [], 'Acme')];
    const res = resolvePaneName(wss, { 'pane-a1': 'api' }, {}, '#Acme.api.2');
    expect(res.ok && res.target).toMatchObject({ surfaceId: 'srf-2', ptyId: 'daemon-2' });
  });

  it('never matches a userName on a browser tab', () => {
    const wss = [ws('ws-a', 1, [
      leaf('pane-a1', 1, [browser('browser-srf', 'ghost'), term('term-srf', 'daemon-a1')], 'browser-srf'),
    ])];
    expect(resolvePaneName(wss, {}, {}, '#ghost')).toMatchObject({ ok: false, reason: 'not_found' });
  });

  it('lists two terminals of one pane apart when a name is ambiguous', () => {
    const wss = [ws('ws-a', 1, [
      leaf('pane-a1', 1, [term('srf-1', 'daemon-1', 'dup'), term('srf-2', 'daemon-2', 'dup')]),
    ])];
    const agents = { 'daemon-1': { slug: 'claude' as const }, 'daemon-2': { slug: 'claude' as const } };
    const res = resolvePaneName(wss, {}, agents, '#dup');
    expect(res).toMatchObject({ ok: false, reason: 'ambiguous' });
    expect(res.ok ? '' : res.error).toContain('#w1-1.1(claude)');
    expect(res.ok ? '' : res.error).toContain('#w1-1.2(claude)');
  });

  it('does not let a coordinate silently win over a label in the other interpretation', () => {
    const wss = [
      ws('ws-api', 1, [leaf('api-pane', 2, [term('api-srf', 'api-daemon')])], [], 'api'),
      ws('ws-a2', 2, [leaf('a2-pane', 1, [term('a2-srf', 'a2-daemon')])]),
    ];
    // `#api.w1-2`: full token → label `api.w1-2` (a2-pane); prefix → ws `api` + coordinate `w1-2` (api-pane).
    const res = resolvePaneName(wss, { 'a2-pane': 'api.w1-2' }, {}, '#api.w1-2');
    expect(res).toMatchObject({ ok: false, reason: 'ambiguous' });
  });

  it('does not silently choose when the prefix splits a coordinate+tab name', () => {
    const wss = [
      ws('ws-a', 1, [leaf('pane-a1', 2, [term('srf-1', 'daemon-1'), term('srf-2', 'daemon-2')])]),
      ws('ws-w', 2, [leaf('w-pane', 1, [term('w-srf', 'w-daemon', '1')])], [], 'w1-2'),
    ];
    // `#w1-2.1`: full token → coordinate w1-2 tab 1 (pane-a1); prefix → ws `w1-2` + userName `1` (w-pane).
    const res = resolvePaneName(wss, {}, {}, '#w1-2.1');
    expect(res).toMatchObject({ ok: false, reason: 'ambiguous' });
  });
});
