// The HQ gate and the master switch at the four brain-eligibility sites of the
// deck handler: turn entry, hasBrain (worker-event routing), heartbeat targets
// and the mode-change replay — plus the HQ's own pane events at the coalescer
// push site, hq-missing, and the master switch's runtime teardown.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const captured = new Map<string, (...args: unknown[]) => unknown>();

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, fn: (...args: unknown[]) => unknown) => {
      captured.set(channel, fn);
    }),
    removeHandler: vi.fn((channel: string) => captured.delete(channel)),
  },
  app: { once: vi.fn(), removeListener: vi.fn() },
}));

const clearedSessions: string[] = [];
vi.mock('../../../deck/commanderSessionStore', () => ({
  loadCommanderSession: vi.fn(() => null),
  saveCommanderSession: vi.fn(async () => undefined),
  clearCommanderSession: vi.fn(async (key: string) => {
    clearedSessions.push(key);
  }),
}));

vi.mock('../../../deck/deckPolicy', () => ({
  loadDeckPolicyBlock: vi.fn(() => null),
  ensureDeckPolicySeed: vi.fn(() => undefined),
  getDeckPolicyPath: vi.fn(() => '/fake/deck-policy.md'),
}));

let mockMode: 'off' | 'assist' | 'danger' = 'danger';
vi.mock('../../../deck/deckAutonomyStore', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../deck/deckAutonomyStore')>();
  return {
    ...actual,
    loadWorkspaceAutonomy: vi.fn(() => ({ mode: mockMode, ...actual.modeToCaps(mockMode) })),
    loadWorkspaceMode: vi.fn(() => mockMode),
    setWorkspaceMode: vi.fn(async (_ws: string, mode: 'off' | 'assist' | 'danger') => {
      mockMode = mode;
      return { mode, wakePolicy: 'all', ...actual.modeToCaps(mode) };
    }),
    setWorkspaceAutonomy: vi.fn(async () => ({})),
  };
});

// Timers: record start/stop instead of running intervals.
interface FakeTimerOwner {
  deps: Record<string, unknown>;
  starts: number;
  stops: number;
}
const heartbeats: FakeTimerOwner[] = [];
const schedulers: FakeTimerOwner[] = [];
vi.mock('../../../deck/DeckHeartbeat', () => ({
  DeckHeartbeat: class {
    starts = 0;
    stops = 0;
    constructor(public deps: Record<string, unknown>) {
      heartbeats.push(this);
    }
    start(): void { this.starts += 1; }
    stop(): void { this.stops += 1; }
  },
}));
vi.mock('../../../deck/DeckScheduler', () => ({
  DeckScheduler: class {
    starts = 0;
    stops = 0;
    constructor(public deps: Record<string, unknown>) {
      schedulers.push(this);
    }
    start(): void { this.starts += 1; }
    stop(): void { this.stops += 1; }
  },
}));

// hasBrain is read by the worker-event router; capture its ports.
let routedHasBrain: ((owner: string) => boolean) | null = null;
vi.mock('../../../deck/taskLedgerHost', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../deck/taskLedgerHost')>();
  return {
    ...actual,
    routeWorkerEventToOwner: vi.fn((_ev: unknown, ports: { hasBrain: (o: string) => boolean }) => {
      routedHasBrain = ports.hasBrain;
    }),
  };
});

vi.mock('../../../deck/commanderTrust', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../deck/commanderTrust')>();
  return { ...actual, mintCommanderToken: vi.fn(actual.mintCommanderToken) };
});
vi.mock('../../../deck/brainPtyHookBus', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../deck/brainPtyHookBus')>();
  return { ...actual, registerBrainPty: vi.fn(actual.registerBrainPty) };
});

