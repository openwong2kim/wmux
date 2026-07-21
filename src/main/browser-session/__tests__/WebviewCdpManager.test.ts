import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { WebviewCdpManager } from '../WebviewCdpManager';

const mockDebugger = { attach: vi.fn(), detach: vi.fn(), sendCommand: vi.fn(async () => ({})) };
const mockWebContents = {
  debugger: mockDebugger,
  isDestroyed: vi.fn(() => false),
  on: vi.fn(),
  getURL: vi.fn(() => 'https://example.com'),
  getTitle: vi.fn(() => 'Example Page'),
  loadURL: vi.fn(),
  setBackgroundThrottling: vi.fn(),
};

vi.mock('electron', () => ({
  webContents: {
    fromId: vi.fn(() => mockWebContents),
  },
}));

const mockTargets = [
  {
    id: 'target-abc',
    type: 'page',
    url: 'https://example.com',
    webSocketDebuggerUrl: 'ws://127.0.0.1:18800/devtools/page/target-abc',
  },
];
global.fetch = vi.fn(() =>
  Promise.resolve({ json: () => Promise.resolve(mockTargets) } as Response),
);

describe('WebviewCdpManager', () => {
  let manager: WebviewCdpManager;

  beforeEach(() => {
    vi.clearAllMocks();
    manager = new WebviewCdpManager(18800);
  });

  it('register attaches debugger and stores session', async () => {
    await manager.register('surface-1', 42);
    expect(mockDebugger.attach).toHaveBeenCalledWith('1.3');
    expect(global.fetch).toHaveBeenCalledWith('http://127.0.0.1:18800/json');
    const target = manager.getTarget('surface-1');
    expect(target).not.toBeNull();
    expect(target?.targetId).toBe('target-abc');
    expect(target?.wsUrl).toContain('ws://');
  });

  it('register enables focus emulation and disables background throttling (#353)', async () => {
    await manager.register('surface-1', 42);
    // Background surfaces (display:none guest) must behave focused for input/a11y.
    expect(mockDebugger.sendCommand).toHaveBeenCalledWith('Emulation.setFocusEmulationEnabled', {
      enabled: true,
    });
    // And keep running full-speed so background screenshots / evaluate don't stall.
    expect(mockWebContents.setBackgroundThrottling).toHaveBeenCalledWith(false);
  });

  it('unregister detaches debugger and removes session', async () => {
    await manager.register('surface-1', 42);
    manager.unregister('surface-1');
    expect(mockDebugger.detach).toHaveBeenCalled();
    expect(manager.getTarget('surface-1')).toBeNull();
  });

  it('getTarget without surfaceId returns first available', async () => {
    await manager.register('surface-1', 42);
    const target = manager.getTarget();
    expect(target).not.toBeNull();
  });

  it('listTargets returns all sessions', async () => {
    await manager.register('s1', 42);
    const list = manager.listTargets();
    expect(list).toHaveLength(1);
    expect(list[0].surfaceId).toBe('s1');
  });

  it('waitForTarget resolves when target is already registered', async () => {
    await manager.register('surface-1', 42);
    const target = await manager.waitForTarget('surface-1', 1000);
    expect(target.targetId).toBe('target-abc');
  });

  it('waitForTarget resolves when target registers later', async () => {
    const promise = manager.waitForTarget('surface-2', 3000);
    setTimeout(() => manager.register('surface-2', 99), 50);
    const target = await promise;
    expect(target).not.toBeNull();
  });

  it('waitForTarget rejects on timeout', async () => {
    await expect(manager.waitForTarget('nonexistent', 100)).rejects.toThrow('timeout');
  });
});

// ── #517 lightweight mode ────────────────────────────────────────────────────

