import { describe, it, expect, vi, afterEach } from 'vitest';
import { ProcessMonitor } from '../ProcessMonitor';

// app-weight P1-1 — PID-reuse detection via tasklist image names, and the
// tasklist CSV parser it rides on. Statics are stubbed so these run on any
// platform without spawning tasklist.
afterEach(() => {
  vi.restoreAllMocks();
});

describe('ProcessMonitor.parseTasklistCsv', () => {
  it('extracts alive PIDs and image names, scoped to the requested set', () => {
    const stdout = [
      '"pwsh.exe","1234","Console","1","95,000 K"',
      '"chrome.exe","5678","Console","1","300,000 K"',
      '"node.exe","9999","Console","1","90,000 K"',
    ].join('\n');
    const { alive, images } = ProcessMonitor.parseTasklistCsv(stdout, new Set([1234, 9999]));
    expect([...alive].sort()).toEqual([1234, 9999]);
    expect(images.get(1234)).toBe('pwsh.exe');
    expect(images.get(9999)).toBe('node.exe');
    expect(images.has(5678)).toBe(false);
  });

  it('ignores locale banners, headers, and malformed lines', () => {
    const stdout = [
      'INFO: No tasks are running which match the specified criteria.',
      '정보: 지정된 조건과 일치하는 작업이 없습니다.',
      '"broken line without pid"',
      '',
      '"pwsh.exe","42","Console","1","95,000 K"',
    ].join('\n');
    const { alive, images } = ProcessMonitor.parseTasklistCsv(stdout, new Set([42]));
    expect([...alive]).toEqual([42]);
    expect(images.get(42)).toBe('pwsh.exe');
  });
});

describe('ProcessMonitor — PID reuse detection (watch loop)', () => {
  function tick(monitor: ProcessMonitor): Promise<void> {
    // runBatchCheck is private; drive it via the public immediate-check in
    // watch() or by calling it directly through the any-cast (test seam).
    return (monitor as unknown as { runBatchCheck: () => void; batchRunning: boolean })
      .runBatchCheck() as unknown as Promise<void> ?? Promise.resolve();
  }
  async function settle(): Promise<void> {
    // runBatchCheck chains promises internally; yield a few microtasks.
    for (let i = 0; i < 8; i++) await Promise.resolve();
  }

  it('fires onDead when the PID answers under a DIFFERENT image (reuse confirmed by re-probe)', async () => {
    const onDead = vi.fn();
    const monitor = new ProcessMonitor(60_000);
    let image = 'pwsh.exe';
    vi.spyOn(ProcessMonitor, 'batchCheckAliveDetailed').mockImplementation(async () => ({
      alive: new Set([100]),
      images: new Map([[100, image]]),
    }));
    const probeSpy = vi.spyOn(ProcessMonitor, 'probeWindowsPid').mockImplementation(async () => ({
      present: true,
      imageName: image,
    }));

    monitor.watch('sess-1', 100, onDead); // tick 1 — binds pwsh.exe
    await settle();
    expect(onDead).not.toHaveBeenCalled();

    image = 'chrome.exe'; // OS recycled the PID
    await tick(monitor);
    await settle();
    expect(probeSpy).toHaveBeenCalled(); // re-verified before declaring death
    expect(onDead).toHaveBeenCalledTimes(1);
    monitor.unwatchAll();
  });

  it('defers (never dead) when the reuse re-probe itself fails — unknown is not dead', async () => {
    const onDead = vi.fn();
    const monitor = new ProcessMonitor(60_000);
    let image = 'pwsh.exe';
    vi.spyOn(ProcessMonitor, 'batchCheckAliveDetailed').mockImplementation(async () => ({
      alive: new Set([100]),
      images: new Map([[100, image]]),
    }));
    vi.spyOn(ProcessMonitor, 'probeWindowsPid').mockRejectedValue(new Error('tasklist timeout'));

    monitor.watch('sess-1', 100, onDead);
    await settle();
    image = 'chrome.exe';
    await tick(monitor);
    await settle();
    expect(onDead).not.toHaveBeenCalled(); // deferred to a later cycle
    monitor.unwatchAll();
  });

  it('a batch-parse glitch (re-probe shows the SAME image) does not kill the session', async () => {
    const onDead = vi.fn();
    const monitor = new ProcessMonitor(60_000);
    let batchImage = 'pwsh.exe';
    vi.spyOn(ProcessMonitor, 'batchCheckAliveDetailed').mockImplementation(async () => ({
      alive: new Set([100]),
      images: new Map([[100, batchImage]]),
    }));
    vi.spyOn(ProcessMonitor, 'probeWindowsPid').mockResolvedValue({
      present: true,
      imageName: 'pwsh.exe', // authoritative re-probe: unchanged
    });

    monitor.watch('sess-1', 100, onDead);
    await settle();
    batchImage = 'PWSH.EXE-corrupted-parse';
    await tick(monitor);
    await settle();
    expect(onDead).not.toHaveBeenCalled();
    monitor.unwatchAll();
  });

  it('image comparison is case-insensitive (tasklist casing varies by source)', async () => {
    const onDead = vi.fn();
    const monitor = new ProcessMonitor(60_000);
    let image = 'pwsh.exe';
    vi.spyOn(ProcessMonitor, 'batchCheckAliveDetailed').mockImplementation(async () => ({
      alive: new Set([100]),
      images: new Map([[100, image]]),
    }));
    vi.spyOn(ProcessMonitor, 'probeWindowsPid').mockResolvedValue({ present: true, imageName: 'PWSH.EXE' });

    monitor.watch('sess-1', 100, onDead);
    await settle();
    image = 'PWSH.EXE'; // same process, different casing — NOT a reuse
    await tick(monitor);
    await settle();
    expect(onDead).not.toHaveBeenCalled();
    monitor.unwatchAll();
  });
});
