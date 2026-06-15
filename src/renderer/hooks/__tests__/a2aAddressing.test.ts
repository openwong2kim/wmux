import { describe, it, expect } from 'vitest';
import type { PaneLeaf, Surface } from '../../../shared/types';
import { resolvePaneAddress, activePaneTerminalPty } from '../a2aAddressing';

function surface(id: string, ptyId: string, surfaceType: Surface['surfaceType'] = 'terminal'): Surface {
  return { id, ptyId, title: id, shell: '', cwd: '', surfaceType } as Surface;
}
function leaf(id: string, surfaces: Surface[], activeSurfaceId?: string): PaneLeaf {
  return { id, type: 'leaf', surfaces, activeSurfaceId: activeSurfaceId ?? surfaces[0]?.id ?? '' };
}

// Target workspace: two panes, each with a distinct agent terminal.
const leaves: PaneLeaf[] = [
  leaf('pane-A', [surface('surf-A', 'pty-A')]),
  leaf('pane-B', [surface('surf-B1', 'pty-B1'), surface('surf-B2', 'pty-B2')], 'surf-B2'),
  leaf('pane-browser', [surface('surf-web', 'pty-web', 'browser')]),
];

describe('resolvePaneAddress', () => {
  it('resolves surface_id → that surface only', () => {
    expect(resolvePaneAddress(leaves, '', 'surf-B1')).toEqual({ ptyId: 'pty-B1', paneId: 'pane-B', surfaceId: 'surf-B1' });
  });

  it('resolves pane_id → the leaf active terminal surface', () => {
    // pane-B's activeSurfaceId is surf-B2.
    expect(resolvePaneAddress(leaves, 'pane-B', '')).toEqual({ ptyId: 'pty-B2', paneId: 'pane-B', surfaceId: 'surf-B2' });
  });

  it('resolves pane_id → first terminal surface when active is not a terminal', () => {
    const ls = [leaf('p', [surface('web', 'pw', 'browser'), surface('t', 'pt')], 'web')];
    expect(resolvePaneAddress(ls, 'p', '')).toEqual({ ptyId: 'pt', paneId: 'p', surfaceId: 't' });
  });

  it('REJECTS when pane_id and surface_id disagree (no silent pick)', () => {
    const r = resolvePaneAddress(leaves, 'pane-A', 'surf-B1');
    expect('error' in r && r.error).toMatch(/does not belong to pane_id/);
  });

  it('REJECTS a browser surface (not a terminal)', () => {
    const r = resolvePaneAddress(leaves, '', 'surf-web');
    expect('error' in r && r.error).toMatch(/not a terminal/);
  });

  it('FAIL-CLOSED: a cross-ws / unknown surface_id is not found (only target leaves searched)', () => {
    const r = resolvePaneAddress(leaves, '', 'surf-from-other-ws');
    expect('error' in r && r.error).toMatch(/not found in target workspace/);
  });

  it('FAIL-CLOSED: an unknown pane_id is not found', () => {
    const r = resolvePaneAddress(leaves, 'pane-from-other-ws', '');
    expect('error' in r && r.error).toMatch(/not found in target workspace/);
  });

  it('REJECTS a pane with no terminal surface', () => {
    const ls = [leaf('only-browser', [surface('web', 'pw', 'browser')])];
    const r = resolvePaneAddress(ls, 'only-browser', '');
    expect('error' in r && r.error).toMatch(/no terminal surface/);
  });
});

describe('activePaneTerminalPty', () => {
  it('returns the active leaf first terminal pty', () => {
    expect(activePaneTerminalPty(leaves, 'pane-B')).toBe('pty-B1');
  });
  it('falls back to the first leaf with a terminal when active id is unknown', () => {
    expect(activePaneTerminalPty(leaves, 'nonexistent')).toBe('pty-A');
  });
  it('returns null when no terminal surface exists', () => {
    expect(activePaneTerminalPty([leaf('p', [surface('w', 'pw', 'browser')])], 'p')).toBeNull();
  });
});
