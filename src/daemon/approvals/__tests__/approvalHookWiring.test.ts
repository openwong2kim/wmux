// M2 — the HookIngest → ApprovalRegistry wiring.
//
// The registry's own rules are covered in ApprovalRegistry.test.ts; what is
// under test HERE is the gate in front of it. Approval requests are the one
// surface in wmux that writes bytes into a terminal on somebody else's say-so,
// so "which signals may mint one" is the load-bearing question, and the answer
// has to be enforced structurally rather than described in a prompt.

import { describe, it, expect, vi } from 'vitest';
import { HookIngest, type HookIngestSession } from '../../hooks/HookIngest';
import type { AgentSignal } from '../../../shared/hooks/signal-types';
import { DEFAULT_ALARM_WINDOW_MS } from '../../../shared/hooks/CompletionAlarm';
import type { ApprovalExpiryReason, ApprovalHookSink } from '../types';

type Created = {
  sessionId: string;
  agent: string;
  workspaceId?: string;
  question?: string;
  options?: string[];
};
type Expired = { sessionId: string; reason: ApprovalExpiryReason };

function makeSink(): ApprovalHookSink & { created: Created[]; expired: Expired[]; gateCreated: Array<{ sessionId: string; toolName: string }> } {
  const created: Created[] = [];
  const expired: Expired[] = [];
  const gateCreated: Array<{ sessionId: string; toolName: string }> = [];
  return {
    created,
    expired,
    gateCreated,
    noteHookAwaitingInput: (input) => { created.push(input); },
    noteGateAwaiting: (input) => { gateCreated.push({ sessionId: input.sessionId, toolName: input.toolName }); return `gate-${gateCreated.length}`; },
    expireForSession: (sessionId, reason) => { expired.push({ sessionId, reason }); },
  };
}

function makeSignal(overrides: Partial<AgentSignal> = {}): AgentSignal {
  return {
    kind: 'agent.awaiting_input',
    agent: 'claude',
    cwd: '/repo',
    payload: {},
    ts: 1_000,
    ...overrides,
  };
}

function makeIngest(sessions: HookIngestSession[] = [
  { id: 'pty-a', cwd: '/repo', env: { WMUX_WORKSPACE_ID: 'ws-real' } },
]) {
  const approvals = makeSink();
  const ingest = new HookIngest({
    listLiveSessions: () => sessions,
    emitAgentEvent: () => undefined,
    applyResumeBinding: () => undefined,
    approvals,
    now: () => 10_000,
  });
  return { ingest, approvals };
}

