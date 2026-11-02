import { describe, it, expect, vi } from 'vitest';
import { createSurfaceSlice } from '../surfaceSlice';
import type { Pane, PaneLeaf, Surface, Workspace } from '../../../../shared/types';

const terminal = (id: string): Surface => ({ id, ptyId: `pty-${id}`, title: '', shell: 'zsh', cwd: '/repo', surfaceType: 'terminal' });
const leaf = (id: string): PaneLeaf => ({ id, type: 'leaf', surfaces: [terminal(`s-${id}`)], activeSurfaceId: `s-${id}` });

function harness(company: Workspace['company']) {
  const ws = {
    id: 'ws-co', name: 'wmux', activePaneId: 'p1', company,
    rootPane: { id: 'split', type: 'branch', direction: 'horizontal', sizes: [50, 50], children: [leaf('p1'), leaf('p2')] } as unknown as Pane,
  } as Workspace;
  const state = {
    workspaces: [ws],
    activeWorkspaceId: ws.id,
    focusPaneSurface: vi.fn((_ws: string, paneId: string, surfaceId: string) => {
      const pane = (state.workspaces[0].rootPane as unknown as { children: PaneLeaf[] }).children.find((c) => c.id === paneId)!;
      state.workspaces[0].activePaneId = paneId;
      pane.activeSurfaceId = surfaceId;
      return true;
    }),
  };
  const slice = createSurfaceSlice(((fn: (s: typeof state) => void) => fn(state)) as never, (() => state) as never, {} as never);
  const panes = () => (state.workspaces[0].rootPane as unknown as { children: PaneLeaf[] }).children;
  return { state, slice, panes };
}

describe('surfaceSlice.openCompanyBoard', () => {
  it('opens one board beside the CEO and focuses it, reusing it the next time', () => {
    const { state, slice, panes } = harness({ v: 1, id: 'co-1', coordinatorPaneId: 'p2' });
    slice.openCompanyBoard('ws-co');
    slice.openCompanyBoard('ws-co');
    const boards = panes().flatMap((p) => p.surfaces.filter((s) => s.surfaceType === 'board').map((s) => [p.id, s]));
    expect(boards).toHaveLength(1);
    const [paneId, board] = boards[0] as [string, Surface];
    expect(paneId).toBe('p2');
    expect(board).toMatchObject({ ptyId: '', title: '' });
    expect(state.workspaces[0].activePaneId).toBe('p2');
    expect(panes()[1].activeSurfaceId).toBe(board.id);
  });

  it('opens in the active pane when the CEO seat is vacant, and not at all outside a company', () => {
    const vacant = harness({ v: 1, id: 'co-1', coordinatorPaneId: null });
    vacant.slice.openCompanyBoard('ws-co');
    expect(vacant.panes()[0].surfaces.map((s) => s.surfaceType)).toEqual(['terminal', 'board']);

    const plain = harness(undefined);
    plain.slice.openCompanyBoard('ws-co');
    expect(plain.panes().flatMap((p) => p.surfaces).some((s) => s.surfaceType === 'board')).toBe(false);
    expect(plain.state.focusPaneSurface).not.toHaveBeenCalled();
  });
});
