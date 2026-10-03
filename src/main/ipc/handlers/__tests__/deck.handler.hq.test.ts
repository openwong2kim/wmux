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

import fs from 'node:fs';
import { registerDeckHandler } from '../deck.handler';
import { IPC } from '../../../../shared/constants';
import type { BrainAdapter, BrainEvent } from '../../../deck/BrainAdapter';
import { CommanderEventCoalescer } from '../../../deck/CommanderEventCoalescer';
import { GlobalTurnGate } from '../../../deck/globalTurnGate';
import { eventBus } from '../../../events/EventBus';
import { getWorkspaceMirror, __resetWorkspaceMirrorForTest } from '../../../workspace/WorkspaceMirror';
import {
  __resetHqMemoryForTest,
  getDeckHqPath,
  getHqWorkspaceId,
  isMoaEnabled,
  setHqWorkspaceId,
  setMoaEnabled,
} from '../../../deck/deckHqStore';
import { raiseDecision } from '../../../deck/deckDecisionStore';
import { getTaskLedger } from '../../../deck/taskLedgerHost';
import { __resetStartupDeckReconcileForTest } from '../../../deck/deckOrphanReconcile';
import { mintCommanderToken } from '../../../deck/commanderTrust';
import { registerBrainPty } from '../../../deck/brainPtyHookBus';

class FakeAdapter implements BrainAdapter {
  sessionId: string | null = null;
  disposed = false;
  constructor(public readonly workspaceId: string) {
    // Every production adapter mints a commander token at construction.
    mintCommanderToken(workspaceId);
  }
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

function register(opts: { production?: boolean; turnGate?: GlobalTurnGate; reconcileDelayMs?: number } = {}): void {
  cleanup = registerDeckHandler(() => fakeWindow, {
    ...(opts.production ? {} : {
      createAdapter: (o: { workspaceId: string }) => {
        const a = new FakeAdapter(o.workspaceId);
        adapters.push(a);
        return a;
      },
    }),
    ...(opts.turnGate ? { turnGate: opts.turnGate } : {}),
    ...(opts.reconcileDelayMs !== undefined ? { reconcileDelayMs: opts.reconcileDelayMs } : {}),
  } as Parameters<typeof registerDeckHandler>[1]);
}
function reregister(opts: Parameters<typeof register>[0] = {}): void {
  cleanup?.();
  cleanup = null;
  heartbeats.length = 0;
  schedulers.length = 0;
  register(opts);
}

const invoke = (channel: string, payload?: unknown) => captured.get(channel)!({}, payload) as Promise<Record<string, unknown>>;
const send = (workspaceId: string) => invoke(IPC.DECK_SEND, { workspaceId, text: 'hi' });
const lifecycle = (workspaceId: string) => eventBus.emit({
  type: 'agent.lifecycle', workspaceId, ptyId: `p-${workspaceId}`,
  kind: 'agent.stop', source: 'hook', agent: 'claude', decision: 'emit',
});
const a2aDone = (from: string) => eventBus.emit({
  type: 'a2a.task', workspaceId: from, from, to: 'ws-a', taskId: `task-${from}`, state: 'completed',
});
const mirror = (ids: string[]) => getWorkspaceMirror().setSnapshot({
  ts: Date.now(),
  entries: ids.map((id) => ({ id, name: id })),
  fleets: [],
  sessionRestored: true,
});
const heartbeatTargets = () => (heartbeats.at(-1)!.deps.getWorkspaceIds as () => string[])();
const scheduledTurn = (ws: string) =>
  (schedulers.at(-1)!.deps.runTurn as (p: string, w: string) => Promise<Record<string, unknown>>)('scheduled', ws);
const busSubscribers = (): number => (eventBus as unknown as { subscribers: unknown[] }).subscribers.length;
const mirrorListeners = (): number =>
  (getWorkspaceMirror() as unknown as { snapshotListeners: Set<unknown> }).snapshotListeners.size;
const flush = () => new Promise((r) => setTimeout(r, 0));

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
  __resetHqMemoryForTest();
  __resetStartupDeckReconcileForTest();
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  await setHqWorkspaceId(null);
  await setMoaEnabled(true);
  vi.mocked(mintCommanderToken).mockClear();
  vi.mocked(registerBrainPty).mockClear();
  pushSpy = vi.spyOn(CommanderEventCoalescer.prototype, 'push');
  bootSpy = vi.spyOn(CommanderEventCoalescer.prototype, 'notifyBrainBooted');
  register();
});

