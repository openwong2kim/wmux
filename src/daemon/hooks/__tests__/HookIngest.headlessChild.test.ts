// A headless `claude -p` started by the pane's own agent (through Bash)
// inherits WMUX_PTY_ID, so its hooks name the host pane exactly. They must not
// rebind the pane, end its turn, or touch its hook state — while the pane's own
// agent keeps rebinding on /clear, /resume and compact.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { HookIngest, type HookAgentEventData, type HookIngestDeps, type HookIngestSession } from '../HookIngest';
import { DEFAULT_ALARM_WINDOW_MS } from '../../../shared/hooks/CompletionAlarm';
import type { AgentSignal } from '../../../shared/hooks/signal-types';
import type { ResumeBinding } from '../../../shared/agentResume';

const PARENT_ID = '0a1b2c3d-0000-4000-8000-000000000001';
const CLEARED_ID = '0a1b2c3d-0000-4000-8000-000000000002';
const CHILD_ID = '0a1b2c3d-0000-4000-8000-0000000000c1';
const AGENT_PID = 4242;
const CHILD_PID = 5151;

type Extra = { entrypoint?: string; agentPid?: number };

function signal(overrides: Partial<AgentSignal> & Extra = {}): AgentSignal {
  return {
    kind: 'agent.stop',
    agent: 'claude',
    ptyId: 'pty-a',
    cwd: '/repo',
    payload: {},
    ts: 1_000,
    ...overrides,
  } as AgentSignal;
}

const parent = (o: Partial<AgentSignal> & Extra = {}) => signal({ entrypoint: 'cli', agentPid: AGENT_PID, ...o });
const child = (o: Partial<AgentSignal> & Extra = {}) =>
  signal({ entrypoint: 'sdk-cli', agentPid: CHILD_PID, agentSessionId: CHILD_ID, ...o });

function setup(trackedPid: number | null = AGENT_PID) {
  const binding: { current?: ResumeBinding } = {};
  const sessions: HookIngestSession[] = [{
    id: 'pty-a',
    cwd: '/repo',
    env: { WMUX_WORKSPACE_ID: 'ws-1' },
    get resumeBinding() { return binding.current; },
  }];
  const bindings: ResumeBinding[] = [];
  const emitted: HookAgentEventData[] = [];
  const expired: string[] = [];
  const nudges: string[] = [];
  const logs: Array<[string, string]> = [];
  const deps: HookIngestDeps = {
    listLiveSessions: () => sessions,
    emitAgentEvent: (_id, data) => { emitted.push(data); },
    applyResumeBinding: (_id, b) => { bindings.push(b); binding.current = b; },
    agentPidFor: () => trackedPid ?? undefined,
    onTranscriptNudge: (_id, kind) => { nudges.push(kind); },
    approvals: {
      noteHookAwaitingInput: () => undefined,
      noteGateAwaiting: () => 'gate-id',
      expireForSession: (_id: string, reason: string) => { expired.push(reason); },
    } as unknown as HookIngestDeps['approvals'],
    log: (level, message) => { logs.push([level, message]); },
    now: () => 10_000,
  };
  return { ingest: new HookIngest(deps), bindings, emitted, expired, nudges, logs };
}

