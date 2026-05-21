import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import {
  DaemonRespawnController,
  type DaemonRespawnDeps,
  type RespawnEvent,
} from '../DaemonRespawnController';
import type { DaemonClient } from '../../DaemonClient';
import type { DaemonInfo } from '../launcher';

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
    expect(h.controller.isHealthy).toBe(false);
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

  it('skips probe ticks when no client is installed', async () => {
    const h = makeHarness({
      config: { healthIntervalMs: 100, healthTimeoutMs: 50 },
    });
    const c1 = new FakeDaemonClient();
    c1.connectImpl = async () => false;
    h.clientQueue.push(c1);

    await h.controller.bootstrap();
    // No timers should be firing — advance generously and verify no
    // spurious RPCs / events.
    await vi.advanceTimersByTimeAsync(500);
    expect(h.events).toEqual([]);
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
