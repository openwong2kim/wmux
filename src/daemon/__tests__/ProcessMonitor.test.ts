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

      // Wait for the async check to complete
      await vi.waitFor(() => {
        expect(onDead).toHaveBeenCalledTimes(1);
      }, { timeout: 5000 });
    } finally {
      Object.defineProperty(ProcessMonitor, 'CHECK_INTERVAL_MS', { value: origInterval, configurable: true });
    }
  });

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

  it('re-entrancy guard prevents overlapping checks', async () => {
    monitor = new ProcessMonitor();
    const isAliveSpy = vi.spyOn(ProcessMonitor, 'isAlive');

    // Make isAlive slow to simulate overlapping
    let resolveFirst: (() => void) | undefined;
    isAliveSpy.mockImplementationOnce(() => {
      return new Promise<boolean>((resolve) => {
        resolveFirst = () => resolve(true);
      });
    });

    const origInterval = (ProcessMonitor as any).CHECK_INTERVAL_MS;
    Object.defineProperty(ProcessMonitor, 'CHECK_INTERVAL_MS', { value: 50, configurable: true });

    try {
      const onDead = vi.fn();
      monitor.watch('sess-guard', process.pid, onDead);

      // Wait for first check to start
      await vi.waitFor(() => {
        expect(isAliveSpy).toHaveBeenCalledTimes(1);
      }, { timeout: 1000 });

      // Wait another interval — second check should be skipped due to guard
      await new Promise((r) => setTimeout(r, 100));

      // isAlive should still only have been called once (second was skipped)
      expect(isAliveSpy).toHaveBeenCalledTimes(1);

      // Resolve the first check
      resolveFirst!();
    } finally {
      Object.defineProperty(ProcessMonitor, 'CHECK_INTERVAL_MS', { value: origInterval, configurable: true });
      isAliveSpy.mockRestore();
    }
  });
});
