import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ExternalSessionRegistry, externalText } from '../ExternalSessionRegistry';
import { HookIngest, type HookIngestDeps, type HookIngestSession } from '../../hooks/HookIngest';
import { EXTERNAL_SESSION_LIMITS, type ExternalSession } from '../../../shared/externalSessions';
import type { AgentSignal } from '../../../shared/hooks/signal-types';

const SID = '0a1b2c3d-0000-4000-8000-000000000001';
const SID2 = '0a1b2c3d-0000-4000-8000-000000000002';

type Extra = { entrypoint?: string; agentPid?: number };

function signal(overrides: Partial<AgentSignal> & Extra = {}): AgentSignal {
  return {
    kind: 'agent.activity',
    agent: 'claude',
    agentSessionId: SID,
    cwd: '/repo',
    payload: {},
    ts: 1,
    ...overrides,
  } as AgentSignal;
}

function setup(opts: { running?: (pid: number) => boolean } = {}) {
  let now = 1_000_000;
  const pushes: ExternalSession[][] = [];
  const registry = new ExternalSessionRegistry({
    now: () => now,
    onChanged: (sessions) => { pushes.push(sessions); },
    ...(opts.running ? { isPidRunning: opts.running } : {}),
  });
  return {
    registry,
    pushes,
    advance: (ms: number) => { now += ms; },
    one: () => registry.list()[0],
  };
}