describe('hook → approval registry wiring', () => {
  it('a hook awaiting_input that EMITS creates a request', () => {
    const { ingest, approvals } = makeIngest();

    expect(ingest.handle(makeSignal())).toEqual({ ok: true });

    expect(approvals.created).toEqual([
      { sessionId: 'pty-a', agent: 'claude', workspaceId: 'ws-real' },
    ]);
  });

  it('A4: carries the question and option labels off the envelope payload', () => {
    const { ingest, approvals } = makeIngest();

    ingest.handle(makeSignal({
      payload: {
        tool_name: 'AskUserQuestion',
        tool_input: {
          questions: [{
            question: 'Which file should I delete?',
            options: [{ label: 'src/old.ts' }, { label: 'src/older.ts' }],
          }],
        },
      },
    }));

    expect(approvals.created[0]).toMatchObject({
      question: 'Which file should I delete?',
      options: ['src/old.ts', 'src/older.ts'],
    });
  });

  it('A4: a payload with no usable tool_input still creates the request', () => {
    const { ingest, approvals } = makeIngest();

    ingest.handle(makeSignal({ payload: { tool_name: 'AskUserQuestion' } }));

    // Absent fields, not a skipped request — a request you cannot read still
    // tells the operator a pane is blocked.
    expect(approvals.created).toHaveLength(1);
    expect(approvals.created[0].question).toBeUndefined();
    expect(approvals.created[0].options).toBeUndefined();
  });

  it('tags the request with the RESOLVED session workspace, not the envelope claim', () => {
    // The bridge payload is authenticated but not trusted, and the cwd
    // resolution tier never validates a claimed workspaceId — so a hook that
    // claims someone else's workspace must not get a request filed under it.
    const { ingest, approvals } = makeIngest([
      { id: 'pty-a', cwd: '/repo', env: { WMUX_WORKSPACE_ID: 'ws-real' } },
    ]);

    ingest.handle(makeSignal({ workspaceId: 'ws-claimed-by-hook' }));

    expect(approvals.created[0].workspaceId).toBe('ws-real');
  });

  it('creates NOTHING for a detector-sourced awaiting_input', () => {
    const { ingest, approvals } = makeIngest();

    // The detector emission point. A regex match on pane text is a suspicion,
    // not testimony — it is the one thing that must never mint a request.
    // The verdict gate HOLDS the candidate ('pending' — provisional window
    // open, no broadcast yet); even its confirmation never mints a request,
    // because only the hook path calls noteHookAwaitingInput.
    const arbitration = ingest.arbitrateDetector('pty-a', {
      agent: 'Claude Code',
      status: 'awaiting_input',
    });

    expect(arbitration).toEqual({ source: 'detector', decision: 'pending' });
    expect(approvals.created).toHaveLength(0);
    expect(approvals.expired).toHaveLength(0);
  });

  it('a hook awaiting_input creates the request even when the detector got there first', () => {
    const { ingest, approvals } = makeIngest();

    // The detector reports the prompt first (held as 'pending'), then the
    // bridge's hook envelope arrives for the SAME prompt. The card is minted
    // on hook arrival, unconditionally — the detector path never mints one,
    // so gating this on the ledger would leave the detect-then-hook race
    // with NO card at all and a blocked pane with no phone approval.
    ingest.arbitrateDetector('pty-a', { agent: 'Claude Code', status: 'awaiting_input' });
    const res = ingest.handle(makeSignal());

    expect(res).toEqual({ ok: true });
    expect(approvals.created).toHaveLength(1);
    expect(approvals.created[0]).toMatchObject({ sessionId: 'pty-a', agent: 'claude' });
  });

  it('creates nothing when the signal resolves to no live pane', () => {
    const { ingest, approvals } = makeIngest([]);

    expect(ingest.handle(makeSignal())).toEqual({ ok: false, reason: 'no-workspace-match' });
    expect(approvals.created).toHaveLength(0);
  });

  it('creates nothing for a malformed envelope', () => {
    const { ingest, approvals } = makeIngest();

    expect(ingest.handle({ nonsense: true })).toEqual({ ok: false, reason: 'invalid-envelope' });
    expect(approvals.created).toHaveLength(0);
  });

  it('agent.stop expires the pending request only once the turn end is CONFIRMED', async () => {
    // The expiry rides the stop's resume closure: a stop is a CANDIDATE until
    // the provisional window expires unrebutted, and a rebutted stop means
    // the turn is still going — the card must survive it.
    vi.useFakeTimers();
    try {
      const { ingest, approvals } = makeIngest();

      // Working evidence first — a stop with none is rejected by the turn
      // gate before it can hold a window at all.
      ingest.handle(makeSignal({ kind: 'agent.activity' }));
      ingest.handle(makeSignal({ kind: 'agent.stop' }));

      // Held: the window is open, the turn has not been confirmed ended.
      expect(approvals.expired).toHaveLength(0);

      await vi.advanceTimersByTimeAsync(DEFAULT_ALARM_WINDOW_MS);

      expect(approvals.expired).toEqual([{ sessionId: 'pty-a', reason: 'turn-ended' }]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a REBUTTED agent.stop never expires the request — the turn is still going', async () => {
    vi.useFakeTimers();
    try {
      const { ingest, approvals } = makeIngest();

      ingest.handle(makeSignal({ kind: 'agent.activity' }));
      ingest.handle(makeSignal({ kind: 'agent.stop' }));
      // Tool output resumes inside the window — the stop is discarded.
      ingest.handle(makeSignal({ kind: 'agent.tool_started' }));

      await vi.advanceTimersByTimeAsync(DEFAULT_ALARM_WINDOW_MS);

      expect(approvals.expired).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('agent.input_answered expires the pending request — user answered on the local machine', () => {
    const { ingest, approvals } = makeIngest();

    ingest.handle(makeSignal({ kind: 'agent.input_answered' }));

    expect(approvals.expired).toEqual([{ sessionId: 'pty-a', reason: 'answered-locally' }]);
  });

  it('agent.session_start expires it — a new session never asked the old question', () => {
    const { ingest, approvals } = makeIngest();

    ingest.handle(makeSignal({ kind: 'agent.session_start' }));

    expect(approvals.expired).toEqual([{ sessionId: 'pty-a', reason: 'session-start' }]);
  });

  it('agent.subagent_stop does NOT expire — a subagent finishing is not an answer', () => {
    const { ingest, approvals } = makeIngest();

    ingest.handle(makeSignal({ kind: 'agent.subagent_stop' }));

    expect(approvals.expired).toHaveLength(0);
  });

  it('agent.activity does not touch the registry at all', () => {
    const { ingest, approvals } = makeIngest();

    ingest.handle(makeSignal({ kind: 'agent.activity' }));

    expect(approvals.created).toHaveLength(0);
    expect(approvals.expired).toHaveLength(0);
  });

  it('a disposed pane expires its pending request', () => {
    const { ingest, approvals } = makeIngest();

    ingest.dropPty('pty-a');

    expect(approvals.expired).toEqual([{ sessionId: 'pty-a', reason: 'pane-gone' }]);
  });

  it('works with no registry wired at all (main-side and unit-test construction)', () => {
    const ingest = new HookIngest({
      listLiveSessions: () => [{ id: 'pty-a', cwd: '/repo' }],
      emitAgentEvent: () => undefined,
      applyResumeBinding: () => undefined,
    });

    expect(ingest.handle(makeSignal())).toEqual({ ok: true });
    expect(() => ingest.dropPty('pty-a')).not.toThrow();
  });
});
