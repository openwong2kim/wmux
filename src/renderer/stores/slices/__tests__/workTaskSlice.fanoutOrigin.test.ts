// @vitest-environment jsdom
// Requester origin: the spawn seeds it, the durable lineage stamp answers it,
// and entries for closed workspaces are dropped.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useStore } from '../../index';
import type { Workspace } from '../../../../shared/types';

const ws = (id: string) => ({ id, name: id }) as unknown as Workspace;

describe('fanoutOrigin', () => {
  let initial: ReturnType<typeof useStore.getState>;
  beforeEach(() => {
    initial = useStore.getState();
    useStore.setState({
      workspaces: [ws('owner'), ws('t1'), ws('t2')],
      fanoutLineage: {},
      fanoutSpawnOwner: {},
      fanoutOrigin: {},
    });
  });
  afterEach(() => {
    useStore.setState(initial, true);
    delete (window as unknown as { electronAPI?: unknown }).electronAPI;
  });

  it('is seeded by the spawn, answered by the stamp, and pruned with its workspace', async () => {
    useStore.getState().noteFanoutSpawn('t1', 'owner', { kind: 'pane', paneId: 'p74', label: 'w115-74' });
    useStore.getState().noteFanoutSpawn('t2', 'owner', { kind: 'gui' });
    expect(useStore.getState().fanoutOrigin.t1).toEqual({ kind: 'pane', paneId: 'p74', label: 'w115-74' });

    (window as unknown as { electronAPI: unknown }).electronAPI = {
      fanout: {
        lineage: async () => ({
          t1: { owner: 'owner', at: 1, origin: { kind: 'pane', paneId: 'p74', surfaceId: 's74', label: 'w115-74' } },
          // An older stamp without an origin: the spawn-seeded one stays.
          t2: { owner: 'owner', at: 1 },
        }),
      },
    };
    await useStore.getState().refreshFanoutProvenance({ audit: false });
    expect(useStore.getState().fanoutOrigin).toEqual({
      t1: { kind: 'pane', paneId: 'p74', surfaceId: 's74', label: 'w115-74' },
      t2: { kind: 'gui' },
    });

    useStore.setState({ workspaces: [ws('owner'), ws('t1')] });
    await useStore.getState().refreshFanoutProvenance({ audit: false });
    expect(Object.keys(useStore.getState().fanoutOrigin)).toEqual(['t1']);
  });
});
