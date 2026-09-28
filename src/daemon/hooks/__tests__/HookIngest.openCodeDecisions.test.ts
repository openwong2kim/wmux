// OpenCode's permission/question signal: when a native record stands for the
// signalled request the hook only marks the pane blocked; otherwise (an older
// plugin, no answer, or a request the plugin did not record) the
// informational card of before stays, so a blocked pane always has a card.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { DEFAULT_ALARM_WINDOW_MS } from '../../../shared/hooks/CompletionAlarm';
import { HookIngest, type HookAgentEventData, type HookIngestDeps } from '../HookIngest';
import type { AgentSignal } from '../../../shared/hooks/signal-types';

type Outcome = 'native' | 'missing' | 'unsupported' | 'unavailable';
function makeIngest(outcome: Outcome | 'throw' | 'absent', hold?: Promise<void>) {
  const cards: Array<{ sessionId: string; requestId?: string }> = [];
  const reconciled: Array<[string, string | undefined]> = [];
  const expired: Array<[string, string, string | undefined]> = [];
  const expiredHook: Array<[string, readonly string[]]> = [];
  const emitted: HookAgentEventData[] = [];
  const deps: HookIngestDeps = {
    listLiveSessions: () => [{ id: 'pty-oc', cwd: '/repo', env: { WMUX_WORKSPACE_ID: 'ws-1' } }],
    emitAgentEvent: (_id, data) => { emitted.push(data); },
    applyResumeBinding: () => undefined,
    approvals: {
      noteHookAwaitingInput: (input) => { cards.push({ sessionId: input.sessionId, ...(input.requestId ? { requestId: input.requestId } : {}) }); },
      noteGateAwaiting: () => 'gate-id',
      expireForSession: (id, reason, kind) => { expired.push([id, reason, kind]); },
      expireHookAwaiting: (id, ids) => { expiredHook.push([id, ids]); },
    },
    log: () => undefined,
    now: () => 10_000,
    ...(outcome === 'absent' ? {} : {
      openCodeDecisions: async (id: string, requestId?: string) => {
        reconciled.push([id, requestId]);
        if (hold) await hold;
        if (outcome === 'throw') throw new Error('boom');
        return outcome;
      },
    }),
  };
  return { ingest: new HookIngest(deps), cards, reconciled, expired, expiredHook, emitted };
}
const signal = (kind: AgentSignal['kind'], agent: AgentSignal['agent'] = 'opencode', permId: string | null = 'per_1'): AgentSignal =>
  ({ kind, agent, cwd: '/repo', payload: permId ? { permId } : {}, ts: 1_000, ptyId: 'pty-oc' });
const flush = () => vi.advanceTimersByTimeAsync(0);
// The blocked cue leaves once the completion alarm's window confirms it.
const blocked = async (f: { emitted: HookAgentEventData[] }) => {
  await vi.advanceTimersByTimeAsync(DEFAULT_ALARM_WINDOW_MS + 50);
  return f.emitted.some((e) => e.status === 'awaiting_input');
};

describe('HookIngest — OpenCode native decisions', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });
  it('a native record for the signalled request: no informational card, the pane still reads blocked', async () => {
    const f = makeIngest('native');
    f.ingest.handle(signal('agent.awaiting_input'));
    await flush();
    expect(f.reconciled).toEqual([['pty-oc', 'per_1']]);
    expect(f.cards).toEqual([]);
    expect(await blocked(f)).toBe(true);
  });

  it.each(['missing', 'unsupported', 'unavailable', 'throw', 'absent'] as const)('%s keeps the card, keyed by the request', async (outcome) => {
    const f = makeIngest(outcome);
    f.ingest.handle(signal('agent.awaiting_input'));
    await flush();
    expect(f.cards).toEqual([{ sessionId: 'pty-oc', requestId: 'per_1' }]);
    expect(await blocked(f)).toBe(true);
  });

  it('a request answered at the terminal before the fallback is decided gets no card', async () => {
    let release!: () => void;
    const f = makeIngest('missing', new Promise<void>((r) => { release = r; }));
    f.ingest.handle(signal('agent.awaiting_input'));
    f.ingest.handle(signal('agent.input_answered'));
    release();
    await flush(); await flush();
    expect(f.cards).toEqual([]);
  });

  it('another agent never asks the OpenCode plugin', async () => {
    const f = makeIngest('native');
    f.ingest.handle(signal('agent.awaiting_input', 'codex'));
    await flush();
    expect(f.reconciled).toEqual([]);
    expect(f.cards).toEqual([{ sessionId: 'pty-oc' }]);
  });

  it("an answered request expires only its own card, then the plugin is re-read", async () => {
    const f = makeIngest('native');
    f.ingest.handle(signal('agent.input_answered'));
    await flush();
    expect(f.expiredHook).toEqual([['pty-oc', ['per_1']]]);
    expect(f.expired).toEqual([]);
    expect(f.reconciled).toEqual([['pty-oc', undefined]]);
  });

  it('an answered signal with no request id (an older bridge) keeps the pane-wide expiry', async () => {
    const f = makeIngest('native');
    f.ingest.handle(signal('agent.input_answered', 'opencode', null));
    await flush();
    expect(f.expired).toEqual([['pty-oc', 'answered-locally', 'awaiting_input']]);
    expect(f.expiredHook).toEqual([]);
  });
});
