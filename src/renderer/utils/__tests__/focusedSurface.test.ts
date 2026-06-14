import { describe, it, expect } from 'vitest';
import { focusedTerminalPtyId } from '../focusedSurface';
import type { Workspace } from '../../../shared/types';

function leaf(id: string, surfaces: any[], activeSurfaceId: string) {
  return { id, type: 'leaf', surfaces, activeSurfaceId } as any;
}

function ws(rootPane: any, activePaneId: string): Workspace {
  return { id: 'w1', name: 'w', rootPane, activePaneId } as any;
}

describe('focusedTerminalPtyId', () => {
  it('returns the active terminal surface ptyId', () => {
    const root = leaf('p1', [{ id: 's1', ptyId: 'pty-1', surfaceType: 'terminal' }], 's1');
    expect(focusedTerminalPtyId(ws(root, 'p1'))).toBe('pty-1');
  });

  it('treats missing surfaceType as terminal', () => {
    const root = leaf('p1', [{ id: 's1', ptyId: 'pty-9' }], 's1');
    expect(focusedTerminalPtyId(ws(root, 'p1'))).toBe('pty-9');
  });

  it('returns null when the active surface is a browser/editor', () => {
    const root = leaf('p1', [{ id: 's1', ptyId: '', surfaceType: 'browser' }], 's1');
    expect(focusedTerminalPtyId(ws(root, 'p1'))).toBeNull();
  });

  it('descends a branch tree to the active leaf', () => {
    const child = leaf('p2', [{ id: 's2', ptyId: 'pty-2', surfaceType: 'terminal' }], 's2');
    const root = { id: 'b', type: 'branch', children: [child] } as any;
    expect(focusedTerminalPtyId(ws(root, 'p2'))).toBe('pty-2');
  });

  it('returns null for undefined workspace or empty ptyId', () => {
    expect(focusedTerminalPtyId(undefined)).toBeNull();
    const root = leaf('p1', [{ id: 's1', ptyId: '', surfaceType: 'terminal' }], 's1');
    expect(focusedTerminalPtyId(ws(root, 'p1'))).toBeNull();
  });
});
