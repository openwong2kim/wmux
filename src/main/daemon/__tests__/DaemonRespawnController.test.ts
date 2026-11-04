import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import {
  DaemonRespawnController,
  type DaemonRespawnDeps,
  type DaemonReplacementHooks,
  type RespawnEvent,
} from '../DaemonRespawnController';
import type { DaemonClient } from '../../DaemonClient';
import type { DaemonInfo } from '../launcher';
import { LaunchdJobQueuedError, QUEUED_JOB_ADOPT_MS } from '../../../shared/daemon/launchdDaemonJob';

/**
 * Minimal stub mirroring the parts of `DaemonClient` the controller
 * touches: `connect()`, `disconnect()`, `disconnectSync()`, `rpc()`,
 * `isConnected`, and the `disconnected` event. Per-test scripted
 * behavior keeps the fixtures focused on the controller's logic
 * rather than on the named-pipe transport.
 */
class FakeDaemonClient extends EventEmitter {
  connected = false;
  connectImpl: () => Promise<boolean> = async () => {
    this.connected = true;
    return true;
  };
  rpcImpl: (method: string, params: unknown, opts?: { timeoutMs?: number }) => Promise<unknown> =
    async () => ({});
  disconnectCalls = 0;
  disconnectSyncCalls = 0;
  resubscribeCalls = 0;
  /** What the daemon answers a resubscribe: accepted (default) or refused. */
  resubscribeImpl: () => Promise<boolean> = async () => true;

  async resubscribeEvents(): Promise<boolean> {
    this.resubscribeCalls++;
    return this.resubscribeImpl();
  }

  get isConnected(): boolean {
    return this.connected;
  }

  async connect(): Promise<boolean> {
    return this.connectImpl();
  }

  async rpc(method: string, params: unknown = {}, opts?: { timeoutMs?: number }): Promise<unknown> {
    return this.rpcImpl(method, params, opts);
  }

  async disconnect(): Promise<void> {
    this.disconnectCalls++;
    this.connected = false;
  }

  disconnectSync(): void {
    this.disconnectSyncCalls++;
    this.connected = false;
  }

  /** Helper for tests: simulate the socket-close path. */
  fireDisconnect(): void {
    this.connected = false;
    this.emit('disconnected');
  }
}

interface Harness {
  controller: DaemonRespawnController;
  events: RespawnEvent[];
  deps: DaemonRespawnDeps;
  logs: { level: string; msg: string }[];
  ensureDaemonCalls: number;
  /** Queue of clients handed out by `createClient`. Push more before each
   *  expected respawn so the test controls each generation's behavior. */
  clientQueue: FakeDaemonClient[];
  /** All clients ever created, in order — useful for asserting cleanup. */
  allClients: FakeDaemonClient[];
}

function makeHarness(
  opts: {
    ensureDaemonImpl?: () => Promise<DaemonInfo>;
    config?: Parameters<typeof buildController>[1];
    replacement?: DaemonReplacementHooks;
    watchDaemonExit?: DaemonRespawnDeps['watchDaemonExit'];
    sampleDaemon?: DaemonRespawnDeps['sampleDaemon'];
  } = {},
): Harness {
  const logs: { level: string; msg: string }[] = [];
  const events: RespawnEvent[] = [];
  const clientQueue: FakeDaemonClient[] = [];
  const allClients: FakeDaemonClient[] = [];
  let ensureCalls = 0;

  const deps: DaemonRespawnDeps = {
    ensureDaemon: async () => {
      ensureCalls++;
      if (opts.ensureDaemonImpl) return opts.ensureDaemonImpl();
      return { pid: 1234, authToken: 'tok', pipeName: 'pipe', spawned: true };
    },
    createClient: () => {
      const next = clientQueue.shift();
      if (!next) throw new Error('Test harness: createClient called but queue empty');
      allClients.push(next);
      return next as unknown as DaemonClient;
    },
    onInstall: vi.fn(async () => { /* no-op stub */ }),
    onUninstall: vi.fn(() => { /* no-op stub */ }),
    emit: (event) => { events.push(event); },
    logger: {
      info: (msg) => { logs.push({ level: 'info', msg }); },
      warn: (msg) => { logs.push({ level: 'warn', msg }); },
      error: (msg) => { logs.push({ level: 'error', msg }); },
    },
    replacement: opts.replacement,
    watchDaemonExit: opts.watchDaemonExit,
    sampleDaemon: opts.sampleDaemon,
  };

  const controller = buildController(deps, opts.config);
  return {
    controller,
    events,
    deps,
    logs,
    get ensureDaemonCalls() { return ensureCalls; },
    clientQueue,
    allClients,
  };
}

