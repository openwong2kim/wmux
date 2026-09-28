// @vitest-environment jsdom
// Pinned to top (#1549): the pinned group is a prefix of the stored order, and
// the sidebar never shows a nested fan-out task in the group. A pin on a
// workspace that becomes a nested task (pinned under the old slot rule, or
// before its lineage resolved) must be dropped in the store, or Ctrl+N, the
// rail and the sidebar disagree and the pin can never be removed.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useStore } from '../../index';
import type { Workspace } from '../../../../shared/types';
import type { WorkTask } from '../../../../shared/workTask';

const ws = (id: string) => ({ id, name: id }) as unknown as Workspace;

const task = (paneGroupId: string, owner: string, over: Partial<WorkTask> = {}): WorkTask => {
  const ref = { principalId: 'p', verifiedWorkspaceId: owner };
  return {
    id: `t-${paneGroupId}`,
    title: paneGroupId,
    status: 'open',
    missionChannelId: `chan-${paneGroupId}`,
    createdAt: 0,
    createdBy: ref,
    owner: ref,
    paneGroupId,
    ...over,
  } as WorkTask;
};

const ids = () => useStore.getState().workspaces.map((w) => w.id);

describe('a nested fan-out task never stays pinned', () => {
  let initial: ReturnType<typeof useStore.getState>;
  beforeEach(() => {
    initial = useStore.getState();
    // `c` is pinned first, `a` second; `b` is unpinned.
    useStore.setState({
      workspaces: [ws('c'), ws('a'), ws('b')],
      sidebarPinnedIds: ['c', 'a'],
      missionsByWorkspace: {},
      missionByPaneGroup: {},
      fanoutLineage: {},
      fanoutSpawnOwner: {},
    });
  });
  afterEach(() => {
    useStore.setState(initial, true);
    delete (window as unknown as { electronAPI?: unknown }).electronAPI;
  });

  it('unpins it and moves it to the top of the rest when a mission nests it', () => {
    useStore.getState().setMissions('a', [task('c', 'a')]);
    expect(useStore.getState().sidebarPinnedIds).toEqual(['a']);
    expect(ids()).toEqual(['a', 'c', 'b']);
  });

  it('keeps the pin of a detached task (it renders top-level)', () => {
    useStore.getState().setMissions('a', [task('c', 'a', { detachedAt: 1 })]);
    expect(useStore.getState().sidebarPinnedIds).toEqual(['c', 'a']);
    expect(ids()).toEqual(['c', 'a', 'b']);
  });

  it('unpins it when lineage resolves after the pin was set', async () => {
    (window as unknown as { electronAPI: unknown }).electronAPI = {
      fanout: { lineage: async () => ({ c: { owner: 'a' } }) },
    };
    await useStore.getState().refreshFanoutProvenance({ audit: false });
    expect(useStore.getState().sidebarPinnedIds).toEqual(['a']);
    expect(ids()).toEqual(['a', 'c', 'b']);
  });

  it('refuses a pin on a nested task, from the menu or a rail drop', () => {
    useStore.setState({ workspaces: [ws('c'), ws('a'), ws('x'), ws('b')] });
    useStore.getState().noteFanoutSpawn('b', 'a');
    // The menu refuses outright: the row does not move either.
    useStore.getState().toggleSidebarPin('b');
    expect(useStore.getState().sidebarPinnedIds).toEqual(['c', 'a']);
    expect(ids()).toEqual(['c', 'a', 'x', 'b']);
    // Manual rail drop of `b` beside a pinned row asks to pin it.
    useStore.getState().reorderWorkspace(3, 0, true);
    expect(useStore.getState().sidebarPinnedIds).toEqual(['c', 'a']);
    expect(ids().slice(0, 2)).toEqual(['c', 'a']);
  });
});