afterEach(() => {
  cleanup?.();
  cleanup = null;
  vi.useRealTimers();
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

  it('DECK_STATUS carries no hq field, the timers run, and there is no turn cap', async () => {
    expect(await invoke(IPC.DECK_STATUS, { workspaceId: 'ws-a' })).toEqual({ status: 'idle', sessionId: null });
    expect(await invoke(IPC.DECK_HQ_GET)).toEqual({ workspaceId: null, state: 'unset' });
    expect(heartbeats.at(-1)!.starts).toBe(1);
    expect(schedulers.at(-1)!.starts).toBe(1);
    for (let i = 0; i < 15; i++) expect(await scheduledTurn('ws-a')).toMatchObject({ ok: true });
  });
});

describe('HQ designated — eligibility matrix', () => {
  beforeEach(async () => {
    await setHqWorkspaceId('ws-hq');
    mirror(['ws-hq', 'ws-a', 'ws-b']);
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

  it('heartbeat reviews only the HQ', () => {
    expect(heartbeatTargets()).toEqual(['ws-hq']);
  });

  it('mode-change replay boots only the HQ', async () => {
    bootSpy.mockClear();
    await invoke(IPC.DECK_MODE_SET, { workspaceId: 'ws-a', mode: 'assist' });
    expect(bootSpy).not.toHaveBeenCalled();
    await invoke(IPC.DECK_MODE_SET, { workspaceId: 'ws-hq', mode: 'assist' });
    expect(bootSpy).toHaveBeenCalledWith('ws-hq');
  });

  it('excludes the HQ\'s own pane events but still pushes a2a terminal events to it', () => {
    lifecycle('ws-hq');
    lifecycle('ws-a');
    a2aDone('ws-hq');
    expect(pushedTo().map((e) => [e.workspaceId, e.kind])).toEqual([
      ['ws-a', 'agent.stop'],
      ['ws-hq', 'a2a.completed'],
    ]);
  });

  it('refuses creating or enabling a non-HQ schedule or loop', async () => {
    const at = Date.now() + 60_000;
    expect(await invoke(IPC.DECK_SCHEDULES_CREATE, { workspaceId: 'ws-a', prompt: 'p', nextRunAt: at }))
      .toEqual({ ok: false, code: 'not_hq' });
    expect(await invoke(IPC.DECK_LOOP_START, { workspaceId: 'ws-a', objective: 'o' }))
      .toEqual({ ok: false, code: 'not_hq' });
    expect(await invoke(IPC.DECK_SCHEDULES_CREATE, { workspaceId: 'ws-hq', prompt: 'p', nextRunAt: at }))
      .toMatchObject({ ok: true });
  });
});

describe('HQ turn cap (common entry for automatic turns)', () => {
  it('caps the HQ\'s scheduled turns per hour, keeps them retryable, and never caps a human send', async () => {
    await setHqWorkspaceId('ws-hq');
    mirror(['ws-hq', 'ws-a']);
    const file = JSON.parse(fs.readFileSync(getDeckHqPath(), 'utf8'));
    fs.writeFileSync(getDeckHqPath(), JSON.stringify({ ...file, hqMaxTurnsPerHour: 1 }));

    expect(await scheduledTurn('ws-hq')).toMatchObject({ ok: true });
    const capped = await scheduledTurn('ws-hq');
    expect(capped).toMatchObject({ ok: false, code: 'rate_limited' });
    expect(capped.retryAfterMs as number).toBeGreaterThan(59 * 60_000);
    expect(await scheduledTurn('ws-hq')).toMatchObject({ code: 'rate_limited' });
    // Human sends (composer and the Wake button) are never capped.
    expect(await send('ws-hq')).toMatchObject({ ok: true });
    expect(await invoke(IPC.DECK_WAKE, { workspaceId: 'ws-hq' })).toMatchObject({ ok: true });
  });
});

describe('queued turns re-check eligibility after the slot wait', () => {
  async function queueResumeTurn(gate: GlobalTurnGate): Promise<string> {
    const held = gate.tryAcquire('other')!;
    const d = await raiseDecision('ws-hq', { question: 'q', options: [], context: '' });
    await invoke(IPC.DECK_DECISION_RESOLVE, { workspaceId: 'ws-hq', id: d!.id, resolution: 'go' });
    await flush();
    return held;
  }

  it.each([
    ['the master switch goes off', async () => { await invoke(IPC.DECK_MOA_SET, { enabled: false }); }],
    ['the HQ moves elsewhere', async () => { await setHqWorkspaceId('ws-b'); }],
  ] as const)('no brain is spawned and no token minted when %s during the wait', async (_label, change) => {
    // A gate whose cancelWaiters does nothing, so the re-check itself is what is tested.
    class StickyGate extends GlobalTurnGate {
      override cancelWaiters(): void { /* keep the waiter */ }
    }
    const gate = new StickyGate(1);
    await setHqWorkspaceId('ws-hq');
    reregister({ turnGate: gate });
    mirror(['ws-hq', 'ws-b']);
    const held = await queueResumeTurn(gate);
    const before = adapters.length;
    const mintsBefore = vi.mocked(mintCommanderToken).mock.calls.length;

    await change();
    gate.release(held);
    await flush();
    await flush();

    expect(adapters.length - before).toBe(0);
    expect(vi.mocked(mintCommanderToken).mock.calls.length - mintsBefore).toBe(0);
    expect(gate.inFlight).toBe(0);
  });

  it('turning the switch off cancels the queued waiters', async () => {
    const gate = new GlobalTurnGate(1);
    await setHqWorkspaceId('ws-hq');
    reregister({ turnGate: gate });
    mirror(['ws-hq']);
    const cancel = vi.spyOn(gate, 'cancelWaiters');
    await queueResumeTurn(gate);
    await invoke(IPC.DECK_MOA_SET, { enabled: false });
    expect(cancel).toHaveBeenCalled();
  });
});

describe('HQ designation retires other brains', () => {
  it('an idle brain does not block it; every non-HQ brain is retired, the HQ\'s kept', async () => {
    mirror(['ws-a', 'ws-hq']);
    await send('ws-a');
    await send('ws-hq');
    expect(await setHqWorkspaceId('ws-hq')).toMatchObject({ ok: true });
    expect(adapters.map((a) => [a.workspaceId, a.disposed])).toEqual([['ws-a', true], ['ws-hq', false]]);
    expect(clearedSessions).toEqual([]); // reversible: no session file touched
  });
});

describe('HQ presence', () => {
  it('unknown before the first mirror push: the HQ does not run yet', async () => {
    await setHqWorkspaceId('ws-hq');
    expect(await send('ws-hq')).toEqual({ ok: false, code: 'hq_unknown' });
    expect(await invoke(IPC.DECK_HQ_GET)).toEqual({ workspaceId: 'ws-hq', state: 'hq-unknown' });
    mirror(['ws-hq']);
    expect(await send('ws-hq')).toMatchObject({ ok: true });
  });

  it('missing: retired on the mirror update itself (no heartbeat), fails closed, parks its receipts', async () => {
    await setHqWorkspaceId('ws-hq');
    mirror(['ws-hq', 'ws-a']);
    await send('ws-hq');
    const park = vi.spyOn(getTaskLedger(), 'recordOrphanedEvent');
    mirror(['ws-a']);

    expect(adapters[0].disposed).toBe(true); // the heartbeat is mocked and never ticked
    expect(heartbeatTargets()).toEqual([]);
    expect(await send('ws-hq')).toEqual({ ok: false, code: 'hq_missing' });
    expect(await send('ws-a')).toEqual({ ok: false, code: 'not_hq' });
    expect(await invoke(IPC.DECK_STATUS, { workspaceId: 'ws-a' })).toMatchObject({ hq: 'hq-missing' });
    expect(await invoke(IPC.DECK_HQ_GET)).toEqual({ workspaceId: 'ws-hq', state: 'hq-missing' });
    lifecycle('ws-a');
    expect(routedHasBrain!('ws-hq')).toBe(false);

    pushSpy.mockClear();
    a2aDone('ws-hq');
    expect(pushedTo()).toEqual([]);
    expect(park).toHaveBeenCalledWith(expect.objectContaining({ ownerWorkspaceId: 'ws-hq' }));

    // Back again: the parked events are replayed.
    bootSpy.mockClear();
    mirror(['ws-hq', 'ws-a']);
    expect(bootSpy).toHaveBeenCalledWith('ws-hq');
  });
});

describe('master switch (moaEnabled)', () => {
  it('defaults to on', async () => {
    expect(await invoke(IPC.DECK_MOA_GET)).toEqual({ enabled: true });
  });

  // The timer count is the handler's own timers (ledger/orphan reconcile, the
  // one-shot reconcile, coalescer and gate timers). DeckHeartbeat and
  // DeckScheduler are mocked in this harness, so theirs are asserted through
  // `starts === 0` instead; their own suites cover start() arming an interval.
  it('off at launch: no timer, subscription, brain, token or hook; nothing eligible', async () => {
    cleanup?.();
    cleanup = null;
    await setMoaEnabled(false);
    vi.useFakeTimers();
    const subsBefore = busSubscribers();
    const listenersBefore = mirrorListeners();
    reregister({ production: true });
    expect(vi.getTimerCount()).toBe(0);
    expect(busSubscribers()).toBe(subsBefore);
    expect(mirrorListeners()).toBe(listenersBefore);
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
    // The bus is not even subscribed, so nothing routes or wakes.
    lifecycle('ws-a');
    expect(pushedTo()).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('turning it on starts everything and re-arms the startup reconcile once; off tears it all down', async () => {
    cleanup?.();
    cleanup = null;
    await setMoaEnabled(false);
    vi.useFakeTimers();
    const subsBefore = busSubscribers();
    reregister({ reconcileDelayMs: 1234 });

    await invoke(IPC.DECK_MOA_SET, { enabled: true });
    expect(busSubscribers()).toBe(subsBefore + 1);
    expect(mirrorListeners()).toBe(1);
    const armed = vi.getTimerCount(); // ledger reconcile + orphan reconcile + one-shot reconcile
    expect(armed).toBe(3);

    await invoke(IPC.DECK_MOA_SET, { enabled: false });
    expect(vi.getTimerCount()).toBe(0);
    expect(busSubscribers()).toBe(subsBefore);
    expect(mirrorListeners()).toBe(0);

    // Not fired yet → re-armed by the next on; once fired → never again.
    // (reconcileDelayMs = 1234 identifies the one-shot among the timers.)
    const oneShots = vi.spyOn(globalThis, 'setTimeout');
    const reconcileArms = () => oneShots.mock.calls.filter((c) => c[1] === 1234).length;
    await invoke(IPC.DECK_MOA_SET, { enabled: true });
    expect(vi.getTimerCount()).toBe(3);
    expect(reconcileArms()).toBe(1);
    await vi.advanceTimersByTimeAsync(1234);
    await invoke(IPC.DECK_MOA_SET, { enabled: false });
    await invoke(IPC.DECK_MOA_SET, { enabled: true });
    expect(reconcileArms()).toBe(1);
  });

  it('turning it off retires a running brain; on restores, replays parked events, deletes nothing', async () => {
    mirror(['ws-a']);
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

    bootSpy.mockClear();
    expect(await invoke(IPC.DECK_MOA_SET, { enabled: true })).toEqual({ ok: true, enabled: true });
    expect([hb.starts, sc.starts]).toEqual([2, 2]);
    expect(bootSpy).toHaveBeenCalledWith('ws-a');
    expect(clearedSessions).toEqual([]);
    expect(mockMode).toBe('danger');
    expect(await send('ws-a')).toMatchObject({ ok: true });
  });

  it('rejects a non-boolean value', async () => {
    expect(await invoke(IPC.DECK_MOA_SET, { enabled: 'no' })).toEqual({ ok: false });
    expect(isMoaEnabled()).toBe(true);
  });
});
