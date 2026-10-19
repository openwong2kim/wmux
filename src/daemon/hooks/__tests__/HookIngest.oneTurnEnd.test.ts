// One turn has one end. A turn end that arrives while the pane's latest
// episode already had its end is dropped at intake, keyed on the daemon's own
// episode id, never on time:
// the real StopFailure after the transcript's stand-in for it
// (daemon/transcript/apiErrorTurnEnd), and the stand-in after the real hook.
// HookIngest is wired to a real DaemonPTYBridge the way the daemon wires them:
// every broadcast settles the bridge through noteAgentStatus.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { IPty } from 'node-pty';
import { HookIngest, type HookAgentEventData } from '../HookIngest';
import { DaemonPTYBridge } from '../../DaemonPTYBridge';
import { PromptEventLog } from '../../PromptEventLog';
import { RingBuffer } from '../../RingBuffer';
import { DEFAULT_ALARM_WINDOW_MS } from '../../../shared/hooks/CompletionAlarm';
import type { AgentSignal } from '../../../shared/hooks/signal-types';

function makeFakePty(): IPty {
  return {
    onData: () => ({ dispose: () => undefined }),
    onExit: () => ({ dispose: () => undefined }),
  } as unknown as IPty;
}

describe('HookIngest — one turn, one end', () => {
  let bridge: DaemonPTYBridge;
  let ingest: HookIngest;
  let emitted: HookAgentEventData[];

  const signal = (kind: AgentSignal['kind'], ts = Date.now(), payload: Record<string, unknown> = {}): AgentSignal =>
    ({ kind, agent: 'claude', cwd: '/repo', ptyId: 'pty-a', payload, ts });
  const failure = (ts = Date.now()) => signal('agent.stop_failure', ts, { error: 'oauth_org_not_allowed', last_assistant_message: 'disabled' });
  const ends = () => emitted.filter((e) => e.signal.kind === 'agent.stop_failure' || e.signal.kind === 'agent.stop');

  beforeEach(() => {
    vi.useFakeTimers();
    bridge = new DaemonPTYBridge();
    bridge.setupDataForwarding(makeFakePty(), new RingBuffer(65536), 'pty-a', new PromptEventLog());
    emitted = [];
    ingest = new HookIngest({
      listLiveSessions: () => [{ id: 'pty-a', cwd: '/repo', env: { WMUX_WORKSPACE_ID: 'ws-1' }, lastActivity: '2026-01-01T00:00:00.000Z' }],
      emitAgentEvent: (_id, data) => {
        emitted.push(data);
        if (data.status === 'running' || data.status === 'complete' || data.status === 'error' || data.status === 'awaiting_input') {
          // `provisional` stands for the daemon's unconfirmed Codex stop (a soft close).
          bridge.noteAgentStatus(data.status, true, undefined, data.signal.payload?.['provisional'] === true, data.signal.ts);
        }
      },
      applyResumeBinding: () => undefined,
      log: () => undefined,
      latestEndedTurn: () => bridge.endedTurnId(),
    });
  });

  afterEach(() => {
    ingest.dispose();
    bridge.cleanup();
    vi.useRealTimers();
  });

  it('drops the real StopFailure that lands after the transcript already ended the turn', () => {
    ingest.handle(signal('agent.user_prompt_submit'));
    const firedAt = Date.now() + 500;
    vi.advanceTimersByTime(5_500);
    // The stand-in, sent after the grace.
    ingest.handle(failure());
    vi.advanceTimersByTime(DEFAULT_ALARM_WINDOW_MS);
    expect(bridge.isTurnOpen()).toBe(false);
    // The real hook, slow to start, fired with the error and arrives now.
    vi.advanceTimersByTime(1_500);
    ingest.handle(failure(firedAt));
    vi.advanceTimersByTime(DEFAULT_ALARM_WINDOW_MS);
    expect(ends()).toHaveLength(1);
  });

  it('drops the stand-in that lands after the real StopFailure ended the turn', () => {
    ingest.handle(signal('agent.user_prompt_submit'));
    vi.advanceTimersByTime(500);
    ingest.handle(failure());
    vi.advanceTimersByTime(DEFAULT_ALARM_WINDOW_MS);
    vi.advanceTimersByTime(5_000);
    ingest.handle(failure());
    vi.advanceTimersByTime(DEFAULT_ALARM_WINDOW_MS);
    expect(ends()).toHaveLength(1);
  });

  it('a soft close is not an end: the confirmed end of a resumed episode goes through', () => {
    ingest.handle(signal('agent.user_prompt_submit'));
    vi.advanceTimersByTime(500);
    // Delivered, but applied as a soft close; the episode resumes under its id.
    ingest.handle({ ...failure(), payload: { error: 'x', provisional: true } });
    vi.advanceTimersByTime(DEFAULT_ALARM_WINDOW_MS);
    const id = bridge.turnAt(Date.now())?.turnId;
    ingest.handle(signal('agent.tool_started'));
    vi.advanceTimersByTime(500);
    expect(bridge.turnAt(Date.now())?.turnId).toBe(id);
    ingest.handle(failure());
    vi.advanceTimersByTime(DEFAULT_ALARM_WINDOW_MS);
    expect(ends()).toHaveLength(2);
  });

  it('reads no hook timestamp: a hook clock behind the daemon cannot drop the next turn\'s end', () => {
    ingest.handle(signal('agent.user_prompt_submit', Date.now() - 2_000));
    vi.advanceTimersByTime(500);
    ingest.handle(failure(Date.now() - 2_000));
    vi.advanceTimersByTime(DEFAULT_ALARM_WINDOW_MS);
    // The next turn opens from typed input, on the daemon's clock.
    bridge.noteInput('again\r');
    vi.advanceTimersByTime(500);
    ingest.handle(failure(Date.now() - 2_000));
    vi.advanceTimersByTime(DEFAULT_ALARM_WINDOW_MS);
    expect(ends()).toHaveLength(2);
  });

  it('a turn that opened no episode still ends: its end says something else', () => {
    ingest.handle(signal('agent.user_prompt_submit'));
    vi.advanceTimersByTime(500);
    ingest.handle(signal('agent.stop', Date.now(), { last_assistant_message: 'done A' }));
    vi.advanceTimersByTime(DEFAULT_ALARM_WINDOW_MS);
    // An autonomous turn with no hook before its own end.
    vi.advanceTimersByTime(2_000);
    ingest.handle(signal('agent.stop_failure', Date.now(), { error: 'rate_limit', last_assistant_message: 'limit' }));
    vi.advanceTimersByTime(DEFAULT_ALARM_WINDOW_MS);
    expect(ends()).toHaveLength(2);
  });

  it('a new prompt whose opening hook is late still ends, even with the same error', () => {
    const p1 = { error: 'rate_limit', last_assistant_message: 'limit', prompt_id: 'p-1' };
    ingest.handle(signal('agent.user_prompt_submit', Date.now(), { prompt_id: 'p-1' }));
    vi.advanceTimersByTime(500);
    ingest.handle(signal('agent.stop_failure', Date.now(), p1));
    vi.advanceTimersByTime(DEFAULT_ALARM_WINDOW_MS);
    // The next prompt fails at once; its own end arrives before its prompt hook.
    ingest.handle(signal('agent.stop_failure', Date.now(), { ...p1, prompt_id: 'p-2' }));
    vi.advanceTimersByTime(DEFAULT_ALARM_WINDOW_MS);
    expect(ends()).toHaveLength(2);
  });

  it('lets the next turn end through: the key is the turn, not a time window', () => {
    ingest.handle(signal('agent.user_prompt_submit'));
    vi.advanceTimersByTime(500);
    ingest.handle(failure());
    vi.advanceTimersByTime(DEFAULT_ALARM_WINDOW_MS);
    // A new prompt opens a new episode right away; its own failure is an end.
    ingest.handle(signal('agent.user_prompt_submit'));
    vi.advanceTimersByTime(300);
    ingest.handle(failure());
    vi.advanceTimersByTime(DEFAULT_ALARM_WINDOW_MS);
    expect(ends()).toHaveLength(2);
  });
});
