// A pane's agent named for the first time calls the listeners once: the retry
// of a delivery stored while that agent could not be attributed hangs on it
// (input.rpc.ts), and must not fire on every periodic broadcast.
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn(), on: vi.fn(), removeHandler: vi.fn(), removeAllListeners: vi.fn() }, BrowserWindow: class {} }));

import { broadcastMetadataUpdate, clearLastBroadcastAgentStatus, resetLastBroadcastAgentStatusForTests } from '../metadata.handler';
import { onAgentFirstNamed } from '../../../notification/agentFirstNamed';

let off: () => void = () => undefined;

afterEach(() => {
  off();
  resetLastBroadcastAgentStatusForTests();
});

describe('onAgentFirstNamed', () => {
  it('fires once when a name first arrives, not on later broadcasts or status-only ones', () => {
    const named = vi.fn();
    off = onAgentFirstNamed(named);
    broadcastMetadataUpdate(null, { ptyId: 'p1', agentStatus: 'running' });
    broadcastMetadataUpdate(null, { ptyId: 'p1', agentName: '' });
    expect(named).not.toHaveBeenCalled();
    broadcastMetadataUpdate(null, { ptyId: 'p1', agentName: 'Claude Code', agentStatus: 'waiting' });
    for (let i = 0; i < 5; i += 1) broadcastMetadataUpdate(null, { ptyId: 'p1', agentName: 'Claude Code', agentStatus: 'waiting' });
    broadcastMetadataUpdate(null, { ptyId: 'p1', agentStatus: 'running' });
    expect(named.mock.calls).toEqual([['p1']]);
  });

  it('fires again after the name is cleared or the pane torn down, and per pane', () => {
    const named = vi.fn();
    off = onAgentFirstNamed(named);
    broadcastMetadataUpdate(null, { ptyId: 'p1', agentName: 'Claude Code' });
    broadcastMetadataUpdate(null, { ptyId: 'p1', agentName: '' });
    broadcastMetadataUpdate(null, { ptyId: 'p1', agentName: 'Codex' });
    clearLastBroadcastAgentStatus('p1');
    broadcastMetadataUpdate(null, { ptyId: 'p1', agentName: 'Codex' });
    broadcastMetadataUpdate(null, { ptyId: 'p2', agentName: 'Claude Code' });
    expect(named.mock.calls).toEqual([['p1'], ['p1'], ['p1'], ['p2']]);
  });

  it('a throwing listener does not stop the others', () => {
    const second = vi.fn();
    const offFirst = onAgentFirstNamed(() => { throw new Error('boom'); });
    off = onAgentFirstNamed(second);
    broadcastMetadataUpdate(null, { ptyId: 'p1', agentName: 'Claude Code' });
    offFirst();
    expect(second).toHaveBeenCalledWith('p1');
  });
});
