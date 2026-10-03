// The fan-out caller nudge's daemon write, on a real DaemonPTYBridge input
// path: what a person types into the pane decides whether the line waits, and
// a key pressed between the paste and the Enter cancels the Enter.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { IPty } from 'node-pty';
import { DaemonPTYBridge } from '../DaemonPTYBridge';
import { RingBuffer } from '../RingBuffer';
import { deliverCallerNudge, CALLER_NUDGE_QUIET_MS } from '../callerNudgeDelivery';
import { deliverScheduledPrompt } from '../sessionPromptDelivery';
import type { ScheduledPromptDeliveryDeps } from '../sessionPromptDelivery';

const LINE = '[wmux] fan-out task 6k7g7szw updated — channel_mission_list';

function makeFakePty(): IPty {
  return {
    onData: () => ({ dispose: () => undefined }),
    onExit: () => ({ dispose: () => undefined }),
  } as unknown as IPty;
}

describe('deliverCallerNudge', () => {
  let bridge: DaemonPTYBridge;
  let writes: string[];
  /** Runs between the paste and the Enter (the submit delay). */
  let duringSubmitDelay: () => void;

  const deliver = (opts: Pick<ScheduledPromptDeliveryDeps, 'authorized' | 'onWrite'>) =>
    deliverScheduledPrompt('claude', 'inc-1', LINE, {
      ...opts,
      getAgentState: () => ({
        slug: 'claude',
        incarnationId: 'inc-1',
        status: 'idle',
        inputQuiet: true,
        inputRevision: bridge.getInputRevision(),
      }),
      isAgentProcessAlive: async () => true,
      write: (data) => {
        writes.push(data);
        bridge.noteInput(data);
        return true;
      },
      delay: async () => duringSubmitDelay(),
    });

  const run = () =>
    deliverCallerNudge(LINE, { usageHeld: () => false, input: () => bridge, deliver });

  beforeEach(() => {
    vi.useFakeTimers();
    bridge = new DaemonPTYBridge();
    bridge.setupDataForwarding(makeFakePty(), new RingBuffer(65536), 'sess-1');
    writes = [];
    duringSubmitDelay = () => undefined;
  });

  afterEach(() => {
    bridge.cleanup();
    vi.useRealTimers();
  });

  it('writes the line and the Enter into a quiet pane', async () => {
    vi.advanceTimersByTime(CALLER_NUDGE_QUIET_MS);
    expect(await run()).toEqual({ result: 'sent', pasted: true });
    expect(writes).toEqual([`\x1b[200~${LINE}\x1b[201~`, '\r']);
  });

  it('waits while a person has a draft in the composer, and goes once it is sent or cleared', async () => {
    vi.advanceTimersByTime(CALLER_NUDGE_QUIET_MS);
    bridge.noteInput('half a th');
    vi.advanceTimersByTime(CALLER_NUDGE_QUIET_MS);
    expect(await run()).toEqual({ result: 'held', pasted: false });
    expect(writes).toEqual([]);
    bridge.noteInput('\x15'); // Ctrl+U empties the composer
    vi.advanceTimersByTime(CALLER_NUDGE_QUIET_MS);
    expect((await run()).result).toBe('sent');
  });

  it('waits for 10 s of no key input', async () => {
    bridge.noteInput('\x1b[A'); // an arrow key: no draft, but a person is there
    vi.advanceTimersByTime(CALLER_NUDGE_QUIET_MS - 1000);
    expect(await run()).toEqual({ result: 'held', pasted: false });
    vi.advanceTimersByTime(1000);
    expect((await run()).result).toBe('sent');
  });

  it('writes the PR owner line too (the same template check, combined)', async () => {
    vi.advanceTimersByTime(CALLER_NUDGE_QUIET_MS);
    const pr = '[wmux] PR #12: CI failed — gh pr checks 12';
    const prDeliver = vi.fn(async () => 'sent' as const);
    expect(await deliverCallerNudge(pr, { usageHeld: () => false, input: () => bridge, deliver: prDeliver })).toEqual({ result: 'sent', pasted: true });
    expect(prDeliver).toHaveBeenCalledTimes(1);
  });

    it('cancels the Enter when anything else reaches the pane after the paste', async () => {
    vi.advanceTimersByTime(CALLER_NUDGE_QUIET_MS);
    duringSubmitDelay = () => bridge.noteInput('x');
    expect(await run()).toEqual({ result: 'error', pasted: true });
    expect(writes).toEqual([`\x1b[200~${LINE}\x1b[201~`]);
  });

  it('refuses any text that is not the fixed template, and holds at a usage limit', async () => {
    vi.advanceTimersByTime(CALLER_NUDGE_QUIET_MS);
    expect(await deliverCallerNudge('worker said: hi', { usageHeld: () => false, input: () => bridge, deliver })).toEqual({
      result: 'error',
      pasted: false,
    });
    expect(
      await deliverCallerNudge('[wmux] PR #12: CI failed — gh pr checks 12; npm ERR! see log', { usageHeld: () => false, input: () => bridge, deliver }),
    ).toEqual({ result: 'error', pasted: false });
    expect(await deliverCallerNudge(LINE, { usageHeld: () => true, input: () => bridge, deliver })).toEqual({
      result: 'held',
      pasted: false,
    });
    expect(writes).toEqual([]);
  });
});
