// The broadcast status funnel stamps when each pane's status last changed:
// the idle stops of bot workers count from that edge (workerPanesIdle).
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn(), on: vi.fn(), removeHandler: vi.fn(), removeAllListeners: vi.fn() }, BrowserWindow: class {} }));

import { broadcastMetadataUpdate, getLastBroadcastAgentStatusAt, resetLastBroadcastAgentStatusForTests } from '../metadata.handler';

afterEach(() => {
  vi.useRealTimers();
  resetLastBroadcastAgentStatusForTests();
});

describe('getLastBroadcastAgentStatusAt', () => {
  it('moves only when the status changes, not on a repeat of the same status', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    broadcastMetadataUpdate(null, { ptyId: 'p1', agentStatus: 'running' });
    vi.setSystemTime(2_000);
    broadcastMetadataUpdate(null, { ptyId: 'p1', agentStatus: 'complete' });
    vi.setSystemTime(9_000);
    broadcastMetadataUpdate(null, { ptyId: 'p1', agentStatus: 'complete' });
    broadcastMetadataUpdate(null, { ptyId: 'p1', cwd: '/x' } as never);
    expect(getLastBroadcastAgentStatusAt('p1')).toBe(2_000);
    expect(getLastBroadcastAgentStatusAt('p2')).toBeUndefined();
  });
});
