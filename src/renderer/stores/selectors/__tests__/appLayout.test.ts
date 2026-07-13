// Selector-purity guards for the AppLayout render-isolation fix (2026-07-13).
// These lock the exact property the fix depends on: AppLayout re-renders ONLY
// when one of these derived strings CHANGES, so each must stay byte-identical
// across the churn we're eliminating (surface title/cwd, metadata) and change
// only on the structural events AppLayout actually cares about.

import { describe, it, expect } from 'vitest';
import { selectActiveEmptyLeafIdsKey, selectProjectCwdSignature } from '../appLayout';
import type { StoreState } from '../../index';
import type { Pane, PaneLeaf, Surface, Workspace } from '../../../../shared/types';

function surface(id: string, over: Partial<Surface> = {}): Surface {
  return { id, ptyId: `pty-${id}`, surfaceType: 'terminal', title: '', ...over } as Surface;
}
function leaf(id: string, surfaces: Surface[]): PaneLeaf {
  return { type: 'leaf', id, surfaces, activeSurfaceId: surfaces[0]?.id ?? '' } as PaneLeaf;
}
function split(id: string, children: Pane[]): Pane {
  return { type: 'split', id, direction: 'horizontal', children, sizes: children.map(() => 1) } as unknown as Pane;
}
function ws(id: string, rootPane: Pane, over: Partial<Workspace> = {}): Workspace {
  return { id, name: id, rootPane, activePaneId: rootPane.id, ...over } as Workspace;
}
function state(workspaces: Workspace[], activeWorkspaceId: string): StoreState {
  return { workspaces, activeWorkspaceId } as unknown as StoreState;
}

describe('selectActiveEmptyLeafIdsKey', () => {
  it('is empty when there is no active workspace', () => {
    expect(selectActiveEmptyLeafIdsKey(state([], 'nope'))).toBe('');
    expect(selectActiveEmptyLeafIdsKey(state([ws('a', leaf('l', []))], 'other'))).toBe('');
  });

  it('lists empty-leaf ids and ignores leaves that have surfaces', () => {
    const root = split('s', [leaf('empty1', []), leaf('full', [surface('x')]), leaf('empty2', [])]);
    expect(selectActiveEmptyLeafIdsKey(state([ws('a', root)], 'a'))).toBe('empty1|empty2');
  });

  it('is STABLE across surface title/cwd churn (same empty-leaf set)', () => {
    // Two states differing ONLY in a filled leaf's surface title + cwd (the churn
    // that replaces rootPane via updateSurfaceTitleByPty/updateSurfaceCwd) — the
    // empty-leaf SET is unchanged, so the key must be byte-identical.
    const before = ws('a', split('s', [leaf('e', []), leaf('f', [surface('x', { title: 'old', cwd: 'C:/a' })])]));
    const after = ws('a', split('s', [leaf('e', []), leaf('f', [surface('x', { title: 'NEW', cwd: 'C:/b' })])]));
    expect(selectActiveEmptyLeafIdsKey(state([after], 'a')))
      .toBe(selectActiveEmptyLeafIdsKey(state([before], 'a')));
  });

  it('CHANGES when an empty leaf appears (a split) — the effect must re-fire', () => {
    const one = ws('a', leaf('root', [surface('x')]));
    const afterSplit = ws('a', split('s', [leaf('root', [surface('x')]), leaf('new', [])]));
    expect(selectActiveEmptyLeafIdsKey(state([afterSplit], 'a')))
      .not.toBe(selectActiveEmptyLeafIdsKey(state([one], 'a')));
    expect(selectActiveEmptyLeafIdsKey(state([afterSplit], 'a'))).toBe('new');
  });
});

describe('selectProjectCwdSignature', () => {
  it('reflects each workspace effective cwd', () => {
    const a = ws('a', leaf('la', [surface('x')]), { metadata: { cwd: 'C:/a' } });
    const b = ws('b', leaf('lb', [surface('y')]), { profile: { startupCwd: 'C:/b' } as Workspace['profile'] });
    expect(selectProjectCwdSignature(state([a, b], 'a'))).toBe('a:C:/a|b:C:/b');
  });

  it('is STABLE when a non-cwd metadata field churns (agentStatus)', () => {
    const before = ws('a', leaf('l', [surface('x')]), { metadata: { cwd: 'C:/a', agentStatus: 'idle' } });
    const after = ws('a', leaf('l', [surface('x')]), { metadata: { cwd: 'C:/a', agentStatus: 'running' } });
    expect(selectProjectCwdSignature(state([after], 'a')))
      .toBe(selectProjectCwdSignature(state([before], 'a')));
  });

  it('CHANGES when a workspace cwd first appears — project discovery must re-fire', () => {
    const before = ws('a', leaf('l', [surface('x')]));
    const after = ws('a', leaf('l', [surface('x')]), { metadata: { cwd: 'C:/proj' } });
    expect(selectProjectCwdSignature(state([after], 'a')))
      .not.toBe(selectProjectCwdSignature(state([before], 'a')));
  });
});