describe('HookIngest — a nested headless child never speaks for its host pane', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('an sdk-cli Stop does not rebind the pane, raise a completion or touch hook authority', () => {
    const f = setup();
    f.ingest.handle(parent({ kind: 'agent.session_start', agentSessionId: PARENT_ID }));
    f.ingest.handle(parent({ kind: 'agent.activity', payload: { tool_name: 'Bash' } }));
    const before = { bindings: f.bindings.length, emitted: f.emitted.length, nudges: f.nudges.length };

    // Even with binding fields an older bridge would still send.
    expect(f.ingest.handle(child({ kind: 'agent.session_start' }))).toEqual({ ok: true });
    expect(f.ingest.handle(child({ payload: { transcript_path: `/x/${CHILD_ID}.jsonl` } }))).toEqual({ ok: true });
    vi.advanceTimersByTime(DEFAULT_ALARM_WINDOW_MS * 2);

    expect(f.bindings).toHaveLength(before.bindings);
    expect(f.bindings.at(-1)?.sessionId).toBe(PARENT_ID);
    expect(f.emitted).toHaveLength(before.emitted);
    expect(f.emitted.some((e) => e.status === 'complete')).toBe(false);
    expect(f.nudges).toHaveLength(before.nudges);
    // The child's SessionStart did not expire the parent's pending approvals.
    expect(f.expired.filter((r) => r === 'session-start')).toHaveLength(1);
    expect(f.logs.some(([level, m]) => level === 'info' && m.includes('entrypoint sdk-cli'))).toBe(true);
  });

  it('a child Stop does not end the parent turn; the parent Stop still does', () => {
    const f = setup();
    f.ingest.handle(parent({ kind: 'agent.activity', payload: { tool_name: 'Bash' } }));
    f.ingest.handle(child());
    vi.advanceTimersByTime(DEFAULT_ALARM_WINDOW_MS * 2);
    expect(f.emitted.some((e) => e.status === 'complete')).toBe(false);

    f.ingest.handle(parent({ agentSessionId: PARENT_ID }));
    vi.advanceTimersByTime(DEFAULT_ALARM_WINDOW_MS);
    expect(f.emitted.at(-1)).toMatchObject({ status: 'complete', decision: 'emit' });
  });

  it('the pane\'s own agent still rebinds on /clear, and the rebind is logged old -> new', () => {
    const f = setup();
    f.ingest.handle(parent({ kind: 'agent.session_start', agentSessionId: PARENT_ID }));
    f.ingest.handle(child());
    // /clear: a fresh SessionStart from the same top-level process.
    f.ingest.handle(parent({ kind: 'agent.session_start', agentSessionId: CLEARED_ID }));
    expect(f.bindings.map((b) => b.sessionId)).toEqual([PARENT_ID, CLEARED_ID]);
    expect(f.logs).toContainEqual(['debug', `[hooks] rebound pty-a (agent.session_start): ${PARENT_ID} -> ${CLEARED_ID}`]);
  });

  it('an interactive entrypoint binds even when the tracker holds another pid', () => {
    // The tracker can still hold a just-exited agent's pid when a relaunched
    // one reports; the entrypoint, not the pid, decides an interactive hook.
    const f = setup(9999);
    f.ingest.handle(parent({ kind: 'agent.session_start', agentSessionId: PARENT_ID }));
    expect(f.bindings.map((b) => b.sessionId)).toEqual([PARENT_ID]);
  });

  it('without an entrypoint, the hook\'s process decides when both pids are known', () => {
    const foreign = setup();
    foreign.ingest.handle(signal({ kind: 'agent.session_start', agentSessionId: CHILD_ID, agentPid: CHILD_PID }));
    expect(foreign.bindings).toHaveLength(0);

    const own = setup();
    own.ingest.handle(signal({ kind: 'agent.session_start', agentSessionId: PARENT_ID, agentPid: AGENT_PID }));
    expect(own.bindings.map((b) => b.sessionId)).toEqual([PARENT_ID]);

    // An older bridge (no entrypoint, no pid), or no tracked pid: today's behaviour.
    const old = setup();
    old.ingest.handle(signal({ kind: 'agent.session_start', agentSessionId: PARENT_ID }));
    expect(old.bindings).toHaveLength(1);
    const untracked = setup(null);
    untracked.ingest.handle(signal({ kind: 'agent.session_start', agentSessionId: PARENT_ID, agentPid: CHILD_PID }));
    expect(untracked.bindings).toHaveLength(1);
  });

  it('an unknown entrypoint keeps its alarms but never rebinds the pane', () => {
    const f = setup();
    f.ingest.handle(parent({ kind: 'agent.session_start', agentSessionId: PARENT_ID }));
    f.ingest.handle(signal({ entrypoint: 'future-ide', kind: 'agent.activity', payload: { tool_name: 'Bash' } }));
    f.ingest.handle(signal({ entrypoint: 'future-ide', agentSessionId: CHILD_ID }));
    vi.advanceTimersByTime(DEFAULT_ALARM_WINDOW_MS);
    expect(f.bindings.map((b) => b.sessionId)).toEqual([PARENT_ID]);
    expect(f.emitted.at(-1)).toMatchObject({ status: 'complete', decision: 'emit' });
    expect(f.logs.some(([, m]) => m.includes('entrypoint future-ide is not a known interactive surface'))).toBe(true);
  });

  it('a WSL hook is never pid-compared, so its own /clear still rebinds', () => {
    // Under WSL the hook's parent is the hook.sh shell, not the agent.
    const f = setup();
    f.ingest.handle(signal({ kind: 'agent.session_start', agentSessionId: PARENT_ID, agentPid: CHILD_PID, wslAgentProcess: 'boot\x1e1\x1e2\x1eclaude' }));
    f.ingest.handle(signal({ kind: 'agent.session_start', agentSessionId: CLEARED_ID, agentPid: CHILD_PID, wslAgentProcess: 'boot\x1e1\x1e2\x1eclaude' }));
    expect(f.bindings.map((b) => b.sessionId)).toEqual([PARENT_ID, CLEARED_ID]);
  });

  it('a child permission gate raises no card', () => {
    const f = setup();
    expect(f.ingest.handlePermissionGate(child({ kind: 'agent.awaiting_permission', payload: { tool_name: 'Bash' } })))
      .toEqual({ ok: false, reason: 'foreign-process' });
    expect(f.emitted).toHaveLength(0);
  });
});
