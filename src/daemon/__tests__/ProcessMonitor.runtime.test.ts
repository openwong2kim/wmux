import { describe, it, expect, vi, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import { ProcessMonitor } from '../ProcessMonitor';
import { deliberateSleep } from '../../test-utils/waitFor';

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

  it('isRunning returns true for current process PID', async () => {
    expect(await ProcessMonitor.isRunning(process.pid)).toBe(true);
  });

  it.skipIf(process.platform === 'win32')(
    'isRunning returns false for a non-existent PID',
    async () => {
      expect(await ProcessMonitor.isRunning(99999999)).toBe(false);
    },
  );

  it.skipIf(process.platform === 'win32')(
    'isRunning returns false for a zombie process — the #1307 regression guard',
    async () => {
      // perl forks; the child exits and the never-waiting parent sleeps,
      // so it stays a zombie (STAT 'Z', still visible to kill(pid, 0))
      // until we kill the parent below (Node only reaps its own children).
      const parent = spawn('perl', [
        '-e',
        '$|=1; my $p=fork(); if($p==0){exit 0} else {print "$p\\n"; sleep 5}',
      ]);
      try {
        const zombiePid = await new Promise<number>((resolve, reject) => {
          let buf = '';
          parent.stdout?.on('data', (chunk: Buffer) => {
            buf += chunk.toString();
            const match = buf.match(/(\d+)/);
            if (match) resolve(parseInt(match[1], 10));
          });
          parent.once('error', reject);
        });
        await vi.waitFor(async () => {
          expect(await ProcessMonitor.isRunning(zombiePid)).toBe(false);
        }, { timeout: 2000 });
        expect(await ProcessMonitor.isAlive(zombiePid)).toBe(true);
      } finally {
        parent.kill('SIGKILL');
      }
    },
  );

  it.skipIf(process.platform === 'win32')(
    'isRunning returns false for a SIGSTOPped process that isAlive still reports true — the #1307 regression guard',
    async () => {
      const child = spawn('sleep', ['30']);
      const pid = child.pid;
      if (pid === undefined) throw new Error('sleep did not spawn');
      try {
        process.kill(pid, 'SIGSTOP');
        // Give the kernel a moment to land the state transition.
        await vi.waitFor(async () => {
          expect(await ProcessMonitor.isRunning(pid)).toBe(false);
        }, { timeout: 2000 });
        expect(await ProcessMonitor.isAlive(pid)).toBe(true);
      } finally {
        process.kill(pid, 'SIGCONT');
        child.kill('SIGKILL');
      }
    },
  );

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
      await deliberateSleep(200, 'negative: no death callback after unwatch');

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
      await deliberateSleep(200, 'negative: no death callback after unwatchAll');

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
      await deliberateSleep(300, 'negative: a live process is never reported dead over several intervals');

      expect(onDead).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(ProcessMonitor, 'CHECK_INTERVAL_MS', { value: origInterval, configurable: true });
    }
  });

  it('re-entrancy guard prevents overlapping batch checks', async () => {
    monitor = new ProcessMonitor();
    // P1-1: the watch loop consumes batchCheckAliveDetailed (alive + images).
    const batchSpy = vi.spyOn(ProcessMonitor, 'batchCheckAliveDetailed');

    // Make the batch slow to simulate overlapping
    let resolveFirst: ((value: Set<number>) => void) | undefined;
    batchSpy.mockImplementationOnce(() => {
      return new Promise<{ alive: Set<number>; images: Map<number, string> }>((resolve) => {
        resolveFirst = (v) => resolve({ alive: v, images: new Map() });
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
      await deliberateSleep(100, 'negative: the next interval is skipped while a batch runs');

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
    const batchSpy = vi.spyOn(ProcessMonitor, 'batchCheckAliveDetailed');
    const deadSpy = vi.spyOn(ProcessMonitor, 'isDefinitelyDead');

    // Simulate the failure mode: batch reports nobody alive (parse failure),
    // but the per-PID re-verify confirms they are NOT dead (still alive).
    batchSpy.mockResolvedValue({ alive: new Set<number>(), images: new Map<number, string>() });
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
      await deliberateSleep(200, 'negative: re-verify must not fire the death callbacks');

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
    const batchSpy = vi.spyOn(ProcessMonitor, 'batchCheckAliveDetailed');
    const deadSpy = vi.spyOn(ProcessMonitor, 'isDefinitelyDead');

    // Both layers agree this PID is gone — fire onDead.
    batchSpy.mockResolvedValue({ alive: new Set<number>(), images: new Map<number, string>() });
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
    const batchSpy = vi.spyOn(ProcessMonitor, 'batchCheckAliveDetailed');
    const deadSpy = vi.spyOn(ProcessMonitor, 'isDefinitelyDead');

    // Batch can't see the PID (timed out → empty), and the per-PID confirm
    // probe also fails (tasklist timeout). The process is actually ALIVE.
    batchSpy.mockResolvedValue({ alive: new Set<number>(), images: new Map<number, string>() });
    deadSpy.mockRejectedValue(Object.assign(new Error('tasklist ETIMEDOUT'), { code: 'ETIMEDOUT' }));

    const origInterval = (ProcessMonitor as any).CHECK_INTERVAL_MS;
    Object.defineProperty(ProcessMonitor, 'CHECK_INTERVAL_MS', { value: 50, configurable: true });

    try {
      const onDead = vi.fn();
      monitor.watch('sess-alive-but-probe-slow', 55555, onDead);

      await vi.waitFor(() => {
        expect(deadSpy).toHaveBeenCalled();
      }, { timeout: 2000 });
      await deliberateSleep(150, 'negative: a probe timeout is never read as a death');

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
    const batchSpy = vi.spyOn(ProcessMonitor, 'batchCheckAliveDetailed');
    const deadSpy = vi.spyOn(ProcessMonitor, 'isDefinitelyDead');

    // Three watched, one missing from batch result.
    batchSpy.mockResolvedValue({ alive: new Set<number>([11111, 22222]), images: new Map<number, string>() });
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
