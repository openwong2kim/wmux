import { describe, it, expect, beforeEach } from 'vitest';
import {
  HookIngest,
  resolveSessionIdForSignal,
  type HookAgentEventData,
  type HookIngestSession,
} from '../HookIngest';
import type { AgentSignal, AgentSignalKind } from '../../../shared/hooks/signal-types';
import type { ResumeBinding } from '../../../shared/agentResume';
import os from 'node:os';
import path from 'node:path';

// A transcript path the guard accepts: inside the real Claude projects root and
// named after the agent session id. Built from `os.homedir()` so the test is
// portable (the guard resolves the root the same way).
function projectsPath(agentSessionId: string): string {
  return path.join(os.homedir(), '.claude', 'projects', '-repo', `${agentSessionId}.jsonl`);
}

function makeSignal(overrides: Partial<AgentSignal> = {}): AgentSignal {
  return {
    kind: 'agent.stop',
    agent: 'claude',
    cwd: '/repo',
    payload: {},
    ts: 1_000,
    ...overrides,
  };
}

function session(overrides: Partial<HookIngestSession> & { id: string }): HookIngestSession {
  return {
    cwd: '/repo',
    env: { WMUX_WORKSPACE_ID: 'ws-1' },
    lastActivity: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

// A minimal fake of exactly what HookIngest touches: the live session list, the
// broadcast sink, and the resume-binding writer. No real daemon/pty/pipe.
function makeDeps(sessions: HookIngestSession[] = [session({ id: 'pty-a' })]) {
  const emitted: Array<{ sessionId: string; data: HookAgentEventData }> = [];
  const bindings: Array<{ ptyId: string; binding: ResumeBinding }> = [];
  const nudges: Array<{ sessionId: string; kind: AgentSignalKind }> = [];
  let clock = 10_000;
  const deps = {
    listLiveSessions: () => sessions,
    emitAgentEvent: (sessionId: string, data: HookAgentEventData) => {
      emitted.push({ sessionId, data });
    },
    applyResumeBinding: (ptyId: string, binding: ResumeBinding) => {
      bindings.push({ ptyId, binding });
    },
    onTranscriptNudge: (sessionId: string, kind: AgentSignalKind) => {
      nudges.push({ sessionId, kind });
    },
    log: () => { /* silent in tests */ },
    now: () => clock,
  };
  return {
    deps,
    emitted,
    bindings,
    nudges,
    advance: (ms: number) => { clock += ms; },
  };
}

describe('HookIngest', () => {
  let ingest: HookIngest;
  let fixture: ReturnType<typeof makeDeps>;

  beforeEach(() => {
    fixture = makeDeps();
    ingest = new HookIngest(fixture.deps);
  });

  describe('envelope validation', () => {
    it('rejects anything that is not a canonical AgentSignal', () => {
      expect(ingest.handle(null).reason).toBe('invalid-envelope');
      expect(ingest.handle({ kind: 'nope', agent: 'claude', cwd: '/repo', payload: {}, ts: 1 }).reason)
        .toBe('invalid-envelope');
      // Unknown agent slug — an older/rogue bridge.
      expect(ingest.handle(makeSignal({ agent: 'ghost' as AgentSignal['agent'] })).reason)
        .toBe('invalid-envelope');
      expect(fixture.emitted).toHaveLength(0);
    });

    it('records signal health BEFORE resolution, so an unroutable hook still counts', () => {
      const unroutable = ingest.handle(makeSignal({ cwd: '/elsewhere', workspaceId: undefined }));
      expect(unroutable).toEqual({ ok: false, reason: 'no-workspace-match' });
      const stats = ingest.getLatencyMeter().getStats();
      expect(stats.total).toBe(1);
      expect(stats.workspaceMatchRate).toEqual({ matched: 0, missed: 1 });
    });
  });

  describe('emission', () => {
    it('broadcasts an agent.event carrying source/hookKind/decision and the display name', () => {
      const res = ingest.handle(makeSignal({ ptyId: 'pty-a', workspaceId: 'ws-1' }));
      expect(res).toEqual({ ok: true });
      expect(fixture.emitted).toHaveLength(1);
      const { sessionId, data } = fixture.emitted[0];
      expect(sessionId).toBe('pty-a');
      // Display name, not the slug: main reads this field straight into the
      // sidebar label and back through agentDisplayToSlug.
      expect(data.agent).toBe('Claude Code');
      expect(data.status).toBe('complete');
      expect(data.message).toBe('Task finished');
      expect(data.source).toBe('hook');
      expect(data.hookKind).toBe('agent.stop');
      expect(data.decision).toBe('emit');
      expect(data.signal.kind).toBe('agent.stop');
    });

    it('maps subagent_stop and awaiting_input to their own shapes', () => {
      ingest.handle(makeSignal({ ptyId: 'pty-a', kind: 'agent.subagent_stop' }));
      ingest.handle(makeSignal({ ptyId: 'pty-a', kind: 'agent.awaiting_input' }));
      expect(fixture.emitted.map((e) => [e.data.status, e.data.message])).toEqual([
        ['complete', 'Subagent finished'],
        ['awaiting_input', 'Awaiting input'],
      ]);
    });

    it('reports a broadcast failure as internal-error rather than throwing at the bridge', () => {
      const boom = makeDeps();
      boom.deps.emitAgentEvent = () => { throw new Error('pipe closed'); };
      const failing = new HookIngest(boom.deps);
      expect(failing.handle(makeSignal({ ptyId: 'pty-a' }))).toEqual({ ok: false, reason: 'internal-error' });
    });
  });

  describe('session_start broadcast (A3 — clearing stale labels on pane reuse)', () => {
    it('broadcasts as the metadata class, distinguished only by hookKind', () => {
      const res = ingest.handle(makeSignal({
        ptyId: 'pty-a',
        kind: 'agent.session_start',
        agentSessionId: 'origin-1',
        payload: { session_id: 'raw-uuid' },
      }));
      expect(res).toEqual({ ok: true });
      expect(fixture.emitted).toHaveLength(1);
      const { sessionId, data } = fixture.emitted[0];
      expect(sessionId).toBe('pty-a');
      expect(data.agent).toBe('Claude Code');
      expect(data.status).toBe('running');
      expect(data.message).toBe('');
      expect(data.source).toBe('hook');
      // The ONLY thing separating this from an activity ping — main branches
      // on it to decide "clear the labels" vs "set the running label".
      expect(data.hookKind).toBe('agent.session_start');
      expect(data.decision).toBe('activity');
      expect(data.signal.payload).toEqual({ session_id: 'raw-uuid' });
    });

    it('keeps session_start out of the dedup ledger', () => {
      ingest.handle(makeSignal({ ptyId: 'pty-a', kind: 'agent.session_start' }));
      // A ledger entry here would make the session's FIRST real turn-end land
      // as 'dedup' — a silent completion on every fresh session.
      expect(ingest.router.recordDetector('claude', 'agent.stop', 'pty-a', 10_000)).toBe('emit');
    });

    it('leaves the following turn-end a first-class emit', () => {
      ingest.handle(makeSignal({ ptyId: 'pty-a', kind: 'agent.session_start' }));
      fixture.advance(100);
      ingest.handle(makeSignal({ ptyId: 'pty-a', kind: 'agent.stop' }));
      expect(fixture.emitted.map((e) => [e.data.hookKind, e.data.decision])).toEqual([
        ['agent.session_start', 'activity'],
        ['agent.stop', 'emit'],
      ]);
    });

    it('still captures the resume binding locally (unchanged by the broadcast)', () => {
      ingest.handle(makeSignal({
        ptyId: 'pty-a',
        kind: 'agent.session_start',
        agentSessionId: 'origin-1',
      }));
      expect(fixture.bindings).toHaveLength(1);
      expect(fixture.bindings[0].binding.sessionId).toBe('origin-1');
    });
  });

  describe('activity broadcast (A2 — main’s Fleet activity line)', () => {
    const toolPayload = { tool_name: 'Bash', tool_input: { command: 'npm test' } };

    it('broadcasts PostToolUse as a running/activity event carrying the raw payload', () => {
      const res = ingest.handle(makeSignal({
        ptyId: 'pty-a',
        kind: 'agent.activity',
        payload: toolPayload,
      }));
      expect(res).toEqual({ ok: true });
      expect(fixture.emitted).toHaveLength(1);
      const { sessionId, data } = fixture.emitted[0];
      expect(sessionId).toBe('pty-a');
      expect(data.agent).toBe('Claude Code');
      expect(data.status).toBe('running');
      expect(data.message).toBe('');
      expect(data.source).toBe('hook');
      expect(data.hookKind).toBe('agent.activity');
      expect(data.decision).toBe('activity');
      // The daemon stays dumb: main summarizes the tool name from the envelope.
      expect(data.signal.payload).toEqual(toolPayload);
    });

    it('keeps activity out of the dedup ledger entirely', () => {
      ingest.handle(makeSignal({ ptyId: 'pty-a', kind: 'agent.activity', payload: toolPayload }));
      // An activity ledger entry would have poisoned the real turn boundary.
      expect(ingest.router.recordDetector('claude', 'agent.stop', 'pty-a', 10_000)).toBe('emit');
      // ...and the hook's own Stop must still be a first-class 'emit'.
      const other = makeDeps();
      const i2 = new HookIngest(other.deps);
      i2.handle(makeSignal({ ptyId: 'pty-a', kind: 'agent.activity', payload: toolPayload }));
      i2.handle(makeSignal({ ptyId: 'pty-a', kind: 'agent.stop' }));
      expect(other.emitted.map((e) => e.data.decision)).toEqual(['activity', 'emit']);
    });

    it('does not throttle — the bridge already rate-limits at the source', () => {
      for (let n = 0; n < 5; n++) {
        ingest.handle(makeSignal({ ptyId: 'pty-a', kind: 'agent.activity', payload: toolPayload }));
      }
      expect(fixture.emitted).toHaveLength(5);
    });

    it('still marks the pane hook-governed', () => {
      ingest.handle(makeSignal({ ptyId: 'pty-a', kind: 'agent.activity', payload: toolPayload }));
      expect(ingest.router.isGovernedFor('pty-a', 'claude', 10_000)).toBe(true);
    });

    it('drops an activity signal that resolves to no live pane', () => {
      expect(ingest.handle(makeSignal({ cwd: '/elsewhere', kind: 'agent.activity' })))
        .toEqual({ ok: false, reason: 'no-workspace-match' });
      expect(fixture.emitted).toHaveLength(0);
    });
  });

  describe('daemon.hooks.health payload (A2)', () => {
    it('reports cumulative latency stats and a null flood window when idle', () => {
      const health = ingest.health();
      expect(health.latency.total).toBe(0);
      expect(health.latency.workspaceMatchRate).toEqual({ matched: 0, missed: 0 });
      // Nothing recorded yet → no partial window to report.
      expect(health.flood).toBeNull();
    });

    it('moves both counters as signals land', () => {
      ingest.handle(makeSignal({ ptyId: 'pty-a' }));
      ingest.handle(makeSignal({ ptyId: 'pty-a', kind: 'agent.activity' }));
      ingest.handle(makeSignal({ cwd: '/elsewhere' })); // unroutable
      const health = ingest.health();
      expect(health.latency.total).toBe(3);
      expect(health.latency.workspaceMatchRate).toEqual({ matched: 2, missed: 1 });
      expect(health.latency.perAgent.claude).toBe(3);
      expect(health.flood).toMatchObject({ total: 3, degraded: 0, fastPathed: 3 });
    });

    it('is non-destructive, so polling never blanks the daemon’s own log line', () => {
      ingest.handle(makeSignal({ ptyId: 'pty-a' }));
      expect(ingest.health().flood?.total).toBe(1);
      // A second read sees the same window — health() must not flush it.
      expect(ingest.health().flood?.total).toBe(1);
    });
  });

  describe('the Iron Rule, arbitrated locally', () => {
    it('suppresses a detector emission that follows a hook within the window', () => {
      ingest.handle(makeSignal({ ptyId: 'pty-a' }));
      expect(fixture.emitted[0].data.decision).toBe('emit');
      fixture.advance(200);
      expect(ingest.router.recordDetector('claude', 'agent.stop', 'pty-a', 10_200)).toBe('dedup');
    });

    it('still broadcasts a hook that arrives after the detector, marked decision:"dedup"', () => {
      expect(ingest.router.recordDetector('claude', 'agent.stop', 'pty-a', 10_000)).toBe('emit');
      fixture.advance(50);
      expect(ingest.handle(makeSignal({ ptyId: 'pty-a' }))).toEqual({ ok: true });
      // The event still goes out — a dedup'd hook is forensically interesting
      // and main gates its own fan-out on `decision`.
      expect(fixture.emitted).toHaveLength(1);
      expect(fixture.emitted[0].data.decision).toBe('dedup');
    });

    it('lets a different kind through — a Stop after an awaiting_input is a distinct event', () => {
      ingest.handle(makeSignal({ ptyId: 'pty-a', kind: 'agent.awaiting_input' }));
      fixture.advance(100);
      ingest.handle(makeSignal({ ptyId: 'pty-a', kind: 'agent.stop' }));
      expect(fixture.emitted.map((e) => e.data.decision)).toEqual(['emit', 'emit']);
    });
  });

  describe('hook authority', () => {
    it('is touched by EVERY resolved kind, including the non-emit ones', () => {
      expect(ingest.router.isGovernedFor('pty-a', 'claude', 10_000)).toBe(false);
      ingest.handle(makeSignal({ ptyId: 'pty-a', kind: 'agent.session_start' }));
      expect(ingest.router.isGovernedFor('pty-a', 'claude', 10_000)).toBe(true);
      // A different agent on the same pane is a genuinely distinct source.
      expect(ingest.router.isGovernedFor('pty-a', 'codex', 10_000)).toBe(false);
    });

    it('is dropped with the pane, so a reused id falls back to the detector', () => {
      ingest.handle(makeSignal({ ptyId: 'pty-a', kind: 'agent.session_start' }));
      ingest.dropPty('pty-a');
      expect(ingest.router.isGovernedFor('pty-a', 'claude', 10_000)).toBe(false);
    });
  });

  describe('resume binding', () => {
    it('captures on session-lifecycle kinds, with permission mode and transcript path', () => {
      ingest.handle(makeSignal({
        ptyId: 'pty-a',
        kind: 'agent.session_start',
        agentSessionId: 'origin-1',
        payload: { permissionMode: 'bypassPermissions', transcript_path: projectsPath('origin-1') },
      }));
      expect(fixture.bindings).toEqual([{
        ptyId: 'pty-a',
        binding: {
          agent: 'claude',
          sessionId: 'origin-1',
          cwd: '/repo',
          permissionMode: 'bypassPermissions',
          transcriptPath: projectsPath('origin-1'),
          ts: 1_000,
        },
      }]);
    });

    // The envelope is authenticated but not trusted: an unvalidated
    // transcript_path is a daemon-side arbitrary-file-read whose contents are
    // rendered as the pane's conversation. Refusal must cost the path only —
    // never the binding and never the signal.
    it('refuses a transcript_path outside the Claude projects root', () => {
      const res = ingest.handle(makeSignal({
        ptyId: 'pty-a',
        kind: 'agent.stop',
        agentSessionId: 'origin-1',
        payload: { transcript_path: '/etc/origin-1.jsonl' },
      }));
      expect(res).toEqual({ ok: true });
      expect(fixture.bindings).toHaveLength(1);
      expect(fixture.bindings[0].binding.transcriptPath).toBeUndefined();
      expect(fixture.bindings[0].binding.sessionId).toBe('origin-1');
    });

    it('refuses a transcript_path whose basename is not the agent session id', () => {
      ingest.handle(makeSignal({
        ptyId: 'pty-a',
        kind: 'agent.stop',
        agentSessionId: 'origin-1',
        payload: { transcript_path: projectsPath('someone-else') },
      }));
      expect(fixture.bindings[0].binding.transcriptPath).toBeUndefined();
    });

    it('refuses a traversal that climbs out of the projects root', () => {
      ingest.handle(makeSignal({
        ptyId: 'pty-a',
        kind: 'agent.stop',
        agentSessionId: 'origin-1',
        payload: {
          transcript_path: path.join(
            os.homedir(), '.claude', 'projects', '..', '..', 'origin-1.jsonl',
          ),
        },
      }));
      expect(fixture.bindings[0].binding.transcriptPath).toBeUndefined();
    });

    it('accepts a projects root relocated by CLAUDE_CONFIG_DIR in the pane env', () => {
      const f = makeDeps([session({
        id: 'pty-a',
        env: { WMUX_WORKSPACE_ID: 'ws-1', CLAUDE_CONFIG_DIR: '/opt/claude-cfg' },
      })]);
      const i = new HookIngest(f.deps);
      i.handle(makeSignal({
        ptyId: 'pty-a',
        kind: 'agent.stop',
        agentSessionId: 'origin-1',
        payload: { transcript_path: '/opt/claude-cfg/projects/-repo/origin-1.jsonl' },
      }));
      expect(f.bindings[0].binding.transcriptPath)
        .toBe('/opt/claude-cfg/projects/-repo/origin-1.jsonl');
    });

    it('drops an unknown permission mode instead of persisting it', () => {
      ingest.handle(makeSignal({
        ptyId: 'pty-a',
        agentSessionId: 'origin-1',
        payload: { permissionMode: 'yolo' },
      }));
      expect(fixture.bindings[0].binding.permissionMode).toBeUndefined();
    });

    it('skips kinds that carry no session identity', () => {
      ingest.handle(makeSignal({ ptyId: 'pty-a', kind: 'agent.activity', agentSessionId: 'origin-1' }));
      ingest.handle(makeSignal({ ptyId: 'pty-a', kind: 'agent.stop' })); // no agentSessionId
      expect(fixture.bindings).toHaveLength(0);
    });

    it('does not lose the signal when the binding write fails', () => {
      const f = makeDeps();
      f.deps.applyResumeBinding = () => { throw new Error('state write failed'); };
      const i = new HookIngest(f.deps);
      expect(i.handle(makeSignal({ ptyId: 'pty-a', agentSessionId: 'origin-1' }))).toEqual({ ok: true });
      expect(f.emitted).toHaveLength(1);
    });
  });

  describe('transcript nudge (Chat View)', () => {
    // All five kinds a resolved signal can carry. Chat View needs every one:
    // the stop kinds are turn boundaries (and the first nudge that can carry a
    // freshly-captured transcriptPath), activity is the mid-turn liveness
    // nudge, awaiting_input puts the last assistant line on screen before the
    // composer locks, and session_start invalidates a reused pane's rows.
    const kinds: AgentSignalKind[] = [
      'agent.stop',
      'agent.subagent_stop',
      'agent.activity',
      'agent.awaiting_input',
      'agent.session_start',
    ];

    for (const kind of kinds) {
      it(`fires for ${kind}`, () => {
        const f = makeDeps();
        const i = new HookIngest(f.deps);
        i.handle(makeSignal({ ptyId: 'pty-a', kind, agentSessionId: 'origin-1' }));
        expect(f.nudges).toEqual([{ sessionId: 'pty-a', kind }]);
      });
    }

    it('fires AFTER the resume binding is captured, so the path is available', () => {
      const order: string[] = [];
      const f = makeDeps();
      f.deps.applyResumeBinding = () => { order.push('binding'); };
      f.deps.onTranscriptNudge = () => { order.push('nudge'); };
      const i = new HookIngest(f.deps);
      i.handle(makeSignal({
        ptyId: 'pty-a',
        kind: 'agent.stop',
        agentSessionId: 'origin-1',
        payload: { transcript_path: '/t/origin-1.jsonl' },
      }));
      expect(order).toEqual(['binding', 'nudge']);
    });

    it('does NOT fire for an unresolved signal', () => {
      const f = makeDeps([session({ id: 'pty-a', cwd: '/elsewhere', env: {} })]);
      const i = new HookIngest(f.deps);
      expect(i.handle(makeSignal({ cwd: '/nowhere' })).reason).toBe('no-workspace-match');
      expect(f.nudges).toHaveLength(0);
    });

    it('does NOT fire for an invalid envelope', () => {
      const f = makeDeps();
      const i = new HookIngest(f.deps);
      i.handle({ kind: 'nope' });
      expect(f.nudges).toHaveLength(0);
    });

    it('does not lose the signal when the nudge throws', () => {
      const f = makeDeps();
      f.deps.onTranscriptNudge = () => { throw new Error('projector exploded'); };
      const i = new HookIngest(f.deps);
      expect(i.handle(makeSignal({ ptyId: 'pty-a' }))).toEqual({ ok: true });
      expect(f.emitted).toHaveLength(1);
    });
  });

  describe('detector arbitration (the daemon-side emission site)', () => {
    const complete = { agent: 'Claude Code', status: 'complete' };
    const awaiting = { agent: 'Claude Code', status: 'awaiting_input' };

    it('tags a plain detector emission and records it in the shared ledger', () => {
      expect(ingest.arbitrateDetector('pty-a', complete)).toEqual({ source: 'detector', decision: 'emit' });
      // Same-kind repeat inside the window is the detector→detector collapse.
      expect(ingest.arbitrateDetector('pty-a', complete)).toEqual({ source: 'detector', decision: 'dedup' });
    });

    it('vetoes rather than dedups a detector turn-end that follows a hook', () => {
      // The veto is checked BEFORE the ledger, exactly as main ordered it: any
      // hook signal makes the pane governed, so the follow-up detector never
      // reaches recordDetector. 'dedup' would still suppress the toast, but it
      // would ALSO write the detector into the ledger and let a lifecycle tee
      // through — the veto is the stronger, hook-canonical outcome.
      ingest.handle(makeSignal({ ptyId: 'pty-a' }));
      fixture.advance(200);
      expect(ingest.arbitrateDetector('pty-a', complete)).toEqual({ source: 'detector', decision: 'veto' });
    });

    it('vetoes a turn-end on a hook-governed pane, but never an approval prompt', () => {
      // A non-emit kind is enough to establish authority.
      ingest.handle(makeSignal({ ptyId: 'pty-a', kind: 'agent.activity' }));
      expect(ingest.arbitrateDetector('pty-a', complete)).toEqual({ source: 'detector', decision: 'veto' });
      // awaiting_input has no hook for the common approval prompts — vetoing
      // it would silence a genuinely blocked pane for the authority TTL.
      expect(ingest.arbitrateDetector('pty-a', awaiting)).toEqual({ source: 'detector', decision: 'emit' });
    });

    it('leaves authority for one agent from vetoing a different one on the same pane', () => {
      ingest.handle(makeSignal({ ptyId: 'pty-a', kind: 'agent.activity' }));
      expect(ingest.arbitrateDetector('pty-a', { agent: 'Codex CLI', status: 'complete' }))
        .toEqual({ source: 'detector', decision: 'emit' });
    });

    it('carries no decision for statuses that never participated in dedup', () => {
      expect(ingest.arbitrateDetector('pty-a', { agent: 'Claude Code', status: 'running' }))
        .toEqual({ source: 'detector' });
      expect(ingest.arbitrateDetector('pty-a', { agent: 'Some Unknown Agent', status: 'complete' }))
        .toEqual({ source: 'detector' });
    });
  });

  describe('signal health', () => {
    it('counts a burst without a single unresolved signal', () => {
      // The daemon resolves in-process, so a burst that would have saturated
      // main's renderer round-trip costs nothing here.
      for (let n = 0; n < 12; n++) ingest.handle(makeSignal({ ptyId: 'pty-a' }));
      const stats = ingest.getLatencyMeter().getStats();
      expect(stats.total).toBe(12);
      expect(stats.workspaceMatchRate).toEqual({ matched: 12, missed: 0 });
      expect(stats.perAgent.claude).toBe(12);
    });
  });
});

describe('resolveSessionIdForSignal', () => {
  const sessions: HookIngestSession[] = [
    session({ id: 'pty-a', cwd: '/repo', env: { WMUX_WORKSPACE_ID: 'ws-1' } }),
    session({ id: 'pty-b', cwd: '/repo/sub', env: { WMUX_WORKSPACE_ID: 'ws-1' } }),
    session({ id: 'pty-c', cwd: '/other', env: { WMUX_WORKSPACE_ID: 'ws-2' } }),
  ];

  it('prefers the exact ptyId — the pane the hook actually fired from', () => {
    expect(resolveSessionIdForSignal(
      makeSignal({ ptyId: 'pty-b', cwd: '/repo', workspaceId: 'ws-1' }),
      sessions,
    )).toBe('pty-b');
  });

  it('refuses a ptyId that claims the wrong workspace', () => {
    // Pane env is writable from inside the pane, so an authenticated hook must
    // not be able to target a sibling pane by id. Falls back to cwd routing.
    expect(resolveSessionIdForSignal(
      makeSignal({ ptyId: 'pty-c', cwd: '/repo', workspaceId: 'ws-1' }),
      sessions,
    )).toBe('pty-a');
  });

  it('ignores a ptyId that names no live session', () => {
    expect(resolveSessionIdForSignal(
      makeSignal({ ptyId: 'pty-gone', cwd: '/other' }),
      sessions,
    )).toBe('pty-c');
  });

  it('resolves a lone pane in the claimed workspace when cwd cannot place it', () => {
    expect(resolveSessionIdForSignal(
      makeSignal({ cwd: '/tmp/unrelated', workspaceId: 'ws-2' }),
      sessions,
    )).toBe('pty-c');
  });

  it('falls through rather than guessing between sibling panes', () => {
    expect(resolveSessionIdForSignal(
      makeSignal({ cwd: '/tmp/unrelated', workspaceId: 'ws-1' }),
      sessions,
    )).toBeNull();
  });

  it('matches cwd exactly before falling back to the longest prefix', () => {
    expect(resolveSessionIdForSignal(makeSignal({ cwd: '/repo/sub' }), sessions)).toBe('pty-b');
    expect(resolveSessionIdForSignal(makeSignal({ cwd: '/repo/sub/deep' }), sessions)).toBe('pty-b');
    expect(resolveSessionIdForSignal(makeSignal({ cwd: '/repo/other' }), sessions)).toBe('pty-a');
  });

  it('requires a proper directory prefix', () => {
    expect(resolveSessionIdForSignal(makeSignal({ cwd: '/repository' }), sessions)).toBeNull();
  });

  it('collapses `..` so a payload cannot walk past the prefix check', () => {
    // Without normalization this reads as a subdirectory of /repo.
    expect(resolveSessionIdForSignal(makeSignal({ cwd: '/repo/../elsewhere' }), sessions)).toBeNull();
  });

  it('normalizes Windows paths to the same key', () => {
    const win = [session({ id: 'pty-w', cwd: 'D:\\wmux', env: {} })];
    expect(resolveSessionIdForSignal(makeSignal({ cwd: 'd:/wmux/src' }), win)).toBe('pty-w');
  });

  it('breaks a cwd tie toward the most recently active pane', () => {
    const tied = [
      session({ id: 'pty-old', cwd: '/repo', env: {}, lastActivity: '2026-01-01T00:00:00.000Z' }),
      session({ id: 'pty-new', cwd: '/repo', env: {}, lastActivity: '2026-02-01T00:00:00.000Z' }),
    ];
    expect(resolveSessionIdForSignal(makeSignal({ cwd: '/repo' }), tied)).toBe('pty-new');
  });
});
