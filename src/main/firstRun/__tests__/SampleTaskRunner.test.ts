import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OSC133_TIMEOUT_MS, SAMPLE_TASK_COMMAND } from '../../../shared/firstRun';
import { SampleTaskRunner, type PtyDataSource } from '../SampleTaskRunner';

/**
 * Stub PtyDataSource — collects writes and exposes `pushData(chunk)` so tests
 * can inject byte sequences synchronously into whichever handler the runner
 * subscribed.
 *
 * Multiple handlers are tracked defensively, but the runner only ever
 * subscribes once per `run()` invocation.
 */
interface StubSource extends PtyDataSource {
  pushData(chunk: string): void;
  getWrites(): string[];
  handlerCount(): number;
}

function createStubSource(): StubSource {
  const handlers = new Set<(chunk: string) => void>();
  const writes: string[] = [];
  return {
    onData(handler) {
      handlers.add(handler);
      return () => {
        handlers.delete(handler);
      };
    },
    write(data) {
      writes.push(data);
    },
    pushData(chunk) {
      // Snapshot first to avoid surprises if a handler unsubscribes itself
      // mid-iteration (the runner does exactly that on match).
      for (const h of [...handlers]) h(chunk);
    },
    getWrites() {
      return writes;
    },
    handlerCount() {
      return handlers.size;
    },
  };
}

describe('SampleTaskRunner', () => {
  let runner: SampleTaskRunner;

  beforeEach(() => {
    runner = new SampleTaskRunner();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ── 1. OK with BEL terminator ─────────────────────────────────

  it('resolves ok and writes command on OSC133 BEL-terminated prompt-ready', async () => {
    const source = createStubSource();
    const ctrl = new AbortController();
    const promise = runner.run(source, ctrl.signal);

    source.pushData('\x1b]133;A\x07');

    const result = await promise;
    expect(result).toEqual({ outcome: 'ok' });
    expect(source.getWrites()).toEqual([SAMPLE_TASK_COMMAND + '\r']);
    // Listener disposed after match.
    expect(source.handlerCount()).toBe(0);
  });

  // ── 2. OK with ST (ESC \) terminator ──────────────────────────

  it('resolves ok on OSC133 ST-terminated prompt-ready', async () => {
    const source = createStubSource();
    const ctrl = new AbortController();
    const promise = runner.run(source, ctrl.signal);

    source.pushData('\x1b]133;A\x1b\\');

    const result = await promise;
    expect(result).toEqual({ outcome: 'ok' });
    expect(source.getWrites()).toEqual([SAMPLE_TASK_COMMAND + '\r']);
  });

  // ── 3. OK across split chunks ─────────────────────────────────

  it('matches OSC133 sequence split across chunks', async () => {
    const source = createStubSource();
    const ctrl = new AbortController();
    const promise = runner.run(source, ctrl.signal);

    // Realistic: TTY emits the OSC sequence in two TCP/pipe frames.
    source.pushData('garbage prefix \x1b]133;');
    source.pushData('A\x07 trailing');

    const result = await promise;
    expect(result).toEqual({ outcome: 'ok' });
    expect(source.getWrites()).toEqual([SAMPLE_TASK_COMMAND + '\r']);
  });

  // ── 4. Timeout when OSC133 never arrives ──────────────────────

  it('resolves timeout after OSC133_TIMEOUT_MS without OSC133', async () => {
    vi.useFakeTimers();
    const source = createStubSource();
    const ctrl = new AbortController();
    const promise = runner.run(source, ctrl.signal);

    // Push some shell noise that doesn't include OSC133.
    source.pushData('regular shell output\n$ ');

    vi.advanceTimersByTime(OSC133_TIMEOUT_MS);

    const result = await promise;
    expect(result).toEqual({ outcome: 'timeout' });
    expect(source.getWrites()).toEqual([]);
    expect(source.handlerCount()).toBe(0);
  });

  // ── 5. Abort mid-flight ───────────────────────────────────────

  it('resolves aborted when signal fires before OSC133 or timeout', async () => {
    vi.useFakeTimers();
    const source = createStubSource();
    const ctrl = new AbortController();
    const promise = runner.run(source, ctrl.signal);

    source.pushData('still no prompt');
    ctrl.abort();

    const result = await promise;
    expect(result).toEqual({ outcome: 'aborted' });
    expect(source.getWrites()).toEqual([]);
    expect(source.handlerCount()).toBe(0);

    // Make sure the timer was cleared — advancing past the timeout must
    // NOT cause a second resolution / change of state.
    vi.advanceTimersByTime(OSC133_TIMEOUT_MS + 1000);
    // No assertion on the promise (already settled); verifying no throw is enough.
  });

  // ── 6. Already aborted at call time ───────────────────────────

  it('resolves aborted immediately when signal is already aborted', async () => {
    const source = createStubSource();
    const ctrl = new AbortController();
    ctrl.abort();

    const result = await runner.run(source, ctrl.signal);
    expect(result).toEqual({ outcome: 'aborted' });
    // Should never have subscribed in the first place.
    expect(source.handlerCount()).toBe(0);
    expect(source.getWrites()).toEqual([]);
  });

  // ── 7. Idempotent cleanup — match wins over timeout ───────────

  it('only resolves once when OSC133 arrives then timeout would fire', async () => {
    vi.useFakeTimers();
    const source = createStubSource();
    const ctrl = new AbortController();
    const promise = runner.run(source, ctrl.signal);

    source.pushData('\x1b]133;A\x07');
    // Advance past the timeout — the timer should already be cleared.
    vi.advanceTimersByTime(OSC133_TIMEOUT_MS + 1000);

    const result = await promise;
    expect(result).toEqual({ outcome: 'ok' });
    // Single write — no duplicate from a stale code path.
    expect(source.getWrites()).toEqual([SAMPLE_TASK_COMMAND + '\r']);
    expect(source.handlerCount()).toBe(0);

    // Pushing more data after disposal is a no-op (handler already removed).
    source.pushData('\x1b]133;A\x07');
    expect(source.getWrites()).toEqual([SAMPLE_TASK_COMMAND + '\r']);
  });

  // ── 8. Buffer cap smoke test ──────────────────────────────────

  it('caps the scan buffer and still times out on 100KB of garbage', async () => {
    vi.useFakeTimers();
    const source = createStubSource();
    const ctrl = new AbortController();
    const promise = runner.run(source, ctrl.signal);

    // Feed 100 KB of garbage in 1 KB increments. No OSC133 anywhere.
    const KB = 1024;
    const chunk = 'x'.repeat(KB);
    expect(() => {
      for (let i = 0; i < 100; i++) source.pushData(chunk);
    }).not.toThrow();

    vi.advanceTimersByTime(OSC133_TIMEOUT_MS);

    const result = await promise;
    expect(result).toEqual({ outcome: 'timeout' });
    expect(source.getWrites()).toEqual([]);
  });
});

describe('SAMPLE_TASK_COMMAND (#452)', () => {
  it('launches claude with the sample prompt instead of pasting a bare prompt', () => {
    // The OSC133 prompt-ready we scan for is emitted by the *shell* (e.g. pwsh
    // shell integration), not by Claude — nothing spawns Claude in the pane on
    // its own. So the injected command must invoke `claude`; a bare prompt
    // would be run as a shell command and land in PowerShell (the #452 bug).
    expect(SAMPLE_TASK_COMMAND).toMatch(/^claude\s+"/);
    expect(SAMPLE_TASK_COMMAND).toContain('browser_open');
  });
});