import { registerDeckHandler } from '../deck.handler';
import { IPC } from '../../../../shared/constants';
import type { BrainAdapter, BrainEvent } from '../../../deck/BrainAdapter';
import { CommanderEventCoalescer } from '../../../deck/CommanderEventCoalescer';
import { eventBus } from '../../../events/EventBus';
import { getWorkspaceMirror, __resetWorkspaceMirrorForTest } from '../../../workspace/WorkspaceMirror';
import {
  __resetHqMirrorMemoryForTest,
  getHqWorkspaceId,
  isMoaEnabled,
  setHqWorkspaceId,
  setMoaEnabled,
} from '../../../deck/deckHqStore';
import { mintCommanderToken } from '../../../deck/commanderTrust';
import { registerBrainPty } from '../../../deck/brainPtyHookBus';

class FakeAdapter implements BrainAdapter {
  sessionId: string | null = null;
  disposed = false;
  constructor(public readonly workspaceId: string) {}
  start(): void { /* nothing to start */ }
  async *send(): AsyncIterable<BrainEvent> {
    yield { type: 'turn-end', sessionId: 'sess-1' } as BrainEvent;
  }
  interrupt(): void { /* no in-flight turn */ }
  dispose(): void { this.disposed = true; }
}

let adapters: FakeAdapter[];
let cleanup: (() => void) | null = null;
const fakeWindow = {
  isDestroyed: () => false,
  webContents: { send: () => undefined },
} as unknown as import('electron').BrowserWindow;

function register(withFactory = true): void {
  cleanup = registerDeckHandler(() => fakeWindow, withFactory
    ? {
      createAdapter: (opts) => {
        const a = new FakeAdapter(opts.workspaceId);
        adapters.push(a);
        return a;
      },
    }
    : {});
}

const invoke = (channel: string, payload?: unknown) => captured.get(channel)!({}, payload) as Promise<Record<string, unknown>>;
const send = (workspaceId: string) => invoke(IPC.DECK_SEND, { workspaceId, text: 'hi' });
const lifecycle = (workspaceId: string) => eventBus.emit({
  type: 'agent.lifecycle', workspaceId, ptyId: `p-${workspaceId}`,
  kind: 'agent.stop', source: 'hook', agent: 'claude', decision: 'emit',
});
const mirror = (ids: string[]) => getWorkspaceMirror().setSnapshot({
  ts: Date.now(),
  entries: ids.map((id) => ({ id, name: id })),
  fleets: [],
  sessionRestored: true,
});
const heartbeatTargets = () => (heartbeats.at(-1)!.deps.getWorkspaceIds as () => string[])();

let pushSpy: ReturnType<typeof vi.spyOn>;
let bootSpy: ReturnType<typeof vi.spyOn>;
const pushedTo = (): { workspaceId: string; kind: string }[] =>
  (pushSpy.mock.calls as unknown[][]).map((c) => c[0] as { workspaceId: string; kind: string });

