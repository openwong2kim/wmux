// The host feeds worker turn ends from its own EventBus subscription, so the
// idle clock runs whether or not Moa's runtime (the deck's bus subscription) is on.
import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ ipcMain: { removeHandler: vi.fn(), handle: vi.fn() }, BrowserWindow: {} }));
const noteLifecycle = vi.fn();
const innerDispose = vi.fn();
vi.mock('../fanoutWorkerWatch', () => ({
  installFanoutWorkerWatch: () => ({ noteLifecycle, tick: vi.fn(async () => undefined), dispose: innerDispose }),
}));

import { eventBus } from '../../events/EventBus';
import { startFanoutWorkerWatch } from '../fanoutWorkerWatchHost';

describe('startFanoutWorkerWatch', () => {
  it('feeds agent.lifecycle events from the bus to the watch and the extra consumer, and unsubscribes on dispose', () => {
    const extra = vi.fn();
    const w = startFanoutWorkerWatch(() => null, () => null, () => false, extra);
    const ev = { type: 'agent.lifecycle', workspaceId: 'ws-t', ptyId: 'p1', kind: 'agent.stop', source: 'hook', agent: 'claude', seq: 1, ts: 1, decision: 'emit' } as const;
    eventBus.emit(ev);
    eventBus.emit({ type: 'pr.ci', workspaceId: 'ws-t', ptyId: 'p1', prNumber: 1, url: 'u', checks: 'failing' } as never);
    expect(noteLifecycle).toHaveBeenCalledTimes(1);
    expect(extra).toHaveBeenCalledTimes(1);
    expect(noteLifecycle.mock.calls[0][0]).toMatchObject({ workspaceId: 'ws-t', ptyId: 'p1', kind: 'agent.stop' });
    w.dispose();
    expect(innerDispose).toHaveBeenCalledTimes(1);
    eventBus.emit(ev);
    expect(noteLifecycle).toHaveBeenCalledTimes(1);
    expect(extra).toHaveBeenCalledTimes(1);
  });
});