describe('ExternalSessionRegistry', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('maps signal kinds to states', () => {
    const f = setup();
    f.registry.note(signal({ kind: 'agent.session_start', payload: { source: 'startup' } }));
    expect(f.one()).toMatchObject({ id: `claude:${SID}`, agent: 'claude', agentSessionId: SID, state: 'idle' });
    f.registry.note(signal({ kind: 'agent.session_start', payload: { source: 'compact' } }));
    expect(f.one().state).toBe('running');

    f.registry.note(signal({ kind: 'agent.user_prompt_submit', payload: { prompt: 'fix the login test' } }));
    expect(f.one()).toMatchObject({ state: 'running', title: 'fix the login test' });

    f.registry.note(signal({ kind: 'agent.stop' }));
    expect(f.one().state).toBe('idle');
    f.registry.note(signal({ kind: 'agent.activity', payload: { tool_name: 'Read', tool_input: { file_path: 'tests/auth/login.spec.ts' } } }));
    expect(f.one()).toMatchObject({ state: 'running', lastActivity: 'Read tests/auth/login.spec.ts' });
    f.registry.note(signal({ kind: 'agent.stop_failure' }));
    expect(f.one().state).toBe('idle');
  });

  it("an interrupted turn's Stop that arrives after the next prompt leaves it running", () => {
    const f = setup();
    f.registry.note(signal({ kind: 'agent.user_prompt_submit', payload: { prompt: 'first' } }));
    f.advance(1_000);
    const endedAt = 1_000_000 + 500;
    f.registry.note(signal({ kind: 'agent.user_prompt_submit', payload: { prompt: 'second' } }));
    f.registry.note(signal({ kind: 'agent.stop', payload: { wmux_turn_reason: 'aborted', wmux_turn_ended_at: endedAt } }));
    expect(f.one().state).toBe('running');
    // A stop of the current turn still lands.
    f.registry.note(signal({ kind: 'agent.stop', payload: { wmux_turn_reason: 'aborted', wmux_turn_ended_at: 1_000_000 + 2_000 } }));
    expect(f.one().state).toBe('idle');
  });

  it('the first prompt names the session; later prompts do not rename it', () => {
    const f = setup();
    f.registry.note(signal({ kind: 'agent.user_prompt_submit', payload: { prompt: 'first' } }));
    f.registry.note(signal({ kind: 'agent.user_prompt_submit', payload: { prompt: 'second' } }));
    expect(f.one().title).toBe('first');
  });

  it('AskUserQuestion is needs-you with the question until it is answered', () => {
    const f = setup();
    f.registry.note(signal({
      kind: 'agent.awaiting_input',
      payload: { hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion', tool_input: { questions: [{ question: 'Which branch?', options: [{ label: 'main' }] }] } },
    }));
    expect(f.one()).toMatchObject({ state: 'needs-you', pendingKind: 'question', pendingQuestion: 'Which branch?' });

    // A subagent's tool does not answer the lead's question.
    f.registry.note(signal({ kind: 'agent.activity', payload: { tool_name: 'Bash', agent_id: 'a1', agent_type: 'general' } }));
    expect(f.one().state).toBe('needs-you');

    f.registry.note(signal({ kind: 'agent.input_answered', payload: { tool_name: 'AskUserQuestion' } }));
    expect(f.one().state).toBe('running');
    expect(f.one()).not.toHaveProperty('pendingQuestion');
    expect(f.one()).not.toHaveProperty('pendingKind');
  });

  it('a permission dialog is needs-you only once its Notification says it is still waiting', () => {
    const f = setup();
    f.registry.note(signal({
      kind: 'agent.awaiting_input',
      payload: { hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'rm -rf build' } },
    }));
    expect(f.one().state).toBe('running');

    f.registry.note(signal({
      kind: 'agent.awaiting_input',
      payload: { hook_event_name: 'Notification', notification_type: 'permission_prompt', message: 'Claude needs your permission' },
    }));
    expect(f.one()).toMatchObject({ state: 'needs-you', pendingKind: 'approval', pendingQuestion: 'Bash rm -rf build' });

    // The next dialog means the last one was answered.
    f.registry.note(signal({ kind: 'agent.awaiting_input', payload: { hook_event_name: 'PermissionRequest', tool_name: 'Edit' } }));
    expect(f.one().state).toBe('running');
    f.registry.note(signal({ kind: 'agent.stop' }));
    expect(f.one().state).toBe('idle');
  });

  it('a late Stop after SessionEnd does not bring the row back; a resume does', () => {
    const f = setup();
    f.registry.note(signal({ kind: 'agent.user_prompt_submit', payload: { prompt: 'go' } }));
    f.registry.note(signal({ kind: 'agent.session_end', payload: {} }));
    expect(f.one().state).toBe('ended');
    f.registry.note(signal({ kind: 'agent.stop', payload: {} }));
    expect(f.one().state).toBe('ended');
    f.registry.note(signal({ kind: 'agent.session_start', payload: { source: 'resume' } }));
    expect(f.one().state).toBe('idle');
  });

  it("a subagent's permission dialog clears when that subagent stops without another tool", () => {
    const f = setup();
    const sub = { agent_id: 'a1', agent_type: 'general' };
    f.registry.note(signal({ kind: 'agent.awaiting_input', payload: { hook_event_name: 'PermissionRequest', tool_name: 'Bash', ...sub } }));
    f.registry.note(signal({ kind: 'agent.awaiting_input', payload: { hook_event_name: 'Notification', notification_type: 'permission_prompt' } }));
    // Another subagent stopping does not answer it.
    f.registry.note(signal({ kind: 'agent.subagent_stop', payload: { agent_id: 'a2', agent_type: 'general' } }));
    expect(f.one().state).toBe('needs-you');
    f.registry.note(signal({ kind: 'agent.subagent_stop', payload: { ...sub } }));
    expect(f.one().state).toBe('running');
  });

  it("a subagent's permission dialog clears once that subagent runs a tool again", () => {
    const f = setup();
    const sub = { agent_id: 'a1', agent_type: 'general' };
    f.registry.note(signal({ kind: 'agent.awaiting_input', payload: { hook_event_name: 'PermissionRequest', tool_name: 'Bash', ...sub } }));
    f.registry.note(signal({ kind: 'agent.awaiting_input', payload: { hook_event_name: 'Notification', notification_type: 'permission_prompt' } }));
    expect(f.one()).toMatchObject({ state: 'needs-you', pendingKind: 'approval' });

    // The lead and another subagent do not answer it.
    f.registry.note(signal({ kind: 'agent.activity', payload: { tool_name: 'Read', agent_id: 'a2', agent_type: 'general' } }));
    f.registry.note(signal({ kind: 'agent.activity', payload: { tool_name: 'Read' } }));
    expect(f.one().state).toBe('needs-you');
    f.registry.note(signal({ kind: 'agent.activity', payload: { tool_name: 'Bash', ...sub } }));
    expect(f.one().state).toBe('running');

    // The lead's own dialog is released by the lead's tool, not a subagent's.
    f.registry.note(signal({ kind: 'agent.awaiting_input', payload: { hook_event_name: 'PermissionRequest', tool_name: 'Edit' } }));
    f.registry.note(signal({ kind: 'agent.awaiting_input', payload: { hook_event_name: 'Notification', notification_type: 'permission_prompt' } }));
    f.registry.note(signal({ kind: 'agent.activity', payload: { tool_name: 'Bash', ...sub } }));
    expect(f.one().state).toBe('needs-you');
    f.registry.note(signal({ kind: 'agent.activity', payload: { tool_name: 'Edit' } }));
    expect(f.one().state).toBe('running');
  });

  it('strips control characters, escapes and bidi overrides, and caps every text field', () => {
    const f = setup();
    const long = 'y'.repeat(2_000);
    f.registry.note(signal({
      kind: 'agent.user_prompt_submit',
      payload: { prompt: `\u001b[31mred\u001b[0m‮ title\r\nline two ${long}` },
      where: { kind: 'tmux', session: 'w\u0007ork', window: '2' },
    }));
    f.registry.note(signal({
      kind: 'agent.awaiting_input',
      payload: { tool_name: 'AskUserQuestion', tool_input: { questions: [{ question: `q\u0000${long}` }] } },
    }));
    f.registry.note(signal({ kind: 'agent.activity', payload: { tool_name: 'Bash', agent_id: 'a', agent_type: 't', tool_input: { command: long } } }));
    const s = f.one();
    expect(s.title?.startsWith('red title line two ')).toBe(true);
    expect(s.title?.length).toBeLessThanOrEqual(EXTERNAL_SESSION_LIMITS.title);
    expect(s.pendingQuestion?.length).toBeLessThanOrEqual(EXTERNAL_SESSION_LIMITS.pendingQuestion);
    expect(s.lastActivity?.length).toBeLessThanOrEqual(EXTERNAL_SESSION_LIMITS.lastActivity);
    expect(s.where).toEqual({ kind: 'tmux', session: 'work', window: '2' });
    for (const text of [s.title, s.pendingQuestion, s.lastActivity, s.where.session]) {
      // eslint-disable-next-line no-control-regex -- asserting none survive
      expect(text).not.toMatch(/[\u0000-\u001f\u007f-\u009f‪-‮]/);
    }
    expect(externalText('  \u0007 ', 10)).toBeUndefined();
  });

  it('a later hook fills in where without blanking what an earlier one said', () => {
    const f = setup();
    f.registry.note(signal({ kind: 'agent.session_start', where: { kind: 'tmux', session: 'work', window: '1' } }));
    f.registry.note(signal({ where: { kind: 'tmux' } }));
    f.registry.note(signal({}));
    expect(f.one().where).toEqual({ kind: 'tmux', session: 'work', window: '1' });
    f.registry.note(signal({ agentSessionId: SID2 }));
    expect(f.registry.list().find((s) => s.agentSessionId === SID2)?.where).toEqual({ kind: 'unknown' });
  });

  it('drops what it cannot key or trust: no session id, a pane claim, headless, a control-char cwd', () => {
    const f = setup();
    f.registry.note(signal({ agentSessionId: undefined }));
    f.registry.note(signal({ ptyId: 'pty-gone' }));
    f.registry.note(signal({ entrypoint: 'sdk-cli' }));
    f.registry.note(signal({ cwd: '/repo\nevil' }));
    f.registry.note(signal({ agentSessionId: 'x'.repeat(200) }));
    expect(f.registry.list()).toEqual([]);
  });

  it('keeps at most maxSessions; with nothing ended, the longest silent row goes', () => {
    const f = setup();
    const max = EXTERNAL_SESSION_LIMITS.maxSessions;
    for (let i = 0; i < max; i += 1) {
      f.registry.note(signal({ agentSessionId: `s-${i}` }));
      f.advance(1);
    }
    // s-0 speaks again, so s-1 is now the longest silent.
    f.registry.note(signal({ agentSessionId: 's-0', kind: 'agent.stop' }));
    f.registry.note(signal({ agentSessionId: 'new-1' }));
    const ids = f.registry.list().map((s) => s.agentSessionId);
    expect(ids).toHaveLength(max);
    expect(ids).toEqual(expect.arrayContaining(['new-1', 's-0']));
    expect(ids).not.toContain('s-1');
  });

  it('evicts an ended row before a live one', () => {
    const f = setup({ running: (pid) => pid !== 99 });
    const max = EXTERNAL_SESSION_LIMITS.maxSessions;
    f.registry.note(signal({ agentSessionId: 'oldest-live' }));
    f.advance(1);
    f.registry.note(signal({ agentSessionId: 'dead', agentPid: 99 }));
    for (let i = 0; i < max - 2; i += 1) {
      f.advance(1);
      f.registry.note(signal({ agentSessionId: `s-${i}`, agentPid: 1000 + i }));
    }
    f.registry.sweep(); // 'dead' ends: its pid is gone
    expect(f.registry.list().find((s) => s.agentSessionId === 'dead')?.state).toBe('ended');
    f.registry.note(signal({ agentSessionId: 'incoming' }));
    const ids = f.registry.list().map((s) => s.agentSessionId);
    expect(ids).not.toContain('dead');
    expect(ids).toContain('oldest-live');
  });

  it('a silent session ends after silentTtlMs and is dropped endedTtlMs later', () => {
    const f = setup();
    f.registry.note(signal({ kind: 'agent.stop' }));
    f.advance(EXTERNAL_SESSION_LIMITS.silentTtlMs - 1);
    expect(f.one().state).toBe('idle');
    f.advance(1);
    const ended = f.one();
    expect(ended.state).toBe('ended');
    expect(ended.endedAt).toBe(ended.lastSignalAt + EXTERNAL_SESSION_LIMITS.silentTtlMs);
    f.advance(EXTERNAL_SESSION_LIMITS.endedTtlMs - 1);
    expect(f.registry.list()).toHaveLength(1);
    f.advance(1);
    expect(f.registry.list()).toEqual([]);
  });

  it('without a pid, a silent running row goes idle after ten minutes; needs-you waits', () => {
    const f = setup();
    f.registry.note(signal({ kind: 'agent.user_prompt_submit', payload: { prompt: 'p' } }));
    f.registry.note(signal({ agentSessionId: SID2, kind: 'agent.awaiting_input', payload: { hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion' } }));
    f.registry.note(signal({ agentSessionId: '0a1b2c3d-0000-4000-8000-000000000003', agentPid: 7, kind: 'agent.user_prompt_submit', payload: { prompt: 'p' } }));
    const byId = () => f.registry.list().map((s) => s.state);
    f.advance(10 * 60 * 1000 - 1);
    expect(byId()).toEqual(['running', 'needs-you', 'running']);
    f.advance(1);
    // The row with a pid is judged by its process instead.
    expect(byId()).toEqual(['idle', 'needs-you', 'running']);
  });

  it('SessionEnd ends the row, needs-you included; an unknown session makes no row', () => {
    const f = setup();
    f.registry.note(signal({ kind: 'agent.session_end', agentSessionId: SID2 }));
    expect(f.registry.list()).toEqual([]);
    f.registry.note(signal({ kind: 'agent.awaiting_input', payload: { hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion' } }));
    f.registry.note(signal({ kind: 'agent.session_end', payload: { reason: 'prompt_input_exit' } }));
    expect(f.one()).toMatchObject({ state: 'ended', endedAt: 1_000_000 });
    expect(f.one()).not.toHaveProperty('pendingKind');
  });

  it('ends a session whose agent process died, and an older conversation of the same process', () => {
    const alive = new Set([4242]);
    const f = setup({ running: (pid) => alive.has(pid) });
    f.registry.note(signal({ agentPid: 4242 }));
    // `/clear` in the same claude: a new session id from the same process.
    f.registry.note(signal({ agentSessionId: SID2, agentPid: 4242, kind: 'agent.session_start', payload: { source: 'clear' } }));
    const byId = () => Object.fromEntries(f.registry.list().map((s) => [s.agentSessionId, s.state]));
    expect(byId()).toEqual({ [SID]: 'ended', [SID2]: 'idle' });

    alive.delete(4242);
    f.registry.sweep();
    expect(byId()[SID2]).toBe('ended');
    // A signal from an ended session revives it (a resumed process reports its own pid).
    alive.add(5151);
    f.registry.note(signal({ agentSessionId: SID2, agentPid: 5151, kind: 'agent.user_prompt_submit', payload: { prompt: 'p' } }));
    expect(byId()[SID2]).toBe('running');
    expect(f.registry.list().find((s) => s.agentSessionId === SID2)).not.toHaveProperty('endedAt');
  });

  it('hide drops a row until the session signals again; forget drops it for a pane', () => {
    const f = setup();
    f.registry.note(signal({ kind: 'agent.user_prompt_submit', payload: { prompt: 'p' } }));
    expect(f.registry.hide(`claude:${SID}`)).toBe(true);
    expect(f.registry.hide(`claude:${SID}`)).toBe(false);
    expect(f.registry.list()).toEqual([]);
    f.registry.note(signal({ kind: 'agent.stop' }));
    expect(f.one().state).toBe('idle');
    f.registry.forget('claude', SID);
    expect(f.registry.list()).toEqual([]);
  });

  it('coalesces a burst into one push of the full list', () => {
    const f = setup();
    for (let i = 0; i < 10; i += 1) f.registry.note(signal({}));
    f.registry.note(signal({ agentSessionId: SID2 }));
    expect(f.pushes).toHaveLength(0);
    vi.advanceTimersByTime(250);
    expect(f.pushes).toHaveLength(1);
    expect(f.pushes[0].map((s) => s.agentSessionId).sort()).toEqual([SID, SID2].sort());
    f.registry.hide(`claude:${SID}`);
    vi.advanceTimersByTime(250);
    expect(f.pushes[1].map((s) => s.agentSessionId)).toEqual([SID2]);
    f.registry.dispose();
  });
});

describe('HookIngest → external sessions', () => {
  function ingestWith(sessions: HookIngestSession[]) {
    const registry = new ExternalSessionRegistry();
    const deps: HookIngestDeps = {
      listLiveSessions: () => sessions,
      emitAgentEvent: () => undefined,
      applyResumeBinding: () => undefined,
      onUnroutedSignal: (s) => registry.note(s),
      now: () => 10_000,
    };
    return { ingest: new HookIngest(deps), registry };
  }

  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('a signal that routes to a pane never creates an external session', () => {
    const { ingest, registry } = ingestWith([{ id: 'pty-a', cwd: '/repo', env: { WMUX_WORKSPACE_ID: 'ws-1' } }]);
    // Exact pane, and a first bind by exact cwd: both route.
    ingest.handle(signal({ kind: 'agent.stop', ptyId: 'pty-a', workspaceId: 'ws-1' }));
    ingest.handle(signal({ kind: 'agent.session_start', agentSessionId: SID2, payload: { source: 'startup' } }));
    expect(registry.list()).toEqual([]);
  });

  it('a signal from outside any pane becomes one, and its response is unchanged', () => {
    const { ingest, registry } = ingestWith([{ id: 'pty-a', cwd: '/elsewhere', env: {} }]);
    const res = ingest.handle(signal({ kind: 'agent.user_prompt_submit', cwd: '/repo', payload: { prompt: 'hi' }, where: { kind: 'ssh', label: '10.0.0.5' } }));
    expect(res).toEqual({ ok: false, reason: 'no-workspace-match' });
    expect(registry.list()).toMatchObject([{ state: 'running', title: 'hi', where: { kind: 'ssh', label: '10.0.0.5' } }]);
  });

  it('a guessed pane that refuses the signal (bound to another conversation) leaves it external', () => {
    const { ingest, registry } = ingestWith([{
      id: 'pty-a',
      cwd: '/repo',
      env: {},
      resumeBinding: { agent: 'claude', sessionId: SID2 },
    }]);
    ingest.handle(signal({ kind: 'agent.stop', cwd: '/repo' }));
    expect(registry.list()).toMatchObject([{ agentSessionId: SID, state: 'idle' }]);
  });

  it('a routed session end is answered ok and reaches no pane; an unrouted one ends the row', () => {
    const emitted: unknown[] = [];
    const registry = new ExternalSessionRegistry();
    const ingest = new HookIngest({
      listLiveSessions: () => [{ id: 'pty-a', cwd: '/repo', env: {} }],
      emitAgentEvent: (_id, e) => { emitted.push(e); },
      applyResumeBinding: () => undefined,
      onUnroutedSignal: (s) => registry.note(s),
      now: () => 10_000,
    });
    expect(ingest.handle(signal({ kind: 'agent.session_end', ptyId: 'pty-a' }))).toEqual({ ok: true });
    expect(emitted).toEqual([]);

    ingest.handle(signal({ kind: 'agent.user_prompt_submit', cwd: '/other', payload: { prompt: 'hi' } }));
    expect(ingest.handle(signal({ kind: 'agent.session_end', cwd: '/other' }))).toEqual({ ok: false, reason: 'no-workspace-match' });
    expect(registry.list()).toMatchObject([{ state: 'ended' }]);
  });

  it('an invalid envelope reaches nothing', () => {
    const { ingest, registry } = ingestWith([]);
    expect(ingest.handle({ kind: 'agent.stop', agent: 'claude', cwd: '/repo', payload: {}, ts: 1, where: { kind: 'bogus' } }))
      .toEqual({ ok: false, reason: 'invalid-envelope' });
    expect(registry.list()).toEqual([]);
  });
});
