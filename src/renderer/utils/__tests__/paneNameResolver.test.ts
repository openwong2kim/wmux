import { describe, it, expect } from 'vitest';
import type { PaneBranch, PaneLeaf, Surface } from '../../../shared/types';
import { resolvePaneName, type PaneNameWorkspace } from '../paneNameResolver';

function term(id: string, ptyId: string): Surface {
  return { id, ptyId, title: 'Terminal', shell: 'zsh', cwd: '' };
}

function browser(id: string): Surface {
  return { id, ptyId: '', title: 'Browser', shell: '', cwd: '', surfaceType: 'browser' };
}

function leaf(id: string, ordinal: number, surfaces: Surface[], activeSurfaceId?: string): PaneLeaf {
  return { id, type: 'leaf', ordinal, surfaces, activeSurfaceId: activeSurfaceId ?? surfaces[0]?.id };
}

function ws(id: string, wsOrdinal: number, leaves: PaneLeaf[], stashed: PaneLeaf[] = []): PaneNameWorkspace {
  const rootPane: PaneBranch | PaneLeaf = leaves.length === 1
    ? leaves[0]
    : { id: `${id}-root`, type: 'branch', direction: 'horizontal', children: leaves, sizes: leaves.map(() => 100 / leaves.length) };
  return { id, wsOrdinal, rootPane, stashedPanes: stashed.map((pane) => ({ pane })) };
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
});
