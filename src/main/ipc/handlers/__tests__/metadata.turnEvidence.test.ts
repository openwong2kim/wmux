// The broadcast status funnel records affirmative turn evidence for the idle
// stops of bot workers: a hook turn start, a reported turn end, the daemon's
// boot settle. A byte-rate 'running' and a synthetic settled idle (latch
// expiry, silence) are no evidence.
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn(), on: vi.fn(), removeHandler: vi.fn(), removeAllListeners: vi.fn() }, BrowserWindow: class {} }));

import { broadcastMetadataUpdate, resetLastBroadcastAgentStatusForTests } from '../metadata.handler';
import { lastHookTurnStart, lastTurnEnd, noteBootSettled } from '../../../notification/turnEvidence';

afterEach(() => {
  vi.useRealTimers();
  resetLastBroadcastAgentStatusForTests();
});

describe('turn evidence from the status funnel', () => {
  it('a hook turn start and a reported end count; a byte-rate running and a settled idle do not', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    broadcastMetadataUpdate(null, { ptyId: 'p1', agentStatus: 'running' });
    expect(lastHookTurnStart('p1')).toBeUndefined();
    broadcastMetadataUpdate(null, { ptyId: 'p1', agentStatus: 'running', hookKind: 'agent.user_prompt_submit' });
    expect(lastHookTurnStart('p1')).toBe(1_000);
    vi.setSystemTime(2_000);
    broadcastMetadataUpdate(null, { ptyId: 'p1', agentStatus: 'complete' });
    expect(lastTurnEnd('p1')).toBe(2_000);
    // A latch expiry or a silence clear settles to idle: no turn end.
    vi.setSystemTime(9_000);
    broadcastMetadataUpdate(null, { ptyId: 'p1', agentStatus: 'idle', settled: true });
    expect(lastTurnEnd('p1')).toBe(2_000);
    noteBootSettled('p1', 10_000);
    expect(lastTurnEnd('p1')).toBe(10_000);
    resetLastBroadcastAgentStatusForTests();
    expect(lastTurnEnd('p1')).toBeUndefined();
  });
});
