import { describe, it, expect, vi, beforeEach } from 'vitest';

const ipcHandlers = new Map<string, (...args: unknown[]) => unknown>();
const ipcListeners = new Map<string, (...args: unknown[]) => unknown>();

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, fn: (...args: unknown[]) => unknown) => { ipcHandlers.set(channel, fn); }),
    removeHandler: vi.fn((channel: string) => { ipcHandlers.delete(channel); }),
    on: vi.fn((channel: string, fn: (...args: unknown[]) => unknown) => { ipcListeners.set(channel, fn); }),
    removeAllListeners: vi.fn((channel: string) => { ipcListeners.delete(channel); }),
  },
}));
vi.mock('../../../notification/ToastManager', () => ({ toastManager: { show: vi.fn() } }));
vi.mock('../../../notification/mutedCategories', () => ({ isCategoryMuted: () => false }));

import { registerPcRailHandlers, isPcRailHostMuted } from '../pcRail.handler';
import { PC_RAIL_IPC } from '../../../../shared/pcRail';
import type { PcRailHub, PcRailHubDeps } from '../../../remote/pcRailHub';

function fakeSender(id: number) {
  const listeners = new Map<string, (...args: unknown[]) => void>();
  return {
    id,
    sent: [] as unknown[],
    isDestroyed: () => false,
    send(channel: string, payload: unknown) { this.sent.push([channel, payload]); },
    once: (ev: string, fn: (...args: unknown[]) => void) => { listeners.set(ev, fn); },
    on: (ev: string, fn: (...args: unknown[]) => void) => { listeners.set(ev, fn); },
    removeListener: (ev: string) => { listeners.delete(ev); },
    fire: (ev: string, ...args: unknown[]) => listeners.get(ev)?.(...args),
  };
}

function setup() {
  let running = false;
  let hubDeps: PcRailHubDeps | null = null;
  const muted: string[][] = [];
  const hub = {
    start: vi.fn(() => { running = true; }),
    stop: vi.fn(() => { running = false; }),
    isRunning: () => running,
    snapshot: () => [{ type: 'hosts', hosts: [] }],
    setMuted: (ids: Iterable<string>) => muted.push([...ids]),
  } as unknown as PcRailHub;
  const dispose = registerPcRailHandlers({
    store: { list: () => [], get: () => null },
    attachments: { list: () => [] },
    hubFactory: (deps) => { hubDeps = deps; return hub; },
  });
  return { hub, muted, dispose, deps: () => hubDeps!, isRunning: () => running };
}

describe('pcRail.handler', () => {
  beforeEach(() => { ipcHandlers.clear(); ipcListeners.clear(); });

  it('runs the hub while any subscribe is outstanding, and a reload drops the count', () => {
    const { hub, isRunning, dispose } = setup();
    const a = fakeSender(1);
    const subscribe = ipcListeners.get(PC_RAIL_IPC.SUBSCRIBE)!;
    const unsubscribe = ipcListeners.get(PC_RAIL_IPC.UNSUBSCRIBE)!;
    subscribe({ sender: a });
    subscribe({ sender: a });
    expect(isRunning()).toBe(true);
    unsubscribe({ sender: a });
    expect(isRunning()).toBe(true);
    unsubscribe({ sender: a });
    expect(isRunning()).toBe(false);

    subscribe({ sender: a });
    subscribe({ sender: a });
    a.fire('did-start-navigation', {}, 'app://x', false, true);
    expect(isRunning()).toBe(false);
    expect(hub.stop).toHaveBeenCalledTimes(2);
    dispose();
  });

  it('a late subscriber gets the current snapshot; pushes reach every subscriber', () => {
    const { deps, dispose } = setup();
    const a = fakeSender(1);
    const b = fakeSender(2);
    ipcListeners.get(PC_RAIL_IPC.SUBSCRIBE)!({ sender: a });
    ipcListeners.get(PC_RAIL_IPC.SUBSCRIBE)!({ sender: b });
    expect(b.sent).toEqual([['pcRail:feed-event', { type: 'hosts', hosts: [] }]]);
    deps().stream('h1', 'reopen');
    expect(a.sent).toContainEqual([PC_RAIL_IPC.STREAM_EVENT, { hostId: 'h1', state: 'reopen' }]);
    expect(b.sent).toContainEqual([PC_RAIL_IPC.STREAM_EVENT, { hostId: 'h1', state: 'reopen' }]);
    dispose();
  });

  it('stores a bounded mute set and refuses a malformed one', async () => {
    const { muted, dispose } = setup();
    const set = ipcHandlers.get(PC_RAIL_IPC.MUTES_SET)!;
    await set({}, { hostIds: ['h1', 'h1', 7, 'h2'] });
    expect(muted.at(-1)).toEqual(['h1', 'h2']);
    expect(isPcRailHostMuted('h1')).toBe(true);
    await expect(set({}, { hostIds: 'h1' })).rejects.toThrow();
    const approvals = ipcHandlers.get(PC_RAIL_IPC.APPROVALS_LIST)!;
    expect(await approvals({}, { hostId: 'unknown' })).toEqual({ ok: false, reason: 'unavailable' });
    dispose();
  });
});
