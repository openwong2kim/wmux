// F26 — a fan-out task pane's launch line is checked after it was written,
// and written once more only on positive evidence that it never arrived.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  verifyLaunchLine,
  type LaunchLineExpectation,
  type LaunchLineRead,
  type LaunchLineOutcome,
} from '../handlers/verifyLaunchLine';

/** bash at a prompt (`D;$? A`, PS1 ending in B at `promptAt`), `total` bytes out. */
const atPrompt = (total: number, promptAt = 180): LaunchLineRead => ({
  sessionFound: true,
  totalBytesWritten: total,
  events: [
    { type: 'command_end', byteOffset: 40 },
    { type: 'prompt_start', byteOffset: 40 },
    { type: 'prompt_end', byteOffset: promptAt },
  ],
});
const withRead = (total: number): LaunchLineRead => {
  const r = atPrompt(total);
  return { ...r, events: [...r.events, { type: 'command_start', byteOffset: 300 }] };
};
/** Before the shell drew anything but ConPTY's preamble. */
const booting: LaunchLineRead = { sessionFound: true, totalBytesWritten: 24, events: [] };

/** The daemon's compare-and-write (daemon/writeIfUnchanged.ts) against the
 *  pane as it is NOW: `live()`. Records every line it actually wrote. */
function fakeDaemonWrite(live: () => LaunchLineRead | null) {
  const writes: LaunchLineExpectation[] = [];
  const resendIfUnchanged = vi.fn(async (expect: LaunchLineExpectation) => {
    const now = live();
    const last = now?.events[now.events.length - 1] ?? null;
    const same =
      !!now &&
      now.totalBytesWritten === expect.outputBytes &&
      (now.eventCount ?? now.events.length) === expect.markerCount &&
      (last?.type ?? null) === (expect.lastPromptMarker?.type ?? null) &&
      (last?.byteOffset ?? null) === (expect.lastPromptMarker?.byteOffset ?? null);
    if (same) writes.push(expect);
    return same;
  });
  return { resendIfUnchanged, writes };
}

function run(reads: (call: number) => LaunchLineRead | null, nothingRunning = true) {
  const running = vi.fn(async () => nothingRunning);
  let outcome: LaunchLineOutcome | undefined;
  let call = 0;
  // The live pane is what the next read would see.
  const daemon = fakeDaemonWrite(() => reads(call));
  const resend = { get count() { return daemon.writes.length; } };
  verifyLaunchLine({
    read: async () => reads(call++),
    resendIfUnchanged: daemon.resendIfUnchanged,
    nothingRunning: running,
    pollMs: 100,
    quietMs: 1_000,
    windowMs: 10_000,
    onDone: (o) => { outcome = o; },
  });
  return { resend, running, daemon, outcome: () => outcome };
}