beforeEach(async () => {
  cleanup?.();
  cleanup = null;
  captured.clear();
  adapters = [];
  heartbeats.length = 0;
  schedulers.length = 0;
  clearedSessions.length = 0;
  routedHasBrain = null;
  mockMode = 'danger';
  __resetWorkspaceMirrorForTest();
  __resetHqMirrorMemoryForTest();
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  await setHqWorkspaceId(null);
  await setMoaEnabled(true);
  vi.mocked(mintCommanderToken).mockClear();
  vi.mocked(registerBrainPty).mockClear();
  pushSpy = vi.spyOn(CommanderEventCoalescer.prototype, 'push');
  bootSpy = vi.spyOn(CommanderEventCoalescer.prototype, 'notifyBrainBooted');
  register();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('HQ unset — today\'s behaviour', () => {
  it('every workspace may run a brain at all four sites', async () => {
    expect(getHqWorkspaceId()).toBeNull();
    expect(await send('ws-a')).toMatchObject({ ok: true });
    expect(await send('ws-b')).toMatchObject({ ok: true });
    expect(adapters.map((a) => a.workspaceId)).toEqual(['ws-a', 'ws-b']);

    lifecycle('ws-a');
    expect(pushedTo().map((e) => e.workspaceId)).toEqual(['ws-a']);
    expect(routedHasBrain!('ws-c')).toBe(true);
    expect(heartbeatTargets().sort()).toEqual(['ws-a', 'ws-b']);
    await invoke(IPC.DECK_MODE_SET, { workspaceId: 'ws-c', mode: 'assist' });
    expect(bootSpy).toHaveBeenCalledWith('ws-c');
  });

  it('DECK_STATUS carries no hq field and the timers are running', async () => {
    expect(await invoke(IPC.DECK_STATUS, { workspaceId: 'ws-a' })).toEqual({ status: 'idle', sessionId: null });
    expect(await invoke(IPC.DECK_HQ_GET)).toEqual({ workspaceId: null, state: 'unset' });
    expect(heartbeats.at(-1)!.starts).toBe(1);
    expect(schedulers.at(-1)!.starts).toBe(1);
  });
});

describe('HQ designated — eligibility matrix', () => {
  beforeEach(async () => {
    await setHqWorkspaceId('ws-hq');
  });

  it('turn entry: a non-HQ workspace never starts a brain, the HQ does', async () => {
    expect(await send('ws-a')).toEqual({ ok: false, code: 'not_hq' });
    expect(await invoke(IPC.DECK_WAKE, { workspaceId: 'ws-a' })).toEqual({ ok: false, code: 'not_hq' });
    expect(adapters).toHaveLength(0);
    expect(await send('ws-hq')).toMatchObject({ ok: true });
    expect(adapters.map((a) => a.workspaceId)).toEqual(['ws-hq']);
  });

  it('hasBrain: a non-HQ owner parks its worker events, the HQ receives them', () => {
    lifecycle('ws-a');
    expect(routedHasBrain!('ws-a')).toBe(false);
    expect(routedHasBrain!('ws-hq')).toBe(true);
  });

  it('heartbeat reviews only the HQ', async () => {
    mirror(['ws-hq', 'ws-a', 'ws-b']);
    expect(heartbeatTargets()).toEqual(['ws-hq']);
  });

  it('mode-change replay boots only the HQ', async () => {
    await invoke(IPC.DECK_MODE_SET, { workspaceId: 'ws-a', mode: 'assist' });
    expect(bootSpy).not.toHaveBeenCalled();
    await invoke(IPC.DECK_MODE_SET, { workspaceId: 'ws-hq', mode: 'assist' });
    expect(bootSpy).toHaveBeenCalledWith('ws-hq');
  });

  it('excludes the HQ\'s own pane events but still pushes a2a terminal events to it', () => {
    lifecycle('ws-hq');
    lifecycle('ws-a');
    eventBus.emit({
      type: 'a2a.task', workspaceId: 'ws-hq', from: 'ws-hq', to: 'ws-a',
      taskId: 'task-1', state: 'completed',
    });
    expect(pushedTo().map((e) => [e.workspaceId, e.kind])).toEqual([
      ['ws-a', 'agent.stop'],
      ['ws-hq', 'a2a.completed'],
    ]);
  });
});

describe('HQ designation retires other brains', () => {
  it('refuses while the new HQ has a brain, then retires every non-HQ brain', async () => {
    await send('ws-a');
    await send('ws-hq');
    expect(await setHqWorkspaceId('ws-hq')).toMatchObject({ ok: false, code: 'brain_running' });
    // Free the HQ, then designate.
    await invoke(IPC.DECK_MODE_SET, { workspaceId: 'ws-hq', mode: 'off' });
    mockMode = 'danger';
    expect(await setHqWorkspaceId('ws-hq')).toMatchObject({ ok: true });
    expect(adapters.map((a) => [a.workspaceId, a.disposed])).toEqual([['ws-a', true], ['ws-hq', true]]);
    expect(clearedSessions).toEqual([]); // reversible: no session file touched
  });
});

describe('hq-missing', () => {
  it('fails closed: the HQ brain stops, nobody else becomes eligible, status reports it', async () => {
    await setHqWorkspaceId('ws-hq');
    await send('ws-hq');
    mirror(['ws-a']);

    expect(heartbeatTargets()).toEqual([]);
    expect(adapters[0].disposed).toBe(true);
    expect(await send('ws-hq')).toEqual({ ok: false, code: 'hq_missing' });
    expect(await send('ws-a')).toEqual({ ok: false, code: 'not_hq' });
    expect(await invoke(IPC.DECK_STATUS, { workspaceId: 'ws-a' })).toMatchObject({ hq: 'hq-missing' });
    expect(await invoke(IPC.DECK_HQ_GET)).toEqual({ workspaceId: 'ws-hq', state: 'hq-missing' });
    // Worker events owned by the missing HQ park instead of being consumed.
    lifecycle('ws-a');
    expect(routedHasBrain!('ws-hq')).toBe(false);
  });
});

describe('master switch (moaEnabled)', () => {
  it('defaults to on', async () => {
    expect(await invoke(IPC.DECK_MOA_GET)).toEqual({ enabled: true });
  });

  it('off at launch: no timers started, no brain of any vendor, nothing eligible, pushes dropped', async () => {
    cleanup?.();
    cleanup = null;
    await setMoaEnabled(false);
    heartbeats.length = 0;
    schedulers.length = 0;
    register(false); // the production adapter factory
    expect(heartbeats.at(-1)!.starts).toBe(0);
    expect(schedulers.at(-1)!.starts).toBe(0);

    for (const vendor of ['claude', 'claude-pty', 'hermes']) {
      await invoke(IPC.DECK_BRAIN_VENDOR_SET, { vendor });
      expect(await send('ws-a')).toEqual({ ok: false, code: 'moa_off' });
      expect(await invoke(IPC.DECK_WAKE, { workspaceId: 'ws-a' })).toEqual({ ok: false, code: 'moa_off' });
    }
    expect(mintCommanderToken).not.toHaveBeenCalled();
    expect(registerBrainPty).not.toHaveBeenCalled();
    expect(await invoke(IPC.DECK_STATUS, { workspaceId: 'ws-a' })).toEqual({ status: 'idle', sessionId: null });

    lifecycle('ws-a');
    expect(routedHasBrain!('ws-a')).toBe(false);
    await setHqWorkspaceId('ws-hq');
    expect(routedHasBrain!('ws-hq')).toBe(false);
    await invoke(IPC.DECK_MODE_SET, { workspaceId: 'ws-hq', mode: 'assist' });
    expect(bootSpy).not.toHaveBeenCalled();
  });

  it('turning it off retires a running brain and stops the timers; on restores them with nothing deleted', async () => {
    await send('ws-a');
    const hb = heartbeats.at(-1)!;
    const sc = schedulers.at(-1)!;
    const suspend = vi.spyOn(CommanderEventCoalescer.prototype, 'suspend');

    expect(await invoke(IPC.DECK_MOA_SET, { enabled: false })).toEqual({ ok: true, enabled: false });
    expect(isMoaEnabled()).toBe(false);
    expect(adapters[0].disposed).toBe(true);
    expect([hb.stops, sc.stops]).toEqual([1, 1]);
    expect(suspend).toHaveBeenCalledTimes(1);
    expect(await invoke(IPC.DECK_STATUS, { workspaceId: 'ws-a' })).toEqual({ status: 'idle', sessionId: null });

    expect(await invoke(IPC.DECK_MOA_SET, { enabled: true })).toEqual({ ok: true, enabled: true });
    expect([hb.starts, sc.starts]).toEqual([2, 2]);
    expect(clearedSessions).toEqual([]);
    expect(mockMode).toBe('danger');
    expect(await send('ws-a')).toMatchObject({ ok: true });
  });

  it('rejects a non-boolean value', async () => {
    expect(await invoke(IPC.DECK_MOA_SET, { enabled: 'no' })).toEqual({ ok: false });
    expect(isMoaEnabled()).toBe(true);
  });
});
