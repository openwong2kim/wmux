/**
 * Unit tests for `resolveActivePanePtyId` — the pure target-resolution half of
 * useActivePaneFocus.
 *
 * The DOM-focus half (terminalRegistry.get(ptyId).focus(), requestAnimationFrame
 * retry) needs a browser harness the repo's node-env vitest doesn't provide, so
 * it's exercised by dogfood rather than here — same split as useKeyboard.test.
 *
 * These tests pin the regression behind the "red border moves but typing lands
 * in the old pane" bug: the resolver must follow BOTH pane switches and
 * same-pane surface (tab) switches, and must decline non-terminal surfaces.
 */
import { describe, it, expect } from 'vitest';
import { resolveActivePanePtyId } from '../useActivePaneFocus';
import type { Workspace, Pane, PaneLeaf, Surface } from '../../../shared/types';

function surface(id: string, ptyId: string, surfaceType?: Surface['surfaceType']): Surface {
  return { id, ptyId, title: id, shell: 'pwsh', cwd: '.', surfaceType };
}

function leaf(id: string, surfaces: Surface[], activeSurfaceId: string): PaneLeaf {
  return { id, type: 'leaf', surfaces, activeSurfaceId };
}

function ws(id: string, rootPane: Pane, activePaneId: string): Workspace {
  return { id, name: id, rootPane, activePaneId };
}

describe('resolveActivePanePtyId', () => {
  it('returns the active surface ptyId of the active pane', () => {
    const root = leaf('p1', [surface('s1', 'pty-1')], 's1');
    const state = { workspaces: [ws('w1', root, 'p1')], activeWorkspaceId: 'w1' };
    expect(resolveActivePanePtyId(state)).toBe('pty-1');
  });

  it('follows a pane switch — picks the ptyId of whichever pane is active', () => {
    // Two side-by-side leaves; activePaneId selects the target. This is the
    // reported bug: navigating the active pane must change the focus target.
    const root: Pane = {
      id: 'branch',
      type: 'branch',
      direction: 'horizontal',
      children: [
        leaf('p1', [surface('s1', 'pty-1')], 's1'),
        leaf('p2', [surface('s2', 'pty-2')], 's2'),
      ],
    };
    expect(resolveActivePanePtyId({ workspaces: [ws('w1', root, 'p1')], activeWorkspaceId: 'w1' })).toBe('pty-1');
    expect(resolveActivePanePtyId({ workspaces: [ws('w1', root, 'p2')], activeWorkspaceId: 'w1' })).toBe('pty-2');
  });

  it('follows a same-pane tab switch — picks the active surface ptyId', () => {
    // In-scope per the chosen fix: keyboard tab switches must move focus too.
    const a = leaf('p1', [surface('s1', 'pty-1'), surface('s2', 'pty-2')], 's1');
    const b = leaf('p1', [surface('s1', 'pty-1'), surface('s2', 'pty-2')], 's2');
    expect(resolveActivePanePtyId({ workspaces: [ws('w1', a, 'p1')], activeWorkspaceId: 'w1' })).toBe('pty-1');
    expect(resolveActivePanePtyId({ workspaces: [ws('w1', b, 'p1')], activeWorkspaceId: 'w1' })).toBe('pty-2');
  });

  it('returns null for a browser surface (no xterm to focus)', () => {
    const root = leaf('p1', [surface('s1', 'pty-1', 'browser')], 's1');
    expect(resolveActivePanePtyId({ workspaces: [ws('w1', root, 'p1')], activeWorkspaceId: 'w1' })).toBeNull();
  });

  it('returns null for an editor surface', () => {
    const root = leaf('p1', [surface('s1', 'pty-1', 'editor')], 's1');
    expect(resolveActivePanePtyId({ workspaces: [ws('w1', root, 'p1')], activeWorkspaceId: 'w1' })).toBeNull();
  });

  it('treats an explicit "terminal" surfaceType the same as undefined', () => {
    const root = leaf('p1', [surface('s1', 'pty-1', 'terminal')], 's1');
    expect(resolveActivePanePtyId({ workspaces: [ws('w1', root, 'p1')], activeWorkspaceId: 'w1' })).toBe('pty-1');
  });

  it('returns null when the active surface has no ptyId yet (mid-create / cleared)', () => {
    const root = leaf('p1', [surface('s1', '')], 's1');
    expect(resolveActivePanePtyId({ workspaces: [ws('w1', root, 'p1')], activeWorkspaceId: 'w1' })).toBeNull();
  });

  it('returns null when no workspace is active', () => {
    const root = leaf('p1', [surface('s1', 'pty-1')], 's1');
    expect(resolveActivePanePtyId({ workspaces: [ws('w1', root, 'p1')], activeWorkspaceId: 'missing' })).toBeNull();
  });

  it('returns null when activePaneId does not resolve to a leaf', () => {
    const root = leaf('p1', [surface('s1', 'pty-1')], 's1');
    expect(resolveActivePanePtyId({ workspaces: [ws('w1', root, 'ghost')], activeWorkspaceId: 'w1' })).toBeNull();
  });

  it('returns null when activePaneId points at a branch, not a leaf', () => {
    const root: Pane = {
      id: 'branch',
      type: 'branch',
      direction: 'vertical',
      children: [leaf('p1', [surface('s1', 'pty-1')], 's1')],
    };
    // findLeaf only matches leaves, so a branch id resolves to null.
    expect(resolveActivePanePtyId({ workspaces: [ws('w1', root, 'branch')], activeWorkspaceId: 'w1' })).toBeNull();
  });

  it('returns null when the active surface id is missing from the pane', () => {
    const root = leaf('p1', [surface('s1', 'pty-1')], 'gone');
    expect(resolveActivePanePtyId({ workspaces: [ws('w1', root, 'p1')], activeWorkspaceId: 'w1' })).toBeNull();
  });
});