describe('WebviewCdpManager lightweight mode (#517)', () => {
  let manager: WebviewCdpManager;

  const lastThrottle = (): boolean | undefined => {
    const calls = mockWebContents.setBackgroundThrottling.mock.calls;
    return calls.length ? calls[calls.length - 1][0] : undefined;
  };

  beforeEach(() => {
    vi.clearAllMocks();
    manager = new WebviewCdpManager(18800);
  });

  it('lightweight OFF: hidden guest is never throttled', async () => {
    await manager.register('s1', 42);
    manager.setVisibility('s1', false);
    expect(lastThrottle()).toBe(false);
  });

  it('throttle drives the CDP CPU-throttling lever (primary) alongside background throttling', async () => {
    await manager.register('s1', 42);
    manager.setLightweightMode(true);
    manager.setVisibility('s1', false);
    // Dogfood 2026-07-21: a CSS-hidden guest stays page-visible, so
    // setBackgroundThrottling alone is inert — the CPU rate override is the
    // lever that actually reclaims CPU.
    expect(mockDebugger.sendCommand).toHaveBeenCalledWith(
      'Emulation.setCPUThrottlingRate', { rate: 20 },
    );
    manager.setVisibility('s1', true);
    expect(mockDebugger.sendCommand).toHaveBeenCalledWith(
      'Emulation.setCPUThrottlingRate', { rate: 1 },
    );
  });

  it('lightweight ON: hidden guest is throttled, visible guest is not', async () => {
    await manager.register('s1', 42);
    manager.setLightweightMode(true);
    manager.setVisibility('s1', false);
    expect(lastThrottle()).toBe(true);
    manager.setVisibility('s1', true);
    expect(lastThrottle()).toBe(false);
  });

  it('toggling lightweight recomputes ALL registered guests immediately', async () => {
    await manager.register('s1', 42);
    manager.setVisibility('s1', false);
    expect(lastThrottle()).toBe(false); // mode still off
    manager.setLightweightMode(true);
    expect(lastThrottle()).toBe(true);
    manager.setLightweightMode(false);
    expect(lastThrottle()).toBe(false);
  });

  it('visibility signal arriving BEFORE register applies after the registration grace', async () => {
    vi.useFakeTimers();
    try {
      manager.setLightweightMode(true);
      manager.setVisibility('s1', false);
      await manager.register('s1', 42);
      // Fresh-registration grace (codex P2): a just-registered hidden guest is
      // NOT throttled immediately — an unleased first op may be attaching.
      expect(lastThrottle()).toBe(false);
      vi.advanceTimersByTime(5_100);
      expect(lastThrottle()).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('CRITICAL (#353 regression): hidden guest with a held lease stays unthrottled', async () => {
    await manager.register('s1', 42);
    manager.setLightweightMode(true);
    manager.setVisibility('s1', false);
    expect(lastThrottle()).toBe(true);
    manager.acquireAutomationLease('s1');
    expect(lastThrottle()).toBe(false);
    // Second concurrent op: still unthrottled after one release (ref-count).
    manager.acquireAutomationLease('s1');
    manager.releaseAutomationLease('s1');
    expect(lastThrottle()).toBe(false);
  });

  it('idle grace: after final release the guest stays unthrottled until grace elapses', async () => {
    vi.useFakeTimers();
    try {
      await manager.register('s1', 42);
      manager.setLightweightMode(true);
      manager.setVisibility('s1', false);
      manager.acquireAutomationLease('s1');
      manager.releaseAutomationLease('s1');
      expect(lastThrottle()).toBe(false); // in grace window
      vi.advanceTimersByTime(5_100);
      expect(lastThrottle()).toBe(true); // re-throttled after grace
    } finally {
      vi.useRealTimers();
    }
  });

  it('re-acquire during grace cancels the pending re-throttle', async () => {
    vi.useFakeTimers();
    try {
      await manager.register('s1', 42);
      manager.setLightweightMode(true);
      manager.setVisibility('s1', false);
      manager.acquireAutomationLease('s1');
      manager.releaseAutomationLease('s1');
      manager.acquireAutomationLease('s1'); // back-to-back op
      vi.advanceTimersByTime(10_000);
      expect(lastThrottle()).toBe(false); // lease held — no flap
    } finally {
      vi.useRealTimers();
    }
  });

  it('withAutomationLease releases on throw', async () => {
    vi.useFakeTimers();
    try {
      await manager.register('s1', 42);
      manager.setLightweightMode(true);
      manager.setVisibility('s1', false);
      await expect(
        manager.withAutomationLease('s1', async () => { throw new Error('boom'); }),
      ).rejects.toThrow('boom');
      vi.advanceTimersByTime(5_100);
      expect(lastThrottle()).toBe(true); // lease released → grace → throttled
    } finally {
      vi.useRealTimers();
    }
  });

  it('fresh-registration grace: an acquired lease during grace takes over cleanly', async () => {
    vi.useFakeTimers();
    try {
      manager.setLightweightMode(true);
      manager.setVisibility('s1', false);
      await manager.register('s1', 42); // auto-opened hidden guest — grace armed
      expect(lastThrottle()).toBe(false);
      vi.advanceTimersByTime(2_000);
      const gen = manager.acquireAutomationLease('s1'); // late-acquire loop lands
      vi.advanceTimersByTime(10_000);
      expect(lastThrottle()).toBe(false); // leased — grace expiry is irrelevant
      manager.releaseAutomationLease('s1', gen);
      vi.advanceTimersByTime(5_100);
      expect(lastThrottle()).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('op-lease failsafe: a hung op cannot pin the lease forever', async () => {
    vi.useFakeTimers();
    try {
      await manager.register('s1', 42);
      manager.setLightweightMode(true);
      manager.setVisibility('s1', false);
      // fn hangs forever (dogfood repro: Page.captureScreenshot on a
      // display:none guest never resolves).
      void manager.withAutomationLease('s1', () => new Promise<never>(() => {}));
      expect(lastThrottle()).toBe(false); // leased
      vi.advanceTimersByTime(60_100 + 5_100); // failsafe + idle grace
      expect(lastThrottle()).toBe(true); // force-released → re-throttled
    } finally {
      vi.useRealTimers();
    }
  });

  it('RPC lease: acquire/release round-trip and TTL auto-expiry', async () => {
    vi.useFakeTimers();
    try {
      await manager.register('s1', 42);
      manager.setLightweightMode(true);
      manager.setVisibility('s1', false);
      const token = manager.acquireRpcLease('s1');
      expect(lastThrottle()).toBe(false);
      // TTL expiry (30s) auto-releases, then idle grace (5s) re-throttles.
      vi.advanceTimersByTime(30_100 + 5_100);
      expect(lastThrottle()).toBe(true);
      // Token already expired — release is a no-op returning false.
      expect(manager.releaseRpcLease(token)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('RPC lease renew extends the TTL', async () => {
    vi.useFakeTimers();
    try {
      await manager.register('s1', 42);
      manager.setLightweightMode(true);
      manager.setVisibility('s1', false);
      const token = manager.acquireRpcLease('s1');
      vi.advanceTimersByTime(20_000);
      expect(manager.renewRpcLease(token)).toBe(true);
      vi.advanceTimersByTime(20_000); // 40s total, but renewed at 20s
      expect(lastThrottle()).toBe(false);
      expect(manager.releaseRpcLease(token)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('unregister clears leases and idle timers for the surface', async () => {
    vi.useFakeTimers();
    try {
      await manager.register('s1', 42);
      manager.setLightweightMode(true);
      manager.acquireAutomationLease('s1');
      manager.unregister('s1');
      // Re-register: previous lease must not linger (visible defaults kept).
      manager.setVisibility('s1', false);
      await manager.register('s1', 42);
      vi.advanceTimersByTime(5_100); // past the fresh-registration grace
      expect(lastThrottle()).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('stale release across unregister/re-register cannot strip a fresh op\'s lease', async () => {
    await manager.register('s1', 42);
    manager.setLightweightMode(true);
    manager.setVisibility('s1', false);
    const staleGen = manager.acquireAutomationLease('s1'); // op A
    manager.unregister('s1'); // zeroes leases, bumps generation
    await manager.register('s1', 43);
    manager.acquireAutomationLease('s1'); // op B on the replacement guest
    expect(lastThrottle()).toBe(false);
    // Op A's late release must be a no-op — B still holds its lease.
    manager.releaseAutomationLease('s1', staleGen);
    expect(lastThrottle()).toBe(false);
  });

  it('same-guest re-registration (hidden navigation) preserves an in-flight lease', async () => {
    await manager.register('s1', 42);
    manager.setLightweightMode(true);
    manager.setVisibility('s1', false);
    const gen = manager.acquireAutomationLease('s1'); // op in flight
    expect(lastThrottle()).toBe(false);
    // dom-ready re-register for the SAME webContents (page navigated/reloaded)
    await manager.register('s1', 42);
    expect(lastThrottle()).toBe(false); // lease survived — no mid-op throttle
    manager.releaseAutomationLease('s1', gen); // generation unchanged
    expect(lastThrottle()).toBe(false); // idle grace
  });

  it('stale destroyed callback does not unregister a replacement guest', async () => {
    await manager.register('s1', 42);
    // Grab the destroyed handler registered by the FIRST guest.
    const destroyedHandler = mockWebContents.on.mock.calls.find(
      (c: unknown[]) => c[0] === 'destroyed',
    )?.[1] as () => void;
    // Replacement guest re-registers under the same surfaceId with a new wcId.
    await manager.register('s1', 43);
    destroyedHandler(); // stale guest (wcId 42) fires destroyed
    expect(manager.getTarget('s1')).not.toBeNull(); // replacement survives
  });
});

// ── #517 slice C — discard (memory relief) ──────────────────────────────────

describe('WebviewCdpManager discard mode (#517 slice C)', () => {
  let manager: WebviewCdpManager;
  const DWELL = 5 * 60_000;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    (mockWebContents as any).isCurrentlyAudible = vi.fn(() => false);
    manager = new WebviewCdpManager(18800);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const enterEligible = async (surfaceId = 's1', wcId = 42) => {
    await manager.register(surfaceId, wcId);
    manager.setLightweightMode(true);
    manager.setDiscardMode(true);
    manager.setVisibility(surfaceId, false);
  };

  it('discards a guest after the dwell period and signals the renderer', async () => {
    const onDiscard = vi.fn((sid: string) => manager.unregister(sid));
    manager.setDiscardHooks({ onDiscard });
    await enterEligible();
    expect(onDiscard).not.toHaveBeenCalled();
    vi.advanceTimersByTime(DWELL);
    expect(onDiscard).toHaveBeenCalledWith('s1');
    expect(manager.isDiscarded('s1')).toBe(true);
    expect(manager.getTarget('s1')).toBeNull();
  });

  it('becoming visible before the dwell elapses cancels the discard', async () => {
    const onDiscard = vi.fn();
    manager.setDiscardHooks({ onDiscard });
    await enterEligible();
    vi.advanceTimersByTime(DWELL - 1000);
    manager.setVisibility('s1', true);
    vi.advanceTimersByTime(DWELL * 2);
    expect(onDiscard).not.toHaveBeenCalled();
    expect(manager.isDiscarded('s1')).toBe(false);
  });

  it('an automation lease before the dwell elapses cancels the discard', async () => {
    const onDiscard = vi.fn();
    manager.setDiscardHooks({ onDiscard });
    await enterEligible();
    vi.advanceTimersByTime(DWELL - 1000);
    manager.acquireAutomationLease('s1');
    vi.advanceTimersByTime(DWELL * 2);
    expect(onDiscard).not.toHaveBeenCalled();
  });

  it('an audible guest is never discarded (dwell re-arms instead)', async () => {
    const onDiscard = vi.fn();
    manager.setDiscardHooks({ onDiscard });
    (mockWebContents as any).isCurrentlyAudible.mockReturnValue(true);
    await enterEligible();
    vi.advanceTimersByTime(DWELL);
    expect(onDiscard).not.toHaveBeenCalled();
    expect(manager.isDiscarded('s1')).toBe(false);
    // Audio stops — the re-armed dwell fires on its next tick.
    (mockWebContents as any).isCurrentlyAudible.mockReturnValue(false);
    vi.advanceTimersByTime(DWELL);
    expect(onDiscard).toHaveBeenCalledWith('s1');
  });

  it('discard mode OFF never discards even when lightweight is on', async () => {
    const onDiscard = vi.fn();
    manager.setDiscardHooks({ onDiscard });
    await manager.register('s1', 42);
    manager.setLightweightMode(true);
    manager.setVisibility('s1', false);
    vi.advanceTimersByTime(DWELL * 3);
    expect(onDiscard).not.toHaveBeenCalled();
  });

  it('ensureAwake wakes a discarded guest and resolves once it re-registers', async () => {
    const onDiscard = vi.fn((sid: string) => manager.unregister(sid));
    // Renderer remounts on wake → dom-ready re-registers the surface.
    const onWake = vi.fn((sid: string) => { void manager.register(sid, 43); });
    manager.setDiscardHooks({ onDiscard, onWake });
    await enterEligible();
    vi.advanceTimersByTime(DWELL);
    expect(manager.isDiscarded('s1')).toBe(true);

    const awake = manager.ensureAwake('s1');
    // Let the mocked register()'s async steps (fetch) settle — but do NOT run
    // all timers: the re-registered guest is still invisible, so a fresh dwell
    // timer arms immediately and running it would legitimately re-discard.
    await vi.advanceTimersByTimeAsync(100);
    const target = await awake;
    expect(onWake).toHaveBeenCalledWith('s1');
    expect(target).not.toBeNull();
    expect(manager.isDiscarded('s1')).toBe(false);
  });

  it('ensureAwake returns null for a surface that is neither registered nor discarded', async () => {
    const onWake = vi.fn();
    manager.setDiscardHooks({ onWake });
    expect(await manager.ensureAwake('ghost')).toBeNull();
    expect(onWake).not.toHaveBeenCalled();
  });

  it('re-registration after a discard clears the discarded flag', async () => {
    const onDiscard = vi.fn((sid: string) => manager.unregister(sid));
    manager.setDiscardHooks({ onDiscard });
    await enterEligible();
    vi.advanceTimersByTime(DWELL);
    expect(manager.isDiscarded('s1')).toBe(true);
    await manager.register('s1', 44);
    expect(manager.isDiscarded('s1')).toBe(false);
  });
});

// ── #517 slice C — review-team fixes ────────────────────────────────────────

describe('WebviewCdpManager discard fixes (3-way review)', () => {
  let manager: WebviewCdpManager;
  const DWELL = 5 * 60_000;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    (mockWebContents as any).isCurrentlyAudible = vi.fn(() => false);
    manager = new WebviewCdpManager(18800);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const discardOne = async (surfaceId = 's1', wcId = 42) => {
    await manager.register(surfaceId, wcId);
    manager.setLightweightMode(true);
    manager.setDiscardMode(true);
    manager.setVisibility(surfaceId, false);
    vi.advanceTimersByTime(DWELL);
  };

  it('fireDiscard retires the session BEFORE signalling the renderer (doomed-guest race)', async () => {
    let targetAtSignal: unknown = 'unset';
    manager.setDiscardHooks({
      onDiscard: () => { targetAtSignal = manager.getTarget('s1'); },
    });
    await discardOne();
    // Automation racing the renderer unmount must already see no target —
    // otherwise it leases a guest the queued unmount destroys mid-op.
    expect(targetAtSignal).toBeNull();
    expect(manager.isDiscarded('s1')).toBe(true);
  });

  it('concurrent ensureAwake calls share a single wake signal', async () => {
    const onWake = vi.fn((sid: string) => { void manager.register(sid, 43); });
    manager.setDiscardHooks({ onWake });
    await discardOne();
    const [a, b] = [manager.ensureAwake('s1'), manager.ensureAwake('s1')];
    await vi.advanceTimersByTimeAsync(100);
    expect(await a).not.toBeNull();
    expect(await b).not.toBeNull();
    expect(onWake).toHaveBeenCalledTimes(1);
  });

  it('ensureAwake without surfaceId wakes a discarded surface (codex P1)', async () => {
    const onWake = vi.fn((sid: string) => { void manager.register(sid, 43); });
    manager.setDiscardHooks({ onWake });
    await discardOne();
    const awake = manager.ensureAwake();
    await vi.advanceTimersByTimeAsync(100);
    expect((await awake)?.surfaceId).toBe('s1');
    expect(onWake).toHaveBeenCalledWith('s1');
  });

  it('turning discard mode off restores already-discarded panes', async () => {
    const onWake = vi.fn();
    manager.setDiscardHooks({ onWake });
    await discardOne();
    expect(manager.isDiscarded('s1')).toBe(true);
    manager.setDiscardMode(false);
    expect(onWake).toHaveBeenCalledWith('s1');
  });
});

describe('WebviewCdpManager register resilience (live dogfood)', () => {
  let manager: WebviewCdpManager;

  beforeEach(() => {
    vi.clearAllMocks();
    manager = new WebviewCdpManager(18800);
  });

  it('registers even when the debugger is already attached', async () => {
    // Electron throws "Debugger is already attached to the target"; an
    // exact-case guard missed it and aborted registration, which left a woken
    // (remounted) guest permanently unregistered — automation then failed with
    // "no webview target" until the pane was clicked.
    mockDebugger.attach.mockImplementationOnce(() => {
      throw new TypeError('Debugger is already attached to the target');
    });
    await manager.register('s1', 42);
    expect(manager.getTarget('s1')).not.toBeNull();
  });

  it('still aborts registration on a genuine attach failure', async () => {
    mockDebugger.attach.mockImplementationOnce(() => {
      throw new Error('Cannot attach: target crashed');
    });
    await manager.register('s1', 42);
    expect(manager.getTarget('s1')).toBeNull();
  });
});

describe('WebviewCdpManager restore-on-disable dedup (CodeRabbit, PR #530)', () => {
  let manager: WebviewCdpManager;
  const DWELL = 5 * 60_000;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    (mockWebContents as any).isCurrentlyAudible = vi.fn(() => false);
    manager = new WebviewCdpManager(18800);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not re-signal a surface that ensureAwake is already waking', async () => {
    const onWake = vi.fn(); // never registers → the wake stays in flight
    manager.setDiscardHooks({ onDiscard: (sid) => manager.unregister(sid), onWake });
    await manager.register('s1', 42);
    manager.setLightweightMode(true);
    manager.setDiscardMode(true);
    manager.setVisibility('s1', false);
    vi.advanceTimersByTime(DWELL);
    expect(manager.isDiscarded('s1')).toBe(true);

    const pending = manager.ensureAwake('s1'); // wake in flight
    await Promise.resolve();
    expect(onWake).toHaveBeenCalledTimes(1);

    manager.setDiscardMode(false); // must NOT emit a second wake
    expect(onWake).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(20_000); // let the in-flight wake time out
    await pending;
  });
});