describe('verifyLaunchLine', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('writes the line once more when the shell drew its prompt after the line and never read it', async () => {
    // WSL under load: the line was typed while the distro was still starting.
    const v = run((n) => (n === 0 ? booting : atPrompt(180)));
    await vi.advanceTimersByTimeAsync(1_500);
    expect(v.running).toHaveBeenCalled();
    expect(v.resend.count).toBe(1);
  });

  it('never re-sends into a shell without command-start whose launched program has gone quiet', async () => {
    // macOS /bin/bash 3.2: prompt markers but no C. The prompt was drawn
    // before the line; bash read it, echoed it and runs it, and the program
    // then writes nothing. Its last marker is still that prompt.
    const v = run((n) => (n === 0 ? atPrompt(180) : atPrompt(420)));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(v.resend.count).toBe(0);
    expect(v.outcome()).toBe('unverified');
  });

  it('never re-sends on a prompt drawn before the line, even with nothing written since', async () => {
    const v = run(() => atPrompt(180));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(v.resend.count).toBe(0);
    expect(v.outcome()).toBe('unverified');
  });

  it('never re-sends when the daemon cannot say that nothing runs in the pane', async () => {
    const v = run((n) => (n === 0 ? booting : atPrompt(180)), false);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(v.running).toHaveBeenCalled();
    expect(v.resend.count).toBe(0);
    expect(v.outcome()).toBe('unverified');
  });

  // F26 review — getLaunchPresence reads the markers, then walks the process
  // table; the shell takes the first line meanwhile, and the answer comes back
  // `absent`. The pane changes AFTER the snapshot the decision used and BEFORE
  // the daemon's compare-and-write runs: nothing is written.
  it('never re-sends when the pane moved while the daemon was deciding', async () => {
    let live: LaunchLineRead = atPrompt(180);
    let answer!: (v: boolean) => void;
    const daemon = fakeDaemonWrite(() => live);
    let outcome: LaunchLineOutcome | undefined;
    let call = 0;
    verifyLaunchLine({
      read: async () => (call++ === 0 ? booting : live),
      resendIfUnchanged: daemon.resendIfUnchanged,
      nothingRunning: () => new Promise<boolean>((resolve) => { answer = resolve; }),
      pollMs: 100,
      quietMs: 1_000,
      windowMs: 10_000,
      onDone: (o) => { outcome = o; },
    });
    await vi.advanceTimersByTimeAsync(1_500);
    expect(answer).toBeTypeOf('function');
    live = atPrompt(260); // the echo lands before the stale verdict does
    answer(true);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(daemon.resendIfUnchanged).toHaveBeenCalledTimes(1);
    expect(daemon.writes).toHaveLength(0);
    expect(outcome).toBe('unverified');
  });

  it('never re-sends when a command-start arrived after the snapshot, the output size unchanged', async () => {
    let live: LaunchLineRead = atPrompt(180);
    let answer!: (v: boolean) => void;
    const daemon = fakeDaemonWrite(() => live);
    let call = 0;
    verifyLaunchLine({
      read: async () => (call++ === 0 ? booting : live),
      resendIfUnchanged: daemon.resendIfUnchanged,
      nothingRunning: () => new Promise<boolean>((resolve) => { answer = resolve; }),
      pollMs: 100,
      quietMs: 1_000,
      windowMs: 10_000,
    });
    await vi.advanceTimersByTimeAsync(1_500);
    live = withRead(180);
    answer(true);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(daemon.writes).toHaveLength(0);
  });

  it('sends the snapshot the decision was made on as the expectation', async () => {
    let answer!: (v: boolean) => void;
    const daemon = fakeDaemonWrite(() => atPrompt(180));
    let call = 0;
    verifyLaunchLine({
      read: async () => (call++ === 0 ? booting : atPrompt(180)),
      resendIfUnchanged: daemon.resendIfUnchanged,
      nothingRunning: () => new Promise<boolean>((resolve) => { answer = resolve; }),
      pollMs: 100,
      quietMs: 1_000,
      windowMs: 10_000,
    });
    await vi.advanceTimersByTimeAsync(1_500);
    answer(true);
    await vi.advanceTimersByTimeAsync(100);
    expect(daemon.resendIfUnchanged).toHaveBeenCalledWith({
      outputBytes: 180,
      markerCount: 3,
      lastPromptMarker: { type: 'prompt_end', byteOffset: 180 },
    });
    expect(daemon.writes).toHaveLength(1);
  });

  it('compares the whole prompt log, not the page it read, when the history is long', async () => {
    // 33 markers: the read returns the newest 32, the daemon compares all 33.
    const long = (): LaunchLineRead => ({ ...atPrompt(180), eventCount: 33 });
    const v = run((n) => (n === 0 ? booting : long()));
    await vi.advanceTimersByTimeAsync(2_000);
    expect(v.resend.count).toBe(1);
    expect(v.daemon.resendIfUnchanged).toHaveBeenCalledWith(expect.objectContaining({ markerCount: 33 }));
  });

  it('never re-sends when the line was echoed after a fresh prompt', async () => {
    // The typed-ahead line reached bash after its prompt: the echo is output.
    const v = run((n) => (n === 0 ? booting : atPrompt(180 + 120)));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(v.resend.count).toBe(0);
  });

  it('stops as soon as the shell shows it read the line (command-start), and never re-sends', async () => {
    const v = run((n) => (n === 0 ? booting : withRead(400)));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(v.resend.count).toBe(0);
    expect(v.outcome()).toBe('read');
  });

  it('re-sends at most once, then gives up', async () => {
    const v = run((n) => (n === 0 ? booting : atPrompt(180)));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(v.resend.count).toBe(1);
    expect(v.outcome()).toBe('gave-up');
  });

  it('reports the re-sent line once the shell read it', async () => {
    const v: ReturnType<typeof run> = run((n) => (n === 0 ? booting : v.resend.count > 0 ? withRead(500) : atPrompt(180)));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(v.resend.count).toBe(1);
    expect(v.outcome()).toBe('resent');
  });

  it('never re-sends into a pane with no prompt markers, or whose reads fail', async () => {
    const none = run(() => ({ sessionFound: true, totalBytesWritten: 0, events: [] }));
    const failing = run(() => null);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(none.resend.count).toBe(0);
    expect(failing.resend.count).toBe(0);
    expect(none.outcome()).toBe('unverified');
  });

  it('stops for a session that is gone', async () => {
    const v = run(() => ({ sessionFound: false, totalBytesWritten: 0, events: [] }));
    await vi.advanceTimersByTimeAsync(500);
    expect(v.outcome()).toBe('gone');
    expect(v.resend.count).toBe(0);
  });
});
