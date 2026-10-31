import { describe, expect, it } from 'vitest';
import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import { createWorkspaceSlice, type WorkspaceSlice } from '../workspaceSlice';
import type { ProjectPaneSeed } from '../projectConfigSlice';
import { createWorkspace, type PaneBranch } from '../../../../shared/types';
import { getWorkspaceLeafPanes } from '../../../../shared/paneUtils';

type TestState = WorkspaceSlice & { multiviewIds: string[]; projectPaneSeed: Record<string, ProjectPaneSeed> };

function store() {
  const first = createWorkspace('wmux');
  return create<TestState>()(immer((...args) => ({
    // @ts-expect-error — minimal test store doesn't match full StoreState
    ...createWorkspaceSlice(...args),
    workspaces: [first],
    activeWorkspaceId: first.id,
    multiviewIds: [],
    projectPaneSeed: {},
  })));
}

const input = {
  id: 'ws-co',
  name: 'checkout',
  cwd: '/repo/checkout',
  mission: ' Ship refunds ',
  standingOrders: 'Report with tests.',
  ceo: 0,
  seats: [
    { label: 'researcher', owns: 'Research', command: 'claude "$(cat \'/b/researcher.md\')"' },
    { label: 'dev-1', owns: '', command: 'claude', cwd: '/wt/dev-1' },
    { label: 'notes', owns: '', command: null },
  ],
};

describe('workspaceSlice.addCompanyWorkspace', () => {
  it('makes a company with the CEO seated and every seat seeded in the same update', () => {
    const s = store();
    expect(s.getState().addCompanyWorkspace(input)).toBe(true);
    const ws = s.getState().workspaces.find((w) => w.id === 'ws-co')!;
    const leaves = getWorkspaceLeafPanes(ws);
    expect(s.getState().activeWorkspaceId).toBe('ws-co');
    expect(ws.company).toMatchObject({ v: 1, coordinatorPaneId: leaves[0].id, mission: 'Ship refunds', standingOrders: 'Report with tests.' });
    expect(ws.activePaneId).toBe(leaves[0].id);
    expect(leaves.map((l) => s.getState().projectPaneSeed[l.id])).toEqual([
      { label: 'researcher', command: input.seats[0].command, cwd: '/repo/checkout', role: 'Research' },
      { label: 'dev-1', command: 'claude', cwd: '/wt/dev-1' },
      { label: 'notes', cwd: '/repo/checkout' },
    ]);
  });

  it('puts the CEO in the left pane whichever seat it is, and takes a final name that got a suffix', () => {
    const s = store();
    const long = 'a'.repeat(60);
    expect(s.getState().addCompanyWorkspace({ ...input, ceo: 1, seats: [{ ...input.seats[0], label: `${long}-2` }, input.seats[1], input.seats[2]] })).toBe(true);
    const ws = s.getState().workspaces.find((w) => w.id === 'ws-co')!;
    const leaves = getWorkspaceLeafPanes(ws);
    const root = ws.rootPane as PaneBranch;
    expect(root.children[0].id).toBe(leaves[0].id);
    expect(ws.company?.coordinatorPaneId).toBe(leaves[0].id);
    expect(leaves.map((l) => s.getState().projectPaneSeed[l.id]?.label)).toEqual(['dev-1', `${long}-2`, 'notes']);
  });

  it('makes nothing from seats a company cannot have, or over an existing id', () => {
    const s = store();
    expect(s.getState().addCompanyWorkspace({ ...input, ceo: 5 })).toBe(false);
    expect(s.getState().addCompanyWorkspace({ ...input, id: s.getState().workspaces[0].id })).toBe(false);
    expect(s.getState().workspaces).toHaveLength(1);
  });
});
