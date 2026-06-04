import { describe, it, expect, vi, afterEach } from 'vitest';
import { ProcessMonitor } from '../ProcessMonitor';

let monitor: ProcessMonitor;

afterEach(() => {
  if (monitor) {
    monitor.unwatchAll();
  }
});

describe('ProcessMonitor', () => {
  it('isAlive returns true for current process PID', async () => {
    expect(await ProcessMonitor.isAlive(process.pid)).toBe(true);
  });

  it('isAlive returns false for a non-existent PID', async () => {
    // PID 99999999 is extremely unlikely to exist
    expect(await ProcessMonitor.isAlive(99999999)).toBe(false);
  });

  it('watch calls onDead when process does not exist', async () => {
    monitor = new ProcessMonitor();
    const onDead = vi.fn();

    // Temporarily reduce check interval for test speed
    const origInterval = (ProcessMonitor as any).CHECK_INTERVAL_MS;
    Object.defineProperty(ProcessMonitor, 'CHECK_INTERVAL_MS', { value: 50, configurable: true });

    try {
      // Watch a PID that does not exist
      monitor.watch('sess-fake', 99999999, onDead);

      // Wait for the async check to complete. On Windows, watch() now triggers
      // an immediate first runBatchCheck (ProcessMonitor.ts), but tasklist
      // exec under CI CPU contention can take 1-6s per call and the cycle
      // does two of them (batch + per-PID re-verify). 15s buffer keeps this
      // robust against parallel-suite latency without masking real bugs.
      await vi.waitFor(() => {
        expect(onDead).toHaveBeenCalledTimes(1);
      }, { timeout: 15000 });
    } finally {
      Object.defineProperty(ProcessMonitor, 'CHECK_INTERVAL_MS', { value: origInterval, configurable: true });
    }
  }, 20000); // outer it() timeout — must exceed waitFor's 15s budget

  it('unwatch stops monitoring a session', async () => {
    monitor = new ProcessMonitor();
    const onDead = vi.fn();

    const origInterval = (ProcessMonitor as any).CHECK_INTERVAL_MS;
    Object.defineProperty(ProcessMonitor, 'CHECK_INTERVAL_MS', { value: 50, configurable: true });

    try {
      monitor.watch('sess-1', 99999999, onDead);
      monitor.unwatch('sess-1');

      // Wait a bit to ensure no callback fires
      await new Promise((r) => setTimeout(r, 200));

      expect(onDead).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(ProcessMonitor, 'CHECK_INTERVAL_MS', { value: origInterval, configurable: true });
    }
  });

  it('unwatchAll stops monitoring all sessions', async () => {
    monitor = new ProcessMonitor();
    const onDead1 = vi.fn();
    const onDead2 = vi.fn();

    const origInterval = (ProcessMonitor as any).CHECK_INTERVAL_MS;
    Object.defineProperty(ProcessMonitor, 'CHECK_INTERVAL_MS', { value: 50, configurable: true });

    try {
      monitor.watch('sess-1', 99999999, onDead1);
      monitor.watch('sess-2', 99999998, onDead2);
      monitor.unwatchAll();

      // Wait a bit to ensure no callback fires
      await new Promise((r) => setTimeout(r, 200));

      expect(onDead1).not.toHaveBeenCalled();
      expect(onDead2).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(ProcessMonitor, 'CHECK_INTERVAL_MS', { value: origInterval, configurable: true });
    }
  });

  it('watch does not call onDead for a living process', async () => {
    monitor = new ProcessMonitor();
    const onDead = vi.fn();

    const origInterval = (ProcessMonitor as any).CHECK_INTERVAL_MS;
    Object.defineProperty(ProcessMonitor, 'CHECK_INTERVAL_MS', { value: 50, configurable: true });

    try {
      // Watch current process — should stay alive
      monitor.watch('sess-alive', process.pid, onDead);

      // Wait for several check intervals
      await new Promise((r) => setTimeout(r, 300));

      expect(onDead).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(ProcessMonitor, 'CHECK_INTERVAL_MS', { value: origInterval, configurable: true });
    }
  });

  it('re-entrancy guard prevents overlapping batch checks', async () => {
    monitor = new ProcessMonitor();
    const batchSpy = vi.spyOn(ProcessMonitor, 'batchCheckAlive');

    // Make batchCheckAlive slow to simulate overlapping
    let resolveFirst: ((value: Set<number>) => void) | undefined;
    batchSpy.mockImplementationOnce(() => {
      return new Promise<Set<number>>((resolve) => {
        resolveFirst = (v) => resolve(v);
      });
    });

    const origInterval = (ProcessMonitor as any).CHECK_INTERVAL_MS;
    Object.defineProperty(ProcessMonitor, 'CHECK_INTERVAL_MS', { value: 50, configurable: true });

    try {
      const onDead = vi.fn();
      monitor.watch('sess-guard', process.pid, onDead);

      // Wait for first batch check to start
      await vi.waitFor(() => {
        expect(batchSpy).toHaveBeenCalledTimes(1);
      }, { timeout: 1000 });

      // Wait another interval — second check should be skipped due to batchRunning guard
      await new Promise((r) => setTimeout(r, 100));

      // batchCheckAlive should still only have been called once (second was skipped)
      expect(batchSpy).toHaveBeenCalledTimes(1);

      // Resolve the first check (report process as alive)
      resolveFirst!(new Set([process.pid]));
    } finally {
      Object.defineProperty(ProcessMonitor, 'CHECK_INTERVAL_MS', { value: origInterval, configurable: true });
      batchSpy.mockRestore();
    }
  });

  // Regression: a malformed/empty batch result must NOT cascade-fire onDead
  // for every watched session. The user-visible bug was "한번 터지면 모든
  // 터미널이 동시에 종료" — caused by tasklist returning unparseable output
  // once, which made aliveSet empty, which marked every PID dead in one tick.
  // The fix re-verifies each apparent-dead PID via isDefinitelyDead() before
  // firing onDead.
  it('does not cascade-fire onDead when batch returns empty set but PIDs are alive', async () => {
    monitor = new ProcessMonitor();
    const batchSpy = vi.spyOn(ProcessMonitor, 'batchCheckAlive');
    const deadSpy = vi.spyOn(ProcessMonitor, 'isDefinitelyDead');

    // Simulate the failure mode: batch reports nobody alive (parse failure),
    // but the per-PID re-verify confirms they are NOT dead (still alive).
    batchSpy.mockResolvedValue(new Set<number>());
    deadSpy.mockResolvedValue(false);

    const origInterval = (ProcessMonitor as any).CHECK_INTERVAL_MS;
    Object.defineProperty(ProcessMonitor, 'CHECK_INTERVAL_MS', { value: 50, configurable: true });

    try {
      const onDead1 = vi.fn();
      const onDead2 = vi.fn();
      const onDead3 = vi.fn();
      monitor.watch('sess-1', 11111, onDead1);
      monitor.watch('sess-2', 22222, onDead2);
      monitor.watch('sess-3', 33333, onDead3);

      // Wait for batch check + per-PID re-verify to complete
      await vi.waitFor(() => {
        expect(batchSpy).toHaveBeenCalled();
        expect(deadSpy).toHaveBeenCalled();
      }, { timeout: 2000 });

      // Give re-verify a chance to finish for all three
      await new Promise((r) => setTimeout(r, 200));

      // None of the dead callbacks should have fired — re-verify saved them
      expect(onDead1).not.toHaveBeenCalled();
      expect(onDead2).not.toHaveBeenCalled();
      expect(onDead3).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(ProcessMonitor, 'CHECK_INTERVAL_MS', { value: origInterval, configurable: true });
      batchSpy.mockRestore();
      deadSpy.mockRestore();
    }
  });

  it('still fires onDead when both batch and per-PID confirm death', async () => {
    monitor = new ProcessMonitor();
    const batchSpy = vi.spyOn(ProcessMonitor, 'batchCheckAlive');
    const deadSpy = vi.spyOn(ProcessMonitor, 'isDefinitelyDead');

    // Both layers agree this PID is gone — fire onDead.
    batchSpy.mockResolvedValue(new Set<number>());
    deadSpy.mockResolvedValue(true);

    const origInterval = (ProcessMonitor as any).CHECK_INTERVAL_MS;
    Object.defineProperty(ProcessMonitor, 'CHECK_INTERVAL_MS', { value: 50, configurable: true });

    try {
      const onDead = vi.fn();
      monitor.watch('sess-real-dead', 44444, onDead);

      await vi.waitFor(() => {
        expect(onDead).toHaveBeenCalledTimes(1);
      }, { timeout: 2000 });
    } finally {
      Object.defineProperty(ProcessMonitor, 'CHECK_INTERVAL_MS', { value: origInterval, configurable: true });
      batchSpy.mockRestore();
      deadSpy.mockRestore();
    }
  });

  // PRIMARY REGRESSION for the "powershell exits -1 / exitCode=null" false
  // death: when the liveness probe itself fails (tasklist times out), the
  // re-verify must NOT read that as death. The old gate used `!isAlive(pid)`,
  // and isAlive returns false on a probe error — so a slow tasklist killed
  // LIVE sessions. isDefinitelyDead throws on probe failure; the gate must
  // catch that and defer, never firing onDead.
  it('does NOT fire onDead when the death probe times out (live session survives a slow tasklist)', async () => {
    monitor = new ProcessMonitor();
    const batchSpy = vi.spyOn(ProcessMonitor, 'batchCheckAlive');
    const deadSpy = vi.spyOn(ProcessMonitor, 'isDefinitelyDead');

    // Batch can't see the PID (timed out → empty), and the per-PID confirm
    // probe also fails (tasklist timeout). The process is actually ALIVE.
    batchSpy.mockResolvedValue(new Set<number>());
    deadSpy.mockRejectedValue(Object.assign(new Error('tasklist ETIMEDOUT'), { code: 'ETIMEDOUT' }));

    const origInterval = (ProcessMonitor as any).CHECK_INTERVAL_MS;
    Object.defineProperty(ProcessMonitor, 'CHECK_INTERVAL_MS', { value: 50, configurable: true });

    try {
      const onDead = vi.fn();
      monitor.watch('sess-alive-but-probe-slow', 55555, onDead);

      await vi.waitFor(() => {
        expect(deadSpy).toHaveBeenCalled();
      }, { timeout: 2000 });
      await new Promise((r) => setTimeout(r, 150));

      // The whole point: a probe timeout must never be read as a death.
      expect(onDead).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(ProcessMonitor, 'CHECK_INTERVAL_MS', { value: origInterval, configurable: true });
      batchSpy.mockRestore();
      deadSpy.mockRestore();
    }
  });

  it('only re-verifies the apparent-dead subset, not the whole watch list', async () => {
    monitor = new ProcessMonitor();
    const batchSpy = vi.spyOn(ProcessMonitor, 'batchCheckAlive');
    const deadSpy = vi.spyOn(ProcessMonitor, 'isDefinitelyDead');

    // Three watched, one missing from batch result.
    batchSpy.mockResolvedValue(new Set<number>([11111, 22222]));
    deadSpy.mockResolvedValue(true);

    const origInterval = (ProcessMonitor as any).CHECK_INTERVAL_MS;
    Object.defineProperty(ProcessMonitor, 'CHECK_INTERVAL_MS', { value: 50, configurable: true });

    try {
      const onDead1 = vi.fn();
      const onDead2 = vi.fn();
      const onDead3 = vi.fn();
      monitor.watch('alive-1', 11111, onDead1);
      monitor.watch('alive-2', 22222, onDead2);
      monitor.watch('dead-3', 33333, onDead3);

      await vi.waitFor(() => {
        expect(onDead3).toHaveBeenCalledTimes(1);
      }, { timeout: 2000 });

      // Only the missing one should have been re-verified
      expect(deadSpy).toHaveBeenCalledTimes(1);
      expect(deadSpy).toHaveBeenCalledWith(33333);
      expect(onDead1).not.toHaveBeenCalled();
      expect(onDead2).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(ProcessMonitor, 'CHECK_INTERVAL_MS', { value: origInterval, configurable: true });
      batchSpy.mockRestore();
      deadSpy.mockRestore();
    }
  });
});
