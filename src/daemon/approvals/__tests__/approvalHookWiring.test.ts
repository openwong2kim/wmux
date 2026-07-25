// M2 — the HookIngest → ApprovalRegistry wiring.
//
// The registry's own rules are covered in ApprovalRegistry.test.ts; what is
// under test HERE is the gate in front of it. Approval requests are the one
// surface in wmux that writes bytes into a terminal on somebody else's say-so,
// so "which signals may mint one" is the load-bearing question, and the answer
// has to be enforced structurally rather than described in a prompt.

import { describe, it, expect } from 'vitest';
import { HookIngest, type HookIngestSession } from '../../hooks/HookIngest';
import type { AgentSignal } from '../../../shared/hooks/signal-types';
import type { ApprovalExpiryReason, ApprovalHookSink } from '../types';

type Created = {
  sessionId: string;
  agent: string;
  workspaceId?: string;
  question?: string;
  options?: string[];
};
type Expired = { sessionId: string; reason: ApprovalExpiryReason };

function makeSink(): ApprovalHookSink & { created: Created[]; expired: Expired[] } {
  const created: Created[] = [];
  const expired: Expired[] = [];
  return {
    created,
    expired,
    noteHookAwaitingInput: (input) => { created.push(input); },
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
    const arbitration = ingest.arbitrateDetector('pty-a', {
      agent: 'Claude Code',
      status: 'awaiting_input',
    });

    expect(arbitration).toEqual({ source: 'detector', decision: 'emit' });
    expect(approvals.created).toHaveLength(0);
    expect(approvals.expired).toHaveLength(0);
  });

  it('creates NOTHING for a dedup\'d hook awaiting_input', () => {
    const { ingest, approvals } = makeIngest();

    // The detector got there first, so the hook is the canonical-but-redundant
    // report of the SAME prompt. Creating here would mint a duplicate request
    // and — via the supersede rule — kill the one a phone may already be
    // holding.
    ingest.arbitrateDetector('pty-a', { agent: 'Claude Code', status: 'awaiting_input' });
    const res = ingest.handle(makeSignal());

    expect(res).toEqual({ ok: true });
    expect(approvals.created).toHaveLength(0);
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

  it('agent.stop expires the pending request — the turn it blocked on is over', () => {
    const { ingest, approvals } = makeIngest();

    ingest.handle(makeSignal({ kind: 'agent.stop' }));

    expect(approvals.expired).toEqual([{ sessionId: 'pty-a', reason: 'turn-ended' }]);
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