function buildController(
  deps: DaemonRespawnDeps,
  config?: ConstructorParameters<typeof DaemonRespawnController>[1],
) {
  return new DaemonRespawnController(deps, config);
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('DaemonRespawnController.bootstrap', () => {
  it('installs the client on successful initial connect', async () => {
    const h = makeHarness();
    const c1 = new FakeDaemonClient();
    h.clientQueue.push(c1);

    const result = await h.controller.bootstrap();
    expect(result).toBe(c1);
    expect(h.controller.isHealthy).toBe(true);
    expect(h.deps.onInstall).toHaveBeenCalledTimes(1);
    expect(h.deps.onUninstall).not.toHaveBeenCalled();
    // Initial bootstrap is NOT a reconnect — no `reconnected` event.
    expect(h.events).toEqual([]);
  });

  it('records the connected daemon pid from the connect-time ping, without asking again', async () => {
    const h = makeHarness({ config: { healthIntervalMs: 0 } });
    const c1 = new FakeDaemonClient();
    c1.rpcImpl = async () => ({ status: 'ok', pid: 5678 });
    h.clientQueue.push(c1);

    await h.controller.bootstrap();
    // A daemon too busy to answer later does not change what is known.
    c1.rpcImpl = async () => { throw new Error('RPC timeout: daemon.ping'); };
    expect(h.controller.connectedDaemonPid).toBe(5678);

    c1.fireDisconnect();
    expect(h.controller.connectedDaemonPid).toBeNull();
  });

  it('falls back to the launcher pid when the ping reports none', async () => {
    const h = makeHarness({ config: { healthIntervalMs: 0 } });
    const c1 = new FakeDaemonClient();
    h.clientQueue.push(c1);

    await h.controller.bootstrap();

    expect(h.controller.connectedDaemonPid).toBe(1234);
  });

  it('returns null and logs when control pipe connect fails', async () => {
    const h = makeHarness();
    const c1 = new FakeDaemonClient();
    c1.connectImpl = async () => false;
    h.clientQueue.push(c1);

    const result = await h.controller.bootstrap();
    expect(result).toBeNull();
    expect(h.controller.isHealthy).toBe(false);
    expect(h.deps.onInstall).not.toHaveBeenCalled();
    expect(h.logs.some((l) => l.level === 'warn' && l.msg.includes('connect failed'))).toBe(true);
  });

  it('enters the respawn loop when the first launch fails, and installs the daemon that comes up later', async () => {
    // After a reboot launchd started the daemon job ~45 s after its bootstrap;
    // the launch had given up after 5 s and nothing ever connected.
    let call = 0;
    const h = makeHarness({
      config: { baseBackoffMs: 100, healthIntervalMs: 0 },
      ensureDaemonImpl: async () => {
        if (++call === 1) throw new LaunchdJobQueuedError('com.wmux.daemon.x');
        return { pid: 1269, authToken: 't', pipeName: 'p', spawned: true };
      },
    });
    const c1 = new FakeDaemonClient();
    h.clientQueue.push(c1);

    expect(await h.controller.bootstrap()).toBeNull();
    expect(h.deps.onUninstall).toHaveBeenCalledTimes(1);
    expect(h.events).toEqual([{ type: 'reconnecting', attempt: 1, backoffMs: 100 }]);

    await vi.advanceTimersByTimeAsync(100);
    expect(h.controller.isHealthy).toBe(true);
    expect(h.deps.onInstall).toHaveBeenCalledTimes(1);
    expect(h.events[h.events.length - 1]).toEqual({ type: 'reconnected' });
  });

  it('returns null and disconnects when auth-ping fails', async () => {
    const h = makeHarness();
    const c1 = new FakeDaemonClient();
    c1.rpcImpl = async () => { throw new Error('unauthorized'); };
    h.clientQueue.push(c1);

    const result = await h.controller.bootstrap();
    expect(result).toBeNull();
    expect(c1.disconnectCalls).toBe(1);
    expect(h.deps.onInstall).not.toHaveBeenCalled();
  });
});

describe('DaemonRespawnController respawn loop', () => {
  it('schedules respawn on disconnect with exponential backoff', async () => {
    const h = makeHarness({
      config: { baseBackoffMs: 100, maxBackoffMs: 10_000, healthIntervalMs: 0 },
    });
    const c1 = new FakeDaemonClient();
    const c2 = new FakeDaemonClient();
    h.clientQueue.push(c1, c2);

    await h.controller.bootstrap();
    expect(h.controller.isHealthy).toBe(true);

    // Simulate socket close.
    c1.fireDisconnect();
    // The controller observes the close synchronously through the event
    // emitter, so the uninstall callback should fire before any timers.
    expect(h.deps.onUninstall).toHaveBeenCalledTimes(1);
    expect(h.controller.isHealthy).toBe(false);

    // First reconnecting event uses the initial backoff (100ms).
    expect(h.events).toEqual([{ type: 'reconnecting', attempt: 1, backoffMs: 100 }]);

    // Advance the scheduled timer and let the respawn complete.
    await vi.advanceTimersByTimeAsync(100);

    expect(h.ensureDaemonCalls).toBe(2); // bootstrap + 1 respawn
    expect(h.deps.onInstall).toHaveBeenCalledTimes(2);
    expect(h.events[h.events.length - 1]).toEqual({ type: 'reconnected' });
    expect(h.controller.isHealthy).toBe(true);
  });

  it('caps backoff at maxBackoffMs and retries on failures', async () => {
    const failingEnsure = vi.fn(async () => {
      throw new Error('spawn failed');
    });
    const h = makeHarness({
      ensureDaemonImpl: failingEnsure as unknown as () => Promise<DaemonInfo>,
      config: { baseBackoffMs: 100, maxBackoffMs: 500, budget: 5, healthIntervalMs: 0 },
    });

    // Bootstrap with a successful first client.
    const okEnsureOnce = vi.fn();
    const c1 = new FakeDaemonClient();
    h.clientQueue.push(c1);
    // Override deps.ensureDaemon temporarily so bootstrap succeeds.
    const realEnsure = h.deps.ensureDaemon;
    (h.deps as { ensureDaemon: () => Promise<DaemonInfo> }).ensureDaemon = async () => {
      okEnsureOnce();
      return { pid: 1, authToken: 't', pipeName: 'p', spawned: true };
    };
    await h.controller.bootstrap();
    (h.deps as { ensureDaemon: () => Promise<DaemonInfo> }).ensureDaemon = realEnsure;

    c1.fireDisconnect();

    // Walk through the backoff schedule. Expected: 100, 200, 400, 500, 500
    const expected = [100, 200, 400, 500, 500];
    for (let i = 0; i < expected.length; i++) {
      const evt = h.events.filter((e) => e.type === 'reconnecting').pop();
      expect(evt).toEqual({ type: 'reconnecting', attempt: i + 1, backoffMs: expected[i] });
      await vi.advanceTimersByTimeAsync(expected[i]);
    }

    // Budget exhausted on the 6th would-be attempt.
    const exhausted = h.events.find((e) => e.type === 'respawn-exhausted');
    expect(exhausted).toBeTruthy();
    // Every failed attempt threw "spawn failed" — that message must
    // travel out on `lastError` so main can show something meaningful
    // in the showErrorBox prompt instead of a generic "could not start".
    expect(exhausted).toMatchObject({ type: 'respawn-exhausted', lastError: 'spawn failed' });
    expect(h.controller.isHealthy).toBe(false);
  });

  it('clears lastError after a successful install', async () => {
    // If a transient failure during respawn is recovered, the captured
    // lastError must NOT linger. We can't observe the private field
    // directly, but we can observe the lifecycle: the only place
    // exhaustion fires is scheduleRespawn, which reads lastError at
    // that moment. So: drive one failure, recover, then walk the
    // budget to exhaustion with NEW failures — the surfaced lastError
    // must be the new one, not the original. This pins the contract
    // that lastError is cleared on install rather than persisting
    // across cycles.
    let throwMessage = 'first cycle error';
    let ensureFail = false;
    const ensureImpl = vi.fn(async () => {
      if (ensureFail) throw new Error(throwMessage);
      return { pid: 1, authToken: 't', pipeName: 'p', spawned: true };
    });
    const h = makeHarness({
      ensureDaemonImpl: ensureImpl as unknown as () => Promise<DaemonInfo>,
      // Big budget so the recovery cycle below doesn't graze the cap;
      // small backoff so each fake-timer step lands cleanly.
      config: { baseBackoffMs: 50, maxBackoffMs: 50, budget: 5, healthIntervalMs: 0, resetWindowMs: 10 },
    });

    const c1 = new FakeDaemonClient();
    const c2 = new FakeDaemonClient();
    h.clientQueue.push(c1, c2);
    await h.controller.bootstrap();

    // Cycle 1: fail once, then succeed on retry. lastError gets set
    // mid-cycle, then cleared inside install() when c2 comes up.
    ensureFail = true;
    c1.fireDisconnect();
    await vi.advanceTimersByTimeAsync(50); // attempt 1 — throws
    ensureFail = false;
    await vi.advanceTimersByTimeAsync(50); // attempt 2 — succeeds
    expect(h.controller.isHealthy).toBe(true);
    expect(h.events.find((e) => e.type === 'respawn-exhausted')).toBeUndefined();

    // Walk past resetWindowMs (10ms) so attemptCount drops back to 0
    // — otherwise the next cycle starts already at the budget cap
    // (we used 2 attempts above) and exhausts before any new error
    // can be captured.
    await vi.advanceTimersByTimeAsync(100);

    // Cycle 2: drain queue + replenish, switch the error message, then
    // fail every attempt until the budget exhausts. The surfaced
    // lastError must be the NEW message.
    while (h.clientQueue.length > 0) h.clientQueue.shift();
    for (let i = 0; i < 10; i++) h.clientQueue.push(new FakeDaemonClient());
    throwMessage = 'second cycle error';
    ensureFail = true;
    c2.fireDisconnect();
    // Walk through the entire budget — each attempt = backoff(50).
    for (let i = 0; i < 6; i++) {
      await vi.advanceTimersByTimeAsync(50);
    }
    const exhausted = h.events.find((e) => e.type === 'respawn-exhausted');
    expect(exhausted).toBeDefined();
    expect(exhausted).toMatchObject({
      type: 'respawn-exhausted',
      lastError: 'second cycle error',
    });
  });

  it('resets the attempt counter after sustained healthy uptime', async () => {
    const h = makeHarness({
      config: {
        baseBackoffMs: 100,
        maxBackoffMs: 10_000,
        healthIntervalMs: 0,
        resetWindowMs: 5000,
      },
    });
    const c1 = new FakeDaemonClient();
    const c2 = new FakeDaemonClient();
    const c3 = new FakeDaemonClient();
    h.clientQueue.push(c1, c2, c3);

    await h.controller.bootstrap();
    c1.fireDisconnect();
    await vi.advanceTimersByTimeAsync(100); // attempt 1 succeeds with c2
    expect(h.controller.isHealthy).toBe(true);

    // Cross the reset window threshold.
    await vi.advanceTimersByTimeAsync(5000);

    // Next disconnect should reset to attempt 1 (backoff 100ms), not 200ms.
    c2.fireDisconnect();
    const reconnecting = h.events.filter((e) => e.type === 'reconnecting');
    expect(reconnecting[reconnecting.length - 1]).toEqual({
      type: 'reconnecting',
      attempt: 1,
      backoffMs: 100,
    });
  });

  it('handles a disconnect from the newly installed client (not coalesced)', async () => {
    // Codex P2 (round 3, issue #54): if the respawned client dies inside
    // onInstall — before attemptRespawn's success log — the disconnect
    // event must NOT be silently coalesced into the prior respawn cycle.
    // Otherwise main is left wired to a dead pipe with no recovery.
    const h = makeHarness({
      config: { baseBackoffMs: 50, healthIntervalMs: 0, budget: 5 },
    });
    const c1 = new FakeDaemonClient();
    const c2 = new FakeDaemonClient();
    const c3 = new FakeDaemonClient();
    h.clientQueue.push(c1, c2, c3);

    // Make onInstall kill the new client synchronously (simulating the
    // freshly respawned daemon dying during handler swap).
    let installCount = 0;
    (h.deps.onInstall as unknown as { mockImplementation: (fn: (c: FakeDaemonClient) => Promise<void>) => void }).mockImplementation(
      async (client: FakeDaemonClient) => {
        installCount++;
        if (installCount === 2) {
          // The reconnect install — simulate the new daemon dying mid-install.
          client.fireDisconnect();
        }
      },
    );

    await h.controller.bootstrap();
    c1.fireDisconnect();
    await vi.advanceTimersByTimeAsync(50); // attempt 1 finishes install + immediately disconnects

    // onUninstall should have fired again for the dead c2, AND a new
    // respawn (attempt 2) should be scheduled with c3.
    expect(h.deps.onUninstall).toHaveBeenCalledTimes(2);
    const reconnecting = h.events.filter((e) => e.type === 'reconnecting');
    expect(reconnecting.length).toBe(2);

    // Let attempt 2 succeed with c3.
    await vi.advanceTimersByTimeAsync(100);
    expect(h.controller.isHealthy).toBe(true);
    expect(h.controller.getClient()).toBe(c3);
  });

  it('coalesces a re-entrant disconnect during respawn', async () => {
    const h = makeHarness({
      config: { baseBackoffMs: 1000, healthIntervalMs: 0 },
    });
    const c1 = new FakeDaemonClient();
    const c2 = new FakeDaemonClient();
    h.clientQueue.push(c1, c2);

    await h.controller.bootstrap();
    c1.fireDisconnect();

    // Fire a second disconnect while the backoff timer is still pending.
    // This shouldn't enqueue another attempt or double-fire uninstall.
    c1.fireDisconnect();
    expect(h.deps.onUninstall).toHaveBeenCalledTimes(1);
    const reconnecting = h.events.filter((e) => e.type === 'reconnecting');
    expect(reconnecting.length).toBe(1);
  });
});

describe('DaemonRespawnController health probe', () => {
  it('triggers respawn after consecutive ping failures', async () => {
    const h = makeHarness({
      config: {
        healthIntervalMs: 1000,
        healthTimeoutMs: 100,
        hangFailureThreshold: 3,
        baseBackoffMs: 50,
        budget: 5,
      },
    });
    const c1 = new FakeDaemonClient();
    const c2 = new FakeDaemonClient();
    h.clientQueue.push(c1, c2);

    // After bootstrap, pings start failing.
    let pingCalls = 0;
    c1.rpcImpl = async (method) => {
      if (method === 'daemon.ping') {
        pingCalls++;
        if (pingCalls === 1) return {}; // bootstrap auth ping succeeds
        throw new Error('ping timeout');
      }
      return {};
    };

    await h.controller.bootstrap();
    expect(h.controller.isHealthy).toBe(true);

    // 3 ping ticks → all fail → controller forces respawn.
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(1000);

    // The third failure should have triggered handleDisconnect; that fires
    // onUninstall and schedules a respawn.
    expect(h.deps.onUninstall).toHaveBeenCalled();
    expect(c1.disconnectSyncCalls).toBe(1);
    const reconnecting = h.events.find((e) => e.type === 'reconnecting');
    expect(reconnecting).toBeTruthy();

    // Advance the respawn backoff and verify recovery.
    await vi.advanceTimersByTimeAsync(50);
    expect(h.controller.isHealthy).toBe(true);
    expect(h.events.some((e) => e.type === 'reconnected')).toBe(true);
  });

  it('a busy-but-responsive daemon (pings succeed with high event-loop lag) is never respawned (RCA A4)', async () => {
    const h = makeHarness({
      config: { healthIntervalMs: 1000, healthTimeoutMs: 5000, baseBackoffMs: 50, budget: 5 },
    });
    const c1 = new FakeDaemonClient();
    h.clientQueue.push(c1);
    // Every ping SUCCEEDS but reports a lagging event loop (busy under load).
    c1.rpcImpl = async (method) =>
      method === 'daemon.ping' ? { status: 'ok', eventLoopLagMs: 4000 } : {};

    await h.controller.bootstrap();
    expect(h.controller.isHealthy).toBe(true);

    // Many ticks — a daemon that keeps answering is alive, never force-respawned.
    for (let i = 0; i < 10; i++) await vi.advanceTimersByTimeAsync(1000);

    expect(h.deps.onUninstall).not.toHaveBeenCalled();
    expect(c1.disconnectSyncCalls).toBe(0);
    expect(h.events.some((e) => e.type === 'reconnecting')).toBe(false);
    expect(h.controller.isHealthy).toBe(true);
  });

  it('subscribes again when a ping says the daemon dropped our event subscription', async () => {
    const h = makeHarness({
      config: { healthIntervalMs: 1000, healthTimeoutMs: 5000, baseBackoffMs: 50, budget: 5 },
    });
    const c1 = new FakeDaemonClient();
    h.clientQueue.push(c1);
    let subscribed = true;
    c1.rpcImpl = async (method) =>
      method === 'daemon.ping' ? { status: 'ok', eventsSubscribed: subscribed } : {};

    await h.controller.bootstrap();
    await vi.advanceTimersByTimeAsync(1000);
    expect(c1.resubscribeCalls).toBe(0);

    subscribed = false;
    await vi.advanceTimersByTimeAsync(1000);
    expect(c1.resubscribeCalls).toBe(1);
    // Still connected: a dropped subscription is not a hang.
    expect(c1.disconnectSyncCalls).toBe(0);
    expect(h.deps.onUninstall).not.toHaveBeenCalled();
  });

  it('asks the owner to resync once the dropped subscription is restored (#2263)', async () => {
    const h = makeHarness({
      config: { healthIntervalMs: 1000, healthTimeoutMs: 5000, baseBackoffMs: 50, budget: 5 },
    });
    const onEventsResubscribed = vi.fn();
    h.deps.onEventsResubscribed = onEventsResubscribed;
    const c1 = new FakeDaemonClient();
    h.clientQueue.push(c1);
    let subscribed = true;
    c1.rpcImpl = async (method) =>
      method === 'daemon.ping' ? { status: 'ok', eventsSubscribed: subscribed } : {};

    await h.controller.bootstrap();
    await vi.advanceTimersByTimeAsync(1000);
    expect(onEventsResubscribed).not.toHaveBeenCalled();

    subscribed = false;
    await vi.advanceTimersByTimeAsync(1000);
    expect(onEventsResubscribed).toHaveBeenCalledTimes(1);
    expect(onEventsResubscribed).toHaveBeenCalledWith(c1);

    subscribed = true;
    await vi.advanceTimersByTimeAsync(1000);
    expect(onEventsResubscribed).toHaveBeenCalledTimes(1);
  });

  it('resyncs only after a refused resubscribe is retried and accepted (#2469)', async () => {
    const h = makeHarness({
      config: { healthIntervalMs: 1000, healthTimeoutMs: 5000, baseBackoffMs: 50, budget: 5 },
    });
    const onEventsResubscribed = vi.fn();
    h.deps.onEventsResubscribed = onEventsResubscribed;
    const c1 = new FakeDaemonClient();
    h.clientQueue.push(c1);
    let subscribed = true;
    c1.rpcImpl = async (method) =>
      method === 'daemon.ping' ? { status: 'ok', eventsSubscribed: subscribed } : {};
    // The daemon refuses while the socket is still backed up, then accepts.
    const answers = [false, true];
    c1.resubscribeImpl = async () => {
      const ok = answers.shift() ?? true;
      if (ok) subscribed = true;
      return ok;
    };

    await h.controller.bootstrap();
    subscribed = false;
    await vi.advanceTimersByTimeAsync(1000);
    expect(c1.resubscribeCalls).toBe(1);
    expect(onEventsResubscribed).not.toHaveBeenCalled();
    expect(h.logs.some((l) => l.msg.includes('refused our event subscribe'))).toBe(true);

    await vi.advanceTimersByTimeAsync(1000);
    expect(c1.resubscribeCalls).toBe(2);
    expect(onEventsResubscribed).toHaveBeenCalledTimes(1);
    expect(onEventsResubscribed).toHaveBeenCalledWith(c1);

    await vi.advanceTimersByTimeAsync(1000);
    expect(c1.resubscribeCalls).toBe(2);
    expect(onEventsResubscribed).toHaveBeenCalledTimes(1);
  });

  it('runs one resubscribe at a time: a ping during one in flight starts no second', async () => {
    const h = makeHarness({
      config: { healthIntervalMs: 1000, healthTimeoutMs: 5000, baseBackoffMs: 50, budget: 5 },
    });
    const onEventsResubscribed = vi.fn();
    h.deps.onEventsResubscribed = onEventsResubscribed;
    const c1 = new FakeDaemonClient();
    h.clientQueue.push(c1);
    let subscribed = true;
    c1.rpcImpl = async (method) =>
      method === 'daemon.ping' ? { status: 'ok', eventsSubscribed: subscribed } : {};
    let accept: (ok: boolean) => void = () => undefined;
    c1.resubscribeImpl = () => new Promise<boolean>((resolve) => { accept = resolve; });

    await h.controller.bootstrap();
    subscribed = false;
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(1000);
    expect(c1.resubscribeCalls).toBe(1);
    expect(onEventsResubscribed).not.toHaveBeenCalled();

    subscribed = true;
    accept(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(onEventsResubscribed).toHaveBeenCalledTimes(1);
  });

  it('leaves an older daemon that does not report the subscription alone', async () => {
    const h = makeHarness({
      config: { healthIntervalMs: 1000, healthTimeoutMs: 5000, baseBackoffMs: 50, budget: 5 },
    });
    const c1 = new FakeDaemonClient();
    h.clientQueue.push(c1);
    c1.rpcImpl = async (method) => (method === 'daemon.ping' ? { status: 'ok' } : {});

    await h.controller.bootstrap();
    for (let i = 0; i < 3; i++) await vi.advanceTimersByTimeAsync(1000);
    expect(c1.resubscribeCalls).toBe(0);
  });

  it('uses the default hangFailureThreshold of 5 (4 failures tolerated, 5th respawns) (RCA A4)', async () => {
    const h = makeHarness({
      // No hangFailureThreshold override → DEFAULTS (now 5, was 3).
      config: { healthIntervalMs: 1000, healthTimeoutMs: 100, baseBackoffMs: 50, budget: 5 },
    });
    const c1 = new FakeDaemonClient();
    const c2 = new FakeDaemonClient();
    h.clientQueue.push(c1, c2);

    let pingCalls = 0;
    c1.rpcImpl = async (method) => {
      if (method === 'daemon.ping') {
        pingCalls++;
        if (pingCalls === 1) return {}; // bootstrap auth ping succeeds
        throw new Error('ping timeout');
      }
      return {};
    };

    await h.controller.bootstrap();

    // 4 failing ticks — below the default threshold of 5 → no respawn yet.
    for (let i = 0; i < 4; i++) await vi.advanceTimersByTimeAsync(1000);
    expect(h.deps.onUninstall).not.toHaveBeenCalled();

    // 5th consecutive failure → respawn.
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.deps.onUninstall).toHaveBeenCalled();
    expect(c1.disconnectSyncCalls).toBe(1);
  });

  describe('a daemon that stops answering is looked at before it is respawned', () => {
    const progress = { noProgressMs: 3_000, pressureFactor: 4, maxUnansweredMs: 60_000 };
    /** Bootstrap answers, then every ping times out. */
    const failingPings = (client: FakeDaemonClient) => {
      let pings = 0;
      client.rpcImpl = async (method) => {
        if (method !== 'daemon.ping') return {};
        if (++pings === 1) return {};
        throw new Error('ping timeout');
      };
    };

    it('a starved daemon whose CPU time keeps rising is not respawned', async () => {
      let cpu = 0;
      const sampled: number[] = [];
      const h = makeHarness({
        config: { healthIntervalMs: 1000, healthTimeoutMs: 100, hangFailureThreshold: 3, baseBackoffMs: 50, budget: 5, progress },
        sampleDaemon: async (pid) => { sampled.push(pid); cpu += 40; return { alive: true, cpuMs: cpu, startedAt: 'T0', underPressure: true }; },
      });
      const c1 = new FakeDaemonClient();
      h.clientQueue.push(c1, new FakeDaemonClient());
      failingPings(c1);
      await h.controller.bootstrap();
      for (let i = 0; i < 20; i++) await vi.advanceTimersByTimeAsync(1000);
      expect(h.deps.onUninstall).not.toHaveBeenCalled();
      expect(c1.disconnectSyncCalls).toBe(0);
      expect(h.ensureDaemonCalls).toBe(1);
      expect(new Set(sampled)).toEqual(new Set([1234]));
      expect(h.logs.some((l) => l.msg.includes('slow, not hung'))).toBe(true);
    });

    it('a wedged daemon (no CPU time for the budget) is respawned, once its CPU time has stopped rising for that long', async () => {
      let cpu = 0;
      let rising = true;
      const h = makeHarness({
        config: { healthIntervalMs: 1000, healthTimeoutMs: 100, hangFailureThreshold: 3, baseBackoffMs: 50, budget: 5, progress },
        sampleDaemon: async () => { if (rising) cpu += 40; return { alive: true, cpuMs: cpu, startedAt: 'T0', underPressure: false }; },
      });
      const c1 = new FakeDaemonClient();
      h.clientQueue.push(c1, new FakeDaemonClient());
      failingPings(c1);
      await h.controller.bootstrap();
      // Past the failure threshold while it still runs: kept.
      for (let i = 0; i < 5; i++) await vi.advanceTimersByTimeAsync(1000);
      expect(h.deps.onUninstall).not.toHaveBeenCalled();
      // It stops: kept until the budget runs out, then respawned.
      rising = false;
      await vi.advanceTimersByTimeAsync(2000);
      expect(h.deps.onUninstall).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(2000);
      expect(h.deps.onUninstall).toHaveBeenCalled();
      expect(c1.disconnectSyncCalls).toBe(1);
      expect(h.logs.some((l) => l.level === 'error' && l.msg.includes('no CPU time for the whole budget'))).toBe(true);
    });

    it('a daemon whose pid was handed on to another busy process is gone, not progressing: respawned at the threshold', async () => {
      let cpu = 0;
      let startedAt = 'T0';
      const h = makeHarness({
        config: { healthIntervalMs: 1000, healthTimeoutMs: 100, hangFailureThreshold: 3, baseBackoffMs: 50, budget: 5, progress },
        sampleDaemon: async () => { cpu += 40; return { alive: true, cpuMs: cpu, startedAt, underPressure: false }; },
      });
      const c1 = new FakeDaemonClient();
      h.clientQueue.push(c1, new FakeDaemonClient());
      failingPings(c1);
      await h.controller.bootstrap();
      // The daemon dies and another process gets its pid; its CPU time rises.
      startedAt = 'T1';
      for (let i = 0; i < 3; i++) await vi.advanceTimersByTimeAsync(1000);
      expect(h.deps.onUninstall).toHaveBeenCalled();
    });

    it('a daemon whose process is gone is respawned at the threshold', async () => {
      const h = makeHarness({
        config: { healthIntervalMs: 1000, healthTimeoutMs: 100, hangFailureThreshold: 3, baseBackoffMs: 50, budget: 5, progress },
        sampleDaemon: async () => ({ alive: false, cpuMs: null, startedAt: null, underPressure: false }),
      });
      const c1 = new FakeDaemonClient();
      h.clientQueue.push(c1, new FakeDaemonClient());
      failingPings(c1);
      await h.controller.bootstrap();
      for (let i = 0; i < 3; i++) await vi.advanceTimersByTimeAsync(1000);
      expect(h.deps.onUninstall).toHaveBeenCalled();
    });

    it('a daemon whose CPU time cannot be read (the read failed, or threw) is held through the budget, then respawned', async () => {
      for (const sampleDaemon of [
        async () => ({ alive: true, cpuMs: null, startedAt: null, underPressure: false }),
        async (): Promise<never> => { throw new Error('spawn ps ENOMEM'); },
      ]) {
        const h = makeHarness({
          config: { healthIntervalMs: 1000, healthTimeoutMs: 100, hangFailureThreshold: 3, baseBackoffMs: 50, budget: 5, progress },
          sampleDaemon,
        });
        const c1 = new FakeDaemonClient();
        h.clientQueue.push(c1, new FakeDaemonClient());
        failingPings(c1);
        await h.controller.bootstrap();
        // At the threshold (the third failure, 2 s after the first): can't tell is not a hang.
        for (let i = 0; i < 3; i++) await vi.advanceTimersByTimeAsync(1000);
        expect(h.deps.onUninstall).not.toHaveBeenCalled();
        expect(h.logs.some((l) => l.msg.includes('cannot be read right now'))).toBe(true);
        // The budget (3 s from the first failure) runs out.
        for (let i = 0; i < 2; i++) await vi.advanceTimersByTimeAsync(1000);
        expect(h.deps.onUninstall).toHaveBeenCalled();
        h.controller.dispose();
      }
    });

    it('the identity read at connect, when it lands after the failures began, does not start their budget over', async () => {
      let cpu = 0;
      let rising = true;
      let releaseBind!: () => void;
      const bindHeld = new Promise<void>((resolve) => { releaseBind = resolve; });
      let first = true;
      const h = makeHarness({
        config: { healthIntervalMs: 1000, healthTimeoutMs: 100, hangFailureThreshold: 3, baseBackoffMs: 50, budget: 5, progress },
        sampleDaemon: async () => {
          if (first) { first = false; await bindHeld; }
          if (rising) cpu += 40;
          return { alive: true, cpuMs: cpu, startedAt: 'T0', underPressure: false };
        },
      });
      const c1 = new FakeDaemonClient();
      h.clientQueue.push(c1, new FakeDaemonClient());
      failingPings(c1);
      await h.controller.bootstrap();
      for (let i = 0; i < 3; i++) await vi.advanceTimersByTimeAsync(1000);
      rising = false;
      await vi.advanceTimersByTimeAsync(2000);
      // The connect's read lands now, two seconds into the stall.
      releaseBind();
      await vi.advanceTimersByTimeAsync(2000);
      expect(h.deps.onUninstall).toHaveBeenCalled();
    });
  });

  it('skips probe ticks when no client is installed', async () => {
    const h = makeHarness({
      config: { healthIntervalMs: 100, healthTimeoutMs: 50 },
    });
    const c1 = new FakeDaemonClient();
    c1.connectImpl = async () => false;
    h.clientQueue.push(c1);

    await h.controller.bootstrap();
    // No probe timers should be firing — advance generously (still short of
    // the respawn backoff) and verify no probe activity: the only event is
    // the respawn loop's schedule after the failed launch.
    await vi.advanceTimersByTimeAsync(500);
    expect(h.events).toEqual([{ type: 'reconnecting', attempt: 1, backoffMs: 1000 }]);
    expect(h.logs.some((l) => l.msg.includes('health ping'))).toBe(false);
  });
});

describe('DaemonRespawnController.dispose', () => {
  it('clears pending respawn timers and detaches listeners', async () => {
    const h = makeHarness({
      config: { baseBackoffMs: 1000, healthIntervalMs: 0 },
    });
    const c1 = new FakeDaemonClient();
    h.clientQueue.push(c1);

    await h.controller.bootstrap();
    c1.fireDisconnect();
    expect(h.events.some((e) => e.type === 'reconnecting')).toBe(true);

    h.controller.dispose();

    // Advance past the would-be respawn — the controller must NOT call
    // ensureDaemon or install a new client.
    await vi.advanceTimersByTimeAsync(5000);
    expect(h.ensureDaemonCalls).toBe(1); // bootstrap only
    expect(h.controller.isHealthy).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// B′ stale-daemon auto-replacement (plans/daemon-auto-replace-plan-2026-07-05.md §5).
// The orchestrator's own step logic is covered in daemonReplacement.test.ts;
// these tests pin the CONTROLLER integration: gate conditions, which client
// gets installed on each outcome, the bootstrap dead-end → budget-loop
// routing, and the before-quit cancellation seams.
// ---------------------------------------------------------------------------

const OLD_PONG = { status: 'ok', pid: 4242 }; // pre-B′: no spawnedByVersion
const NEW_PONG = { status: 'ok', pid: 5000, spawnedByVersion: '3.17.0', channelsEpoch: 2 };

function makeReplacementHooks(overrides: Partial<DaemonReplacementHooks> = {}): DaemonReplacementHooks & {
  raceShutdownCalls: number;
  killCalls: number[];
} {
  const state = { raceShutdownCalls: 0, killCalls: [] as number[] };
  return Object.assign(state, {
    appVersion: '3.17.0',
    channelsEpoch: 2,
    raceShutdown: async () => { state.raceShutdownCalls++; return { acked: true }; },
    checkLiveness: () => 'dead' as const,
    killVerifiedPid: (pid: number) => { state.killCalls.push(pid); return true; },
    sleep: async () => { /* instant */ },
    ...overrides,
  });
}

describe('DaemonRespawnController stale-daemon replacement', () => {
  it('replaces a reused pre-B′ daemon at bootstrap: shutdown → death → fresh spawn → install fresh client', async () => {
    let ensureCall = 0;
    const hooks = makeReplacementHooks();
    const h = makeHarness({
      replacement: hooks,
      config: { healthIntervalMs: 0 },
      ensureDaemonImpl: async () => {
        ensureCall++;
        return ensureCall === 1
          ? { pid: 4242, authToken: 'tok', pipeName: 'pipe', spawned: false } // reused stale
          : { pid: 5000, authToken: 'tok2', pipeName: 'pipe', spawned: true }; // fresh
      },
    });
    const oldClient = new FakeDaemonClient();
    oldClient.rpcImpl = async () => OLD_PONG;
    const freshClient = new FakeDaemonClient();
    freshClient.rpcImpl = async () => NEW_PONG;
    h.clientQueue.push(oldClient, freshClient);

    const result = await h.controller.bootstrap();

    expect(result).toBe(freshClient);
    expect(h.ensureDaemonCalls).toBe(2);
    expect(hooks.raceShutdownCalls).toBe(1);
    expect(hooks.killCalls).toEqual([]); // clean death — no escalation
    expect(h.events).toContainEqual({ type: 'replacing' });
    expect(h.deps.onInstall).toHaveBeenCalledTimes(1);
    // Our own socket to the old daemon was released during replacement.
    expect(oldClient.disconnectCalls).toBe(1);
    expect(h.controller.isHealthy).toBe(true);
  });

  it('#1019 second review: still disconnects the old client on the no-verifiable-pid bail-out', async () => {
    // The #1001 yield-and-reconnect edge case: a spawn that lost the race to
    // an already-live daemon whose ping omitted pid, with no daemon.pid file
    // to fall back to either — `oldInfo.pid` is null, so replacement can't
    // verify-and-kill and bails before ever reaching runDaemonReplacement's
    // own disconnectClient hook. Before the fix that early return skipped
    // cleanup entirely, leaking the socket to the (still-live, still-old)
    // daemon this controller was about to abandon.
    const hooks = makeReplacementHooks();
    const h = makeHarness({
      replacement: hooks,
      config: { healthIntervalMs: 0 },
      ensureDaemonImpl: async () => ({ pid: null, authToken: 'tok', pipeName: 'pipe', spawned: false }),
    });
    const oldClient = new FakeDaemonClient();
    // The launcher has no pid only when the daemon's ping carried none either.
    oldClient.rpcImpl = async () => ({ status: 'ok' });
    h.clientQueue.push(oldClient);

    const result = await h.controller.bootstrap();

    expect(result).toBeNull();
    expect(hooks.raceShutdownCalls).toBe(0); // never got far enough to shut anything down
    expect(oldClient.disconnectCalls).toBe(1);
  });

  it('does NOT fire for a freshly spawned daemon even if the pong looks old', async () => {
    const hooks = makeReplacementHooks();
    const h = makeHarness({
      replacement: hooks,
      config: { healthIntervalMs: 0 },
      ensureDaemonImpl: async () => ({ pid: 1, authToken: 't', pipeName: 'p', spawned: true }),
    });
    const c1 = new FakeDaemonClient();
    c1.rpcImpl = async () => ({ ...OLD_PONG, pid: 1 });
    h.clientQueue.push(c1);

    const result = await h.controller.bootstrap();
    expect(result).toBe(c1);
    expect(hooks.raceShutdownCalls).toBe(0);
    expect(h.events).toEqual([]);
  });

  it('does NOT fire for a reused current-version daemon', async () => {
    const hooks = makeReplacementHooks();
    const h = makeHarness({
      replacement: hooks,
      config: { healthIntervalMs: 0 },
      ensureDaemonImpl: async () => ({ pid: 1, authToken: 't', pipeName: 'p', spawned: false }),
    });
    const c1 = new FakeDaemonClient();
    c1.rpcImpl = async () => NEW_PONG;
    h.clientQueue.push(c1);

    const result = await h.controller.bootstrap();
    expect(result).toBe(c1);
    expect(hooks.raceShutdownCalls).toBe(0);
  });

  it('keeps a NEWER reused daemon (downgrade forbidden) and logs at warn', async () => {
    const hooks = makeReplacementHooks({ appVersion: '3.16.0' });
    const h = makeHarness({
      replacement: hooks,
      config: { healthIntervalMs: 0 },
      ensureDaemonImpl: async () => ({ pid: 1, authToken: 't', pipeName: 'p', spawned: false }),
    });
    const c1 = new FakeDaemonClient();
    c1.rpcImpl = async () => NEW_PONG; // 3.17.0 daemon under a 3.16.0 app
    h.clientQueue.push(c1);

    const result = await h.controller.bootstrap();
    expect(result).toBe(c1);
    expect(hooks.raceShutdownCalls).toBe(0);
    expect(h.logs.some((l) => l.level === 'warn' && l.msg.includes('NEWER'))).toBe(true);
  });

  it('pre-ack abort (shutdown refused, old daemon still connected) installs the OLD client', async () => {
    const hooks = makeReplacementHooks({ raceShutdown: async () => ({ acked: false }) });
    const h = makeHarness({
      replacement: hooks,
      config: { healthIntervalMs: 0 },
      ensureDaemonImpl: async () => ({ pid: 4242, authToken: 't', pipeName: 'p', spawned: false }),
    });
    const oldClient = new FakeDaemonClient();
    oldClient.rpcImpl = async () => OLD_PONG;
    h.clientQueue.push(oldClient);

    const result = await h.controller.bootstrap();
    // connect() set connected=true and the failed shutdown didn't drop it,
    // so the pre-ack branch reuses the live old client.
    expect(result).toBe(oldClient);
    expect(h.ensureDaemonCalls).toBe(1); // no fresh spawn
    expect(h.events).toContainEqual({ type: 'replacing' });
    expect(h.controller.isHealthy).toBe(true);
  });

  it('bootstrap dead-end routes into the respawn budget loop and recovers on the next attempt', async () => {
    let ensureCall = 0;
    // Ack received but the old daemon lingers and the verified kill refuses
    // (indeterminate verification) → dead-end.
    //
    // Unit-harness limitation (Codex code-review #3): the second
    // ensureDaemon() here scripts a fresh spawn, whereas the real launcher
    // would re-enter its pid-file liveness/verification path against the
    // still-lingering pid. That composition is covered by the launcher's
    // own liveness suites plus the dogfood procedure (plan §9); this test
    // pins only the CONTROLLER's routing (no install on dead-end, budget
    // loop entered, no second replacement attempt).
    const hooks = makeReplacementHooks({
      checkLiveness: () => 'alive' as const,
      killVerifiedPid: () => false,
    });
    const h = makeHarness({
      replacement: hooks,
      config: { healthIntervalMs: 0, baseBackoffMs: 100 },
      ensureDaemonImpl: async () => {
        ensureCall++;
        return ensureCall === 1
          ? { pid: 4242, authToken: 't', pipeName: 'p', spawned: false }  // stale reuse
          : { pid: 5000, authToken: 't2', pipeName: 'p', spawned: true }; // budget-loop spawn
      },
    });
    const oldClient = new FakeDaemonClient();
    oldClient.rpcImpl = async () => OLD_PONG;
    const freshClient = new FakeDaemonClient();
    freshClient.rpcImpl = async () => NEW_PONG;
    h.clientQueue.push(oldClient, freshClient);

    const result = await h.controller.bootstrap();
    expect(result).toBeNull();
    // No client installed on a dead-end — a dead/dying client would wedge
    // the health probe (early-return on !isConnected) forever.
    expect(h.deps.onInstall).not.toHaveBeenCalled();
    // Budget loop entered: uninstall fired and a reconnecting event queued.
    expect(h.deps.onUninstall).toHaveBeenCalledTimes(1);
    expect(h.events).toContainEqual({ type: 'reconnecting', attempt: 1, backoffMs: 100 });

    // Let the budgeted respawn fire — it must spawn fresh (old pid dead by
    // now in the real world; the harness just hands out the fresh info) and
    // NOT re-attempt replacement (once-per-run).
    await vi.advanceTimersByTimeAsync(100);
    expect(h.controller.isHealthy).toBe(true);
    expect(h.deps.onInstall).toHaveBeenCalledTimes(1);
    expect(hooks.raceShutdownCalls).toBe(1); // no second replacement attempt
  });

  it('once-per-run: a second reused-stale encounter installs the old client without replacing', async () => {
    const hooks = makeReplacementHooks({
      checkLiveness: () => 'alive' as const,
      killVerifiedPid: () => false,
    });
    const h = makeHarness({
      replacement: hooks,
      config: { healthIntervalMs: 0, baseBackoffMs: 100 },
      ensureDaemonImpl: async () => ({ pid: 4242, authToken: 't', pipeName: 'p', spawned: false }),
    });
    const oldClient1 = new FakeDaemonClient();
    oldClient1.rpcImpl = async () => OLD_PONG;
    const oldClient2 = new FakeDaemonClient();
    oldClient2.rpcImpl = async () => OLD_PONG;
    h.clientQueue.push(oldClient1, oldClient2);

    // First encounter: dead-end (ack + linger + kill refused) → budget loop.
    const result = await h.controller.bootstrap();
    expect(result).toBeNull();
    expect(hooks.raceShutdownCalls).toBe(1);

    // Budgeted retry meets the SAME stale daemon — once-per-run must let it
    // through as a plain reuse (today's behavior + banner) instead of
    // stalling every reconnect on another shutdown budget.
    await vi.advanceTimersByTimeAsync(100);
    expect(hooks.raceShutdownCalls).toBe(1); // still 1
    expect(h.controller.isHealthy).toBe(true);
    expect(h.deps.onInstall).toHaveBeenCalledTimes(1);
  });

  it('dispose landing at the fresh spawn kills the new daemon ONLY on full shutdown', async () => {
    // Codex delta review: dispose() fires on EVERY quit (before-quit calls
    // it ahead of the detach-vs-teardown branch), so the kill must be gated
    // on the full-shutdown signal — a detach Quit wants the fresh daemon
    // alive with the recovered sessions.
    const runScenario = async (fullShutdown: boolean) => {
      let ensureCall = 0;
      const hooks = makeReplacementHooks({
        isFullShutdown: () => fullShutdown,
      });
      const h = makeHarness({
        replacement: hooks,
        config: { healthIntervalMs: 0 },
        ensureDaemonImpl: async () => {
          ensureCall++;
          if (ensureCall === 1) {
            return { pid: 4242, authToken: 't', pipeName: 'p', spawned: false };
          }
          // dispose lands exactly between the fresh spawn resolving and the
          // controller's disposed check.
          h.controller.dispose();
          return { pid: 5000, authToken: 't2', pipeName: 'p', spawned: true };
        },
      });
      const oldClient = new FakeDaemonClient();
      oldClient.rpcImpl = async () => OLD_PONG;
      h.clientQueue.push(oldClient); // fresh client never gets created
      const result = await h.controller.bootstrap();
      expect(result).toBeNull();
      expect(h.deps.onInstall).not.toHaveBeenCalled();
      return hooks.killCalls;
    };

    expect(await runScenario(true)).toEqual([5000]);  // full shutdown: kill
    expect(await runScenario(false)).toEqual([]);      // detach quit: leave alive
  });

  it('dispose during replacement cancels before the fresh spawn (before-quit race)', async () => {
    let ensureCall = 0;
    // Object-typed gate instead of a closed-over `let`: TS control-flow
    // analysis cannot see the executor-callback assignment on a plain local
    // (it narrows the variable to `null` and flags the call as `never` —
    // broke the tsc CI gate), but property narrowing resets across the
    // intervening function calls, so this stays well-typed.
    const shutdownGate: { resolve?: (v: { acked: boolean }) => void } = {};
    const hooks = makeReplacementHooks({
      raceShutdown: () => new Promise<{ acked: boolean }>((res) => { shutdownGate.resolve = res; }),
    });
    const h = makeHarness({
      replacement: hooks,
      config: { healthIntervalMs: 0 },
      ensureDaemonImpl: async () => {
        ensureCall++;
        return { pid: 4242, authToken: 't', pipeName: 'p', spawned: false };
      },
    });
    const oldClient = new FakeDaemonClient();
    oldClient.rpcImpl = async () => OLD_PONG;
    h.clientQueue.push(oldClient);

    const bootP = h.controller.bootstrap();
    // Give the gate a chance to fire the shutdown RPC, then quit.
    await vi.advanceTimersByTimeAsync(0);
    expect(shutdownGate.resolve).toBeDefined();
    h.controller.dispose();
    shutdownGate.resolve?.({ acked: true }); // ack lands after dispose

    const result = await bootP;
    expect(result).toBeNull();
    expect(ensureCall).toBe(1);            // fresh spawn never attempted
    expect(h.deps.onInstall).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// The daemon's exit code in main's log (daemonExitWatch.ts). The watch itself
// is covered in daemonExitWatch.test.ts; these pin when the controller starts
// one, for which pid, and when it asks for a report.
// ---------------------------------------------------------------------------

function makeExitWatches() {
  const watches: Array<{ pid: number | null; spawned: boolean; reports: string[]; disposed: boolean }> = [];
  const factory = (pid: number | null, spawned: boolean) => {
    const w = { pid, spawned, reports: [] as string[], disposed: false };
    watches.push(w);
    return {
      report: async (reason: string) => { w.reports.push(reason); },
      dispose: () => { w.disposed = true; },
    };
  };
  return { watches, factory };
}

describe('DaemonRespawnController daemon exit watch', () => {
  it('watches the installed daemon pid and reports at socket close', async () => {
    const ew = makeExitWatches();
    const h = makeHarness({ config: { baseBackoffMs: 100, healthIntervalMs: 0 }, watchDaemonExit: ew.factory });
    const c1 = new FakeDaemonClient();
    h.clientQueue.push(c1);

    await h.controller.bootstrap();
    expect(ew.watches).toEqual([{ pid: 1234, spawned: true, reports: [], disposed: false }]);

    c1.fireDisconnect();
    expect(ew.watches[0].reports).toEqual(['socket close']);
  });

  it('a respawned daemon gets a fresh watch; the old one is retired', async () => {
    let pid = 1000;
    const ew = makeExitWatches();
    const h = makeHarness({
      config: { baseBackoffMs: 100, healthIntervalMs: 0 },
      watchDaemonExit: ew.factory,
      ensureDaemonImpl: async () => ({ pid: ++pid, authToken: 'tok', pipeName: 'pipe', spawned: true }),
    });
    const c1 = new FakeDaemonClient();
    const c2 = new FakeDaemonClient();
    h.clientQueue.push(c1, c2);

    await h.controller.bootstrap();
    c1.fireDisconnect();
    await vi.advanceTimersByTimeAsync(100);

    expect(ew.watches.map((w) => w.pid)).toEqual([1001, 1002]);
    expect(ew.watches[0].disposed).toBe(true);
    expect(ew.watches[1].disposed).toBe(false);
  });

  it('a health-probe hang reports whether the daemon was still alive', async () => {
    const ew = makeExitWatches();
    const h = makeHarness({
      config: { healthIntervalMs: 1000, healthTimeoutMs: 100, hangFailureThreshold: 2, baseBackoffMs: 50_000 },
      watchDaemonExit: ew.factory,
    });
    const c1 = new FakeDaemonClient();
    h.clientQueue.push(c1);
    let pings = 0;
    c1.rpcImpl = async () => {
      if (++pings === 1) return {};
      throw new Error('ping timeout');
    };

    await h.controller.bootstrap();
    await vi.advanceTimersByTimeAsync(2000);

    expect(c1.disconnectSyncCalls).toBe(1);
    expect(ew.watches[0].reports).toEqual(['health probe hang']);
  });

  it('dispose retires the watch without a report (a detach Quit leaves the daemon alive)', async () => {
    const ew = makeExitWatches();
    const h = makeHarness({ config: { healthIntervalMs: 0 }, watchDaemonExit: ew.factory });
    h.clientQueue.push(new FakeDaemonClient());

    await h.controller.bootstrap();
    h.controller.dispose();

    expect(ew.watches[0]).toMatchObject({ reports: [], disposed: true });
  });

  it('a replaced stale daemon is watched by the fresh pid, not the one replaced', async () => {
    let ensureCall = 0;
    const ew = makeExitWatches();
    const h = makeHarness({
      replacement: makeReplacementHooks(),
      config: { healthIntervalMs: 0 },
      watchDaemonExit: ew.factory,
      ensureDaemonImpl: async () => {
        ensureCall++;
        return ensureCall === 1
          ? { pid: 4242, authToken: 'tok', pipeName: 'pipe', spawned: false }
          : { pid: 5000, authToken: 'tok2', pipeName: 'pipe', spawned: true };
      },
    });
    const oldClient = new FakeDaemonClient();
    oldClient.rpcImpl = async () => OLD_PONG;
    const freshClient = new FakeDaemonClient();
    freshClient.rpcImpl = async () => NEW_PONG;
    h.clientQueue.push(oldClient, freshClient);

    await h.controller.bootstrap();

    expect(ew.watches.map((w) => [w.pid, w.spawned])).toEqual([[5000, true]]);
  });

  it('a daemon found running is watched as not spawned by this process', async () => {
    const ew = makeExitWatches();
    const h = makeHarness({
      config: { healthIntervalMs: 0 },
      watchDaemonExit: ew.factory,
      ensureDaemonImpl: async () => ({ pid: 777, authToken: 'tok', pipeName: 'pipe', spawned: false }),
    });
    h.clientQueue.push(new FakeDaemonClient());

    await h.controller.bootstrap();

    expect(ew.watches.map((w) => [w.pid, w.spawned])).toEqual([[777, false]]);
  });
});

// ---------------------------------------------------------------------------
// The pid the controller acts on is the one the authenticated ping reports.
// A reused daemon's launcher pid comes from the pid file, which can be stale
// or name a reused pid while the canonical pipe still answers.
// ---------------------------------------------------------------------------

describe('DaemonRespawnController trusts the pid that answered the ping', () => {
  it('a pid-file pid the ping contradicts: the answering pid is watched, as not spawned here', async () => {
    const ew = makeExitWatches();
    const h = makeHarness({ config: { healthIntervalMs: 0 }, watchDaemonExit: ew.factory });
    const c1 = new FakeDaemonClient();
    c1.rpcImpl = async () => ({ status: 'ok', pid: 9999 });
    h.clientQueue.push(c1);

    await h.controller.bootstrap();

    expect(ew.watches.map((w) => [w.pid, w.spawned])).toEqual([[9999, false]]);
    expect(h.logs).toContainEqual({ level: 'warn', msg: 'daemon pid file names 1234 but pid 9999 answered the ping — using 9999' });
  });

  it('a ping that agrees, or carries no pid (a pre-Step-③ daemon), keeps the launcher answer', async () => {
    for (const pong of [{ status: 'ok', pid: 1234 }, { status: 'ok' }]) {
      const ew = makeExitWatches();
      const h = makeHarness({ config: { healthIntervalMs: 0 }, watchDaemonExit: ew.factory });
      const c1 = new FakeDaemonClient();
      c1.rpcImpl = async () => pong;
      h.clientQueue.push(c1);

      await h.controller.bootstrap();

      expect(ew.watches.map((w) => [w.pid, w.spawned])).toEqual([[1234, true]]);
      expect(h.logs.filter((l) => l.level === 'warn')).toEqual([]);
    }
  });

  it('a launcher with no pid takes the ping pid without a warning', async () => {
    const ew = makeExitWatches();
    const h = makeHarness({
      config: { healthIntervalMs: 0 },
      watchDaemonExit: ew.factory,
      ensureDaemonImpl: async () => ({ pid: null, authToken: 'tok', pipeName: 'pipe', spawned: false }),
    });
    const c1 = new FakeDaemonClient();
    c1.rpcImpl = async () => ({ status: 'ok', pid: 321 });
    h.clientQueue.push(c1);

    await h.controller.bootstrap();

    expect(ew.watches.map((w) => [w.pid, w.spawned])).toEqual([[321, false]]);
    expect(h.logs.filter((l) => l.level === 'warn')).toEqual([]);
  });

  it('a replacement daemon whose ping names another pid is watched by that pid', async () => {
    let ensureCall = 0;
    const ew = makeExitWatches();
    const h = makeHarness({
      replacement: makeReplacementHooks(),
      config: { healthIntervalMs: 0 },
      watchDaemonExit: ew.factory,
      ensureDaemonImpl: async () => {
        ensureCall++;
        return ensureCall === 1
          ? { pid: 4242, authToken: 'tok', pipeName: 'pipe', spawned: false }
          : { pid: 5000, authToken: 'tok2', pipeName: 'pipe', spawned: true };
      },
    });
    const oldClient = new FakeDaemonClient();
    oldClient.rpcImpl = async () => OLD_PONG;
    const freshClient = new FakeDaemonClient();
    freshClient.rpcImpl = async () => ({ ...NEW_PONG, pid: 5001 });
    h.clientQueue.push(oldClient, freshClient);

    await h.controller.bootstrap();

    expect(ew.watches.map((w) => [w.pid, w.spawned])).toEqual([[5001, false]]);
  });

  it('a stale daemon is confirmed dead and killed by the pid that answered, not the pid file', async () => {
    let ensureCall = 0;
    const livenessCalls: number[] = [];
    const hooks = makeReplacementHooks({
      // Alive until killed, so the replacement escalates to a verified kill.
      checkLiveness: (pid: number) => {
        livenessCalls.push(pid);
        return hooks.killCalls.length === 0 ? 'alive' : 'dead';
      },
    });
    const h = makeHarness({
      replacement: hooks,
      config: { healthIntervalMs: 0 },
      ensureDaemonImpl: async () => {
        ensureCall++;
        return ensureCall === 1
          ? { pid: 4242, authToken: 'tok', pipeName: 'pipe', spawned: false }
          : { pid: 5000, authToken: 'tok2', pipeName: 'pipe', spawned: true };
      },
    });
    const oldClient = new FakeDaemonClient();
    oldClient.rpcImpl = async () => ({ ...OLD_PONG, pid: 4300 });
    const freshClient = new FakeDaemonClient();
    freshClient.rpcImpl = async () => NEW_PONG;
    h.clientQueue.push(oldClient, freshClient);

    await h.controller.bootstrap();

    expect(new Set(livenessCalls)).toEqual(new Set([4300]));
    expect(hooks.killCalls).toEqual([4300]);
    expect(h.logs).toContainEqual({ level: 'info', msg: 'stale daemon replaced (old pid=4300 → new pid=5000)' });
  });
});

describe('DaemonRespawnController hands its exit watch over for a full shutdown', () => {
  it('a taken watch survives dispose, and the controller no longer reports on it', async () => {
    const ew = makeExitWatches();
    const h = makeHarness({ config: { healthIntervalMs: 0 }, watchDaemonExit: ew.factory });
    const c1 = new FakeDaemonClient();
    h.clientQueue.push(c1);
    await h.controller.bootstrap();

    const taken = h.controller.takeExitWatch();
    h.controller.dispose();
    c1.fireDisconnect();

    expect(taken).not.toBeNull();
    expect(ew.watches[0]).toMatchObject({ reports: [], disposed: false });
    await taken!.report('full shutdown');
    expect(ew.watches[0].reports).toEqual(['full shutdown']);
  });
});

describe('DaemonRespawnController queued launchd job', () => {
  it('a start that finds the daemon still queued costs no budget until QUEUED_JOB_ADOPT_MS', async () => {
    const h = makeHarness({
      config: { baseBackoffMs: 100, maxBackoffMs: 100, budget: 2, healthIntervalMs: 0 },
      ensureDaemonImpl: async () => { throw new LaunchdJobQueuedError('com.wmux.daemon.x'); },
    });

    await h.controller.bootstrap();
    await vi.advanceTimersByTimeAsync(QUEUED_JOB_ADOPT_MS - 1_000);
    expect(h.ensureDaemonCalls).toBeGreaterThan(10);
    expect(h.events.some((e) => e.type === 'respawn-exhausted')).toBe(false);
    expect(h.controller.daemonMayReturn).toBe(true);

    // Past the adoption window the budget counts again.
    await vi.advanceTimersByTimeAsync(2_000);
    expect(h.events.some((e) => e.type === 'respawn-exhausted')).toBe(true);
  });
});

/**
 * #2398 — the local pty:reconnect handler answers "session gone" for an id it
 * does not own only once no daemon is coming back. While a respawn is pending
 * the id may be the daemon's, so the answer stays transient.
 */
describe('DaemonRespawnController.daemonMayReturn (#2398)', () => {
  it('stays true after the first launch failed: the respawn loop takes over', async () => {
    const h = makeHarness();
    let release!: () => void;
    (h.deps as { ensureDaemon: () => Promise<DaemonInfo> }).ensureDaemon = () =>
      new Promise((resolve) => { release = () => resolve({ pid: 1, authToken: 't', pipeName: 'p', spawned: true }); });
    const c1 = new FakeDaemonClient();
    c1.connectImpl = async () => false;
    h.clientQueue.push(c1);

    const booting = h.controller.bootstrap();
    expect(h.controller.daemonMayReturn).toBe(true);
    release();
    await booting;
    expect(h.controller.daemonMayReturn).toBe(true);
    expect(h.events).toContainEqual({ type: 'reconnecting', attempt: 1, backoffMs: 1000 });
  });

  it('is true while a respawn is pending, false once the budget is exhausted', async () => {
    const h = makeHarness({ config: { baseBackoffMs: 100, maxBackoffMs: 100, budget: 2, healthIntervalMs: 0 } });
    const c1 = new FakeDaemonClient();
    h.clientQueue.push(c1);
    await h.controller.bootstrap();

    (h.deps as { ensureDaemon: () => Promise<DaemonInfo> }).ensureDaemon = async () => { throw new Error('spawn failed'); };
    c1.fireDisconnect();
    expect(h.controller.daemonMayReturn).toBe(true);
    await vi.advanceTimersByTimeAsync(100);
    expect(h.controller.daemonMayReturn).toBe(true);
    await vi.advanceTimersByTimeAsync(100);
    expect(h.events.some((e) => e.type === 'respawn-exhausted')).toBe(true);
    expect(h.controller.daemonMayReturn).toBe(false);
  });

  it('is false again once a respawn installs a client', async () => {
    const h = makeHarness({ config: { baseBackoffMs: 100, maxBackoffMs: 100, budget: 5, healthIntervalMs: 0 } });
    const c1 = new FakeDaemonClient();
    const c2 = new FakeDaemonClient();
    h.clientQueue.push(c1, c2);
    await h.controller.bootstrap();
    c1.fireDisconnect();
    expect(h.controller.daemonMayReturn).toBe(true);
    await vi.advanceTimersByTimeAsync(100);
    expect(h.controller.isHealthy).toBe(true);
    expect(h.controller.daemonMayReturn).toBe(false);
  });
});
