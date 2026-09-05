import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  HookIngest,
  resolveSessionIdForSignal,
  type DetectorHeldEventData,
  type HookAgentEventData,
  type HookIngestSession,
} from '../HookIngest';
import { DEFAULT_ALARM_WINDOW_MS } from '../../../shared/hooks/CompletionAlarm';
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
  // #770 — track every approval-sink call so the locally-answered expiry path
  // can be asserted (expireForSession reason + that nothing broadcasts).
  const approvalsCalls: Array<{ sessionId: string; reason: string; kind?: string }> = [];
  // The verdict gate's confirmed-detector outlet: a held detector candidate
  // broadcasts through this at window expiry, not through emitAgentEvent.
  const detectorEmitted: Array<{ sessionId: string; data: DetectorHeldEventData }> = [];
  let clock = 10_000;
  const deps = {
    listLiveSessions: () => sessions,
    emitAgentEvent: (sessionId: string, data: HookAgentEventData) => {
      emitted.push({ sessionId, data });
    },
    emitDetectorEvent: (sessionId: string, data: DetectorHeldEventData) => {
      detectorEmitted.push({ sessionId, data });
    },
    applyResumeBinding: (ptyId: string, binding: ResumeBinding) => {
      bindings.push({ ptyId, binding });
    },
    onTranscriptNudge: (sessionId: string, kind: AgentSignalKind) => {
      nudges.push({ sessionId, kind });
    },
    approvals: {
      noteHookAwaitingInput: () => { /* tracked at the registry level */ },
      noteGateAwaiting: () => 'gate-id',
      expireForSession: (sessionId: string, reason: string, kind?: string) => {
        approvalsCalls.push({ sessionId, reason, kind });
      },
    },
    log: () => { /* silent in tests */ },
    now: () => clock,
  };
  return {
    deps,
    emitted,
    detectorEmitted,
    bindings,
    nudges,
    approvalsCalls,
    advance: (ms: number) => { clock += ms; },
  };
}

describe('HookIngest', () => {
  let ingest: HookIngest;
  let fixture: ReturnType<typeof makeDeps>;

  beforeEach(() => {
    // Fake timers: the verdict gate's provisional window is a real setTimeout
    // inside HookIngest, so confirmation is driven by advancing the clock.
    vi.useFakeTimers();
    fixture = makeDeps();
    ingest = new HookIngest(fixture.deps);
  });

  afterEach(() => {
    vi.useRealTimers();
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
      // Arm the turn gate first — the alarm drops a stop on a pane it never
      // saw work (idle-chrome repaint protection).
      ingest.handle(makeSignal({ ptyId: 'pty-a', kind: 'agent.activity', payload: { tool_name: 'Bash' } }));
      const res = ingest.handle(makeSignal({ ptyId: 'pty-a', workspaceId: 'ws-1' }));
      // hold: the bridge is answered NOW; the broadcast waits out the
      // provisional window (the 2s hook budget must never block on it).
      expect(res).toEqual({ ok: true });
      expect(fixture.emitted).toHaveLength(1);
      vi.advanceTimersByTime(DEFAULT_ALARM_WINDOW_MS);
      expect(fixture.emitted).toHaveLength(2);
      const { sessionId, data } = fixture.emitted[1];
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
      // A subagent stop is never a lead-turn end: status-only, immediate, and
      // RUNNING — the pane's own turn is still going.
      expect(fixture.emitted[0].data).toMatchObject({
        status: 'running',
        message: 'Subagent finished',
        decision: 'internal',
      });
      ingest.handle(makeSignal({ ptyId: 'pty-a', kind: 'agent.awaiting_input' }));
      vi.advanceTimersByTime(DEFAULT_ALARM_WINDOW_MS);
      expect(fixture.emitted[1].data).toMatchObject({
        status: 'awaiting_input',
        message: 'Awaiting input',
        decision: 'emit',
      });
    });

    it('reports a broadcast failure as internal-error rather than throwing at the bridge', () => {
      const boom = makeDeps();
      boom.deps.emitAgentEvent = () => { throw new Error('pipe closed'); };
      const failing = new HookIngest(boom.deps);
      // A gate-missed stop still broadcasts its status-only event immediately,
      // so the failure surfaces on the same path it always did.
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
      ingest.handle(makeSignal({ ptyId: 'pty-a', kind: 'agent.activity', payload: { tool_name: 'Bash' } }));
      ingest.handle(makeSignal({ ptyId: 'pty-a', kind: 'agent.stop' }));
      vi.advanceTimersByTime(DEFAULT_ALARM_WINDOW_MS);
      expect(fixture.emitted.map((e) => [e.data.hookKind, e.data.decision])).toEqual([
        ['agent.session_start', 'activity'],
        ['agent.activity', 'activity'],
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

  describe('user_prompt_submit broadcast (turn start — hook-driven running)', () => {
    it('broadcasts running immediately, stamped with its own hookKind', () => {
      const res = ingest.handle(makeSignal({
        ptyId: 'pty-a',
        kind: 'agent.user_prompt_submit',
        payload: { prompt: 'do the thing' },
      }));
      expect(res).toEqual({ ok: true });
      // No byte threshold, no throttle window: one hook, one broadcast.
      expect(fixture.emitted).toHaveLength(1);
      const { sessionId, data } = fixture.emitted[0];
      expect(sessionId).toBe('pty-a');
      expect(data.status).toBe('running');
      expect(data.agent).toBe('Claude Code');
      expect(data.source).toBe('hook');
      // The stamp is what lets main tell this apart from an activity ping and
      // light the status dot rather than write a Fleet activity line.
      expect(data.hookKind).toBe('agent.user_prompt_submit');
      expect(data.decision).toBe('activity');
    });

    it('keeps the turn start out of the dedup ledger', () => {
      ingest.handle(makeSignal({ ptyId: 'pty-a', kind: 'agent.user_prompt_submit' }));
      // A ledger entry here would make this turn's own end land as 'dedup' —
      // a silent completion on every turn.
      expect(ingest.router.recordDetector('claude', 'agent.stop', 'pty-a', 10_000)).toBe('emit');
    });

    it('arms the turn gate so this turn’s stop can announce', () => {
      // The alarm drops a stop on a pane it never saw work. Before the turn
      // start was classified it fell through to the non-emit drop, and a
      // hook-only turn (no tool calls) had no working evidence at all.
      ingest.handle(makeSignal({ ptyId: 'pty-a', kind: 'agent.user_prompt_submit' }));
      fixture.advance(100);
      ingest.handle(makeSignal({ ptyId: 'pty-a', kind: 'agent.stop' }));
      vi.advanceTimersByTime(DEFAULT_ALARM_WINDOW_MS);
      expect(fixture.emitted.map((e) => [e.data.hookKind, e.data.decision])).toEqual([
        ['agent.user_prompt_submit', 'activity'],
        ['agent.stop', 'emit'],
      ]);
    });
  });

  describe('input_answered (#770 — locally-answered AskUserQuestion expires the phone card)', () => {
    it('expires the pending request with reason answered-locally and never broadcasts', () => {
      // PC answers an AskUserQuestion directly: the bridge promotes the
      // AskUserQuestion PostToolUse to agent.input_answered, and the daemon
      // expires the still-pending phone card mid-turn — before agent.stop.
      const res = ingest.handle(makeSignal({ ptyId: 'pty-a', kind: 'agent.input_answered' }));
      expect(res).toEqual({ ok: true });
      expect(fixture.approvalsCalls).toEqual([
        { sessionId: 'pty-a', reason: 'answered-locally', kind: 'awaiting_input' },
      ]);
      // Not a turn boundary or even a metadata ping: nothing fans out.
      expect(fixture.emitted).toHaveLength(0);
    });

    it('scopes the sweep to awaiting_input so a parallel permission gate survives', () => {
      // A turn can open a gate and an AskUserQuestion at once. Answering the
      // question locally says nothing about the gate, and expiring the gate
      // record drops its waiter — the tool falls back to the local prompt
      // while the phone operator just sees the card vanish.
      ingest.handle(makeSignal({ ptyId: 'pty-a', kind: 'agent.input_answered' }));
      expect(fixture.approvalsCalls[0].kind).toBe('awaiting_input');
    });

    it('scopes a locally-answered permission gate to awaiting_permission', () => {
      // The mirror of the rule above: a gate answered in the TUI must not
      // expire a question card still on screen.
      ingest.handle(makeSignal({ ptyId: 'pty-a', kind: 'agent.permission_answered' }));
      expect(fixture.approvalsCalls).toEqual([
        { sessionId: 'pty-a', reason: 'answered-locally', kind: 'awaiting_permission' },
      ]);
    });

    it('does not capture a resume binding or nudge the transcript (early return)', () => {
      ingest.handle(makeSignal({
        ptyId: 'pty-a',
        kind: 'agent.input_answered',
        agentSessionId: 'origin-1',
      }));
      expect(fixture.bindings).toHaveLength(0);
      expect(fixture.nudges).toHaveLength(0);
    });

    it('keeps the agent.stop backstop — a later stop still expires + broadcasts', () => {
      // If PostToolUse never arrives (turn interrupted), agent.stop is the
      // backstop. A second expireForSession on an already-expired record is a
      // registry-level no-op; here we confirm the signal path still routes it.
      ingest.handle(makeSignal({ ptyId: 'pty-a', kind: 'agent.input_answered' }));
      fixture.advance(100);
      ingest.handle(makeSignal({ ptyId: 'pty-a', kind: 'agent.activity', payload: { tool_name: 'Bash' } }));
      ingest.handle(makeSignal({ ptyId: 'pty-a', kind: 'agent.stop' }));
      // The turn-ended expiry rides the resume closure: a REBUTTED stop must
      // leave the phone card alive, so it may only fire at confirmation.
      expect(fixture.approvalsCalls).toEqual([
        { sessionId: 'pty-a', reason: 'answered-locally', kind: 'awaiting_input' },
      ]);
      vi.advanceTimersByTime(DEFAULT_ALARM_WINDOW_MS);
      expect(fixture.approvalsCalls).toEqual([
        { sessionId: 'pty-a', reason: 'answered-locally', kind: 'awaiting_input' },
        // The backstop stays kind-agnostic: the turn ended, so every pending
        // record on the pane is moot regardless of kind.
        { sessionId: 'pty-a', reason: 'turn-ended', kind: undefined },
      ]);
      // Only the stop broadcasts — input_answered stayed silent.
      const stops = fixture.emitted.filter((e) => e.data.hookKind === 'agent.stop');
      expect(stops).toHaveLength(1);
      expect(stops[0].data.decision).toBe('emit');
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
      vi.advanceTimersByTime(DEFAULT_ALARM_WINDOW_MS);
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
    it('collapses a detector repaint against a confirmed emit inside the dedup window', () => {
      // Detector-ONLY pane: a hook-armed pane vetoes the detector before the
      // alarm ever sees it (covered below), so the repaint collapse this test
      // pins is the detector→detector one. 'running' is the working evidence.
      ingest.arbitrateDetector('pty-a', { agent: 'Claude Code', status: 'running' });
      ingest.arbitrateDetector('pty-a', { agent: 'Claude Code', status: 'complete' });
      vi.advanceTimersByTime(DEFAULT_ALARM_WINDOW_MS);
      expect(fixture.detectorEmitted.at(-1)?.data.decision).toBe('emit');
      // The next turn's working evidence re-arms the gate (clears `announced`)
      // so the repaint can arbitrate at all — and inside the 10s window of the
      // confirmed emit it lands as 'dedup' at ITS confirmation.
      fixture.advance(200);
      ingest.notePaneWorking('pty-a', 'claude');
      expect(ingest.arbitrateDetector('pty-a', { agent: 'Claude Code', status: 'complete' }))
        .toEqual({ source: 'detector', decision: 'pending' });
      vi.advanceTimersByTime(DEFAULT_ALARM_WINDOW_MS);
      expect(fixture.detectorEmitted.at(-1)?.data.decision).toBe('dedup');
    });

    it('replaces a pending detector window with the hook Stop — decision stays "emit", never a stale "dedup"', () => {
      // detect-then-hook race: the detector's repaint leads by tens of ms,
      // the hook's Stop replaces its provisional window (R2). The detector's
      // stash never fires, and because ledger writes happen at CONFIRMATION
      // (R1), the hook's recordHook runs against an empty ledger — 'emit'.
      ingest.arbitrateDetector('pty-a', { agent: 'Claude Code', status: 'running' });
      ingest.arbitrateDetector('pty-a', { agent: 'Claude Code', status: 'complete' });
      fixture.advance(50);
      expect(ingest.handle(makeSignal({ ptyId: 'pty-a' }))).toEqual({ ok: true });
      vi.advanceTimersByTime(DEFAULT_ALARM_WINDOW_MS);
      expect(fixture.detectorEmitted).toHaveLength(0);
      expect(fixture.emitted).toHaveLength(1);
      expect(fixture.emitted[0].data.decision).toBe('emit');
    });

    it('lets a different kind through — a Stop after an awaiting_input is a distinct event', () => {
      ingest.handle(makeSignal({ ptyId: 'pty-a', kind: 'agent.awaiting_input' }));
      vi.advanceTimersByTime(DEFAULT_ALARM_WINDOW_MS);
      // The user answers and the agent works again — that clears `announced`
      // and re-arms the gate, so the turn's real end announces.
      ingest.handle(makeSignal({ ptyId: 'pty-a', kind: 'agent.activity', payload: { tool_name: 'Bash' } }));
      fixture.advance(100);
      ingest.handle(makeSignal({ ptyId: 'pty-a', kind: 'agent.stop' }));
      vi.advanceTimersByTime(DEFAULT_ALARM_WINDOW_MS);
      expect(fixture.emitted.map((e) => [e.data.hookKind, e.data.decision])).toEqual([
        ['agent.awaiting_input', 'emit'],
        ['agent.activity', 'activity'],
        ['agent.stop', 'emit'],
      ]);
    });
  });

  describe('the verdict gate, end-to-end through handle()', () => {
    it('rebuttal inside the window: no broadcast ever fires and the ledger stays clean', () => {
      ingest.handle(makeSignal({ ptyId: 'pty-a', kind: 'agent.activity', payload: { tool_name: 'Bash' } }));
      expect(ingest.handle(makeSignal({ ptyId: 'pty-a' }))).toEqual({ ok: true });
      // A tool call resumes inside the provisional window — the stop was a
      // repaint, not a turn end.
      ingest.handle(makeSignal({ ptyId: 'pty-a', kind: 'agent.activity', payload: { tool_name: 'Edit' } }));
      vi.advanceTimersByTime(DEFAULT_ALARM_WINDOW_MS * 2);
      expect(fixture.emitted.filter((e) => e.data.hookKind === 'agent.stop')).toHaveLength(0);
      // R1: a rebutted candidate wrote nothing to the dedup ledger — the turn's
      // real Stop must still arbitrate against an empty ledger, not a ghost.
      fixture.advance(100);
      expect(ingest.router.recordDetector('claude', 'agent.stop', 'pty-a', 10_100)).toBe('emit');
    });

    it('a stop stamped with leftover background work drops immediately and arms the gate', () => {
      ingest.handle(makeSignal({ ptyId: 'pty-a', kind: 'agent.activity', payload: { tool_name: 'Bash' } }));
      const res = ingest.handle(makeSignal({
        ptyId: 'pty-a',
        payload: { wmux_leftover_work: 2 },
      }));
      // Not held — the bridge is answered and the candidate is rejected NOW.
      expect(res).toEqual({ ok: true });
      // #1096 — the projection must agree with the verdict: the turn has NOT
      // ended, so the status says running, not eventShapeFor's 'complete'
      // (which sat on the roster for the whole background-agent hold).
      expect(fixture.emitted.at(-1)?.data).toMatchObject({
        hookKind: 'agent.stop',
        decision: 'internal',
        status: 'running',
        message: 'Waiting on background agents',
      });
      // The leftover stop counts as WORKING evidence (the turn is still going),
      // so a subsequent clean stop in the same turn may still announce — and
      // that real stop projects 'complete' exactly as before.
      ingest.handle(makeSignal({ ptyId: 'pty-a' }));
      vi.advanceTimersByTime(DEFAULT_ALARM_WINDOW_MS);
      expect(fixture.emitted.at(-1)?.data).toMatchObject({
        decision: 'emit',
        status: 'complete',
      });
    });

    it('an answered cue cancels a pending attention window before its broadcast', () => {
      ingest.handle(makeSignal({ ptyId: 'pty-a', kind: 'agent.activity', payload: { tool_name: 'Bash' } }));
      ingest.handle(makeSignal({ ptyId: 'pty-a', kind: 'agent.awaiting_input' }));
      // The user answers in the TUI before the window expires: the bridge
      // promotes the PostToolUse to input_answered, which must cancel the
      // held broadcast — the question no longer exists.
      ingest.handle(makeSignal({ ptyId: 'pty-a', kind: 'agent.input_answered' }));
      vi.advanceTimersByTime(DEFAULT_ALARM_WINDOW_MS * 2);
      expect(fixture.emitted.filter((e) => e.data.hookKind === 'agent.awaiting_input')).toHaveLength(0);
    });

    it('dropPty cancels an open provisional window — a reused id starts from an empty gate', () => {
      ingest.handle(makeSignal({ ptyId: 'pty-a', kind: 'agent.activity', payload: { tool_name: 'Bash' } }));
      ingest.handle(makeSignal({ ptyId: 'pty-a' }));
      ingest.dropPty('pty-a');
      vi.advanceTimersByTime(DEFAULT_ALARM_WINDOW_MS * 2);
      expect(fixture.emitted.filter((e) => e.data.hookKind === 'agent.stop')).toHaveLength(0);
    });

    it('a confirmed completion makes the same turn\'s next stop an internal repaint', () => {
      ingest.handle(makeSignal({ ptyId: 'pty-a', kind: 'agent.activity', payload: { tool_name: 'Bash' } }));
      ingest.handle(makeSignal({ ptyId: 'pty-a' }));
      vi.advanceTimersByTime(DEFAULT_ALARM_WINDOW_MS);
      expect(fixture.emitted.at(-1)?.data.decision).toBe('emit');
      // A second stop with no working evidence in between — `announced` is
      // still set, so the alarm rejects it as a repaint of the SAME turn and
      // it broadcasts immediately as internal (status dot only, no ledger).
      expect(ingest.handle(makeSignal({ ptyId: 'pty-a' }))).toEqual({ ok: true });
      expect(fixture.emitted.at(-1)?.data).toMatchObject({
        hookKind: 'agent.stop',
        decision: 'internal',
      });
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
      // 'running' arms the turn gate — the only working evidence an
      // ungoverned pane's alarm ever sees.
      expect(ingest.arbitrateDetector('pty-a', { agent: 'Claude Code', status: 'running' }))
        .toEqual({ source: 'detector' });
      expect(ingest.arbitrateDetector('pty-a', complete)).toEqual({ source: 'detector', decision: 'pending' });
      vi.advanceTimersByTime(DEFAULT_ALARM_WINDOW_MS);
      expect(fixture.detectorEmitted.at(-1)?.data.decision).toBe('emit');
      // Same-kind repeat inside the dedup window is the detector→detector
      // collapse — again held first, 'dedup' only at confirmation.
      ingest.notePaneWorking('pty-a', 'claude');
      expect(ingest.arbitrateDetector('pty-a', complete)).toEqual({ source: 'detector', decision: 'pending' });
      vi.advanceTimersByTime(DEFAULT_ALARM_WINDOW_MS);
      expect(fixture.detectorEmitted.at(-1)?.data.decision).toBe('dedup');
    });

    it('vetoes rather than dedups a detector turn-end that follows a hook', () => {
      // The veto is checked BEFORE the ledger, exactly as main ordered it: any
      // hook signal makes the pane governed, so the follow-up detector never
      // reaches recordDetector. 'dedup' would still suppress the toast, but it
      // would ALSO write the detector into the ledger and let a lifecycle tee
      // through — the veto is the stronger, hook-canonical outcome.
      ingest.handle(makeSignal({ ptyId: 'pty-a', kind: 'agent.activity' }));
      ingest.handle(makeSignal({ ptyId: 'pty-a' }));
      vi.advanceTimersByTime(DEFAULT_ALARM_WINDOW_MS);
      fixture.advance(200);
      expect(ingest.arbitrateDetector('pty-a', complete)).toEqual({ source: 'detector', decision: 'veto' });
    });

    it('vetoes a turn-end on a hook-governed pane, but never an approval prompt', () => {
      // A non-emit kind is enough to establish authority.
      ingest.handle(makeSignal({ ptyId: 'pty-a', kind: 'agent.activity' }));
      expect(ingest.arbitrateDetector('pty-a', complete)).toEqual({ source: 'detector', decision: 'veto' });
      // awaiting_input has no hook for the common approval prompts — vetoing
      // it would silence a genuinely blocked pane for the authority TTL. It is
      // still HELD (attention window) before its broadcast.
      expect(ingest.arbitrateDetector('pty-a', awaiting)).toEqual({ source: 'detector', decision: 'pending' });
      vi.advanceTimersByTime(DEFAULT_ALARM_WINDOW_MS);
      expect(fixture.detectorEmitted.at(-1)?.data).toMatchObject({
        status: 'awaiting_input',
        decision: 'emit',
      });
    });

    it('leaves authority for one agent from vetoing a different one on the same pane', () => {
      ingest.handle(makeSignal({ ptyId: 'pty-a', kind: 'agent.activity' }));
      // The Codex turn DID work (byte-activity backstop), so its stop is
      // merely held, not vetoed by Claude's authority.
      ingest.notePaneWorking('pty-a', 'codex');
      expect(ingest.arbitrateDetector('pty-a', { agent: 'Codex CLI', status: 'complete' }))
        .toEqual({ source: 'detector', decision: 'pending' });
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

  describe('permission gate vs the session permission mode', () => {
    // Build an ingest whose gate config actually gates Bash, and count the
    // gate records it opens. The shared fixture leaves gateConfig unset (=
    // nothing gated), which would make every assertion here vacuously pass.
    function gatingIngest() {
      const base = makeDeps();
      let gatesOpened = 0;
      const ingestWithGate = new HookIngest({
        ...base.deps,
        gateConfig: () => ({ gatedTools: ['Bash'] }),
        approvals: {
          ...base.deps.approvals,
          noteGateAwaiting: () => {
            gatesOpened += 1;
            return 'gate-id';
          },
        },
      });
      return { ingestWithGate, gates: () => gatesOpened, emitted: base.emitted };
    }

    function gateSignal(permissionMode?: string): AgentSignal {
      return makeSignal({
        kind: 'agent.awaiting_permission',
        ptyId: 'pty-a',
        payload: {
          tool_name: 'Bash',
          ...(permissionMode ? { permission_mode: permissionMode } : {}),
        },
      });
    }

    it('passes a bypassPermissions session straight through without opening a gate', () => {
      // The user launched with --dangerously-skip-permissions: re-asking is the
      // exact thing they opted out of, and with no phone attached every gated
      // call would stall until the deadline.
      const { ingestWithGate, gates, emitted } = gatingIngest();
      const result = ingestWithGate.handlePermissionGate(gateSignal('bypassPermissions'));

      expect(result.ok).toBe(true);
      expect(result.gateId).toBeUndefined();
      expect(gates()).toBe(0);
      // Liveness still flows, so the phone header keeps showing the pane busy.
      expect(emitted.at(-1)?.data.hookKind).toBe('agent.tool_started');
    });

    it('still gates the same tool when the session prompts (acceptEdits / default / absent)', () => {
      // acceptEdits auto-approves edits but still prompts for Bash, so its gate
      // stays meaningful — only bypassPermissions is a declared opt-out.
      for (const mode of ['acceptEdits', 'default', 'plan', undefined]) {
        const { ingestWithGate, gates } = gatingIngest();
        const result = ingestWithGate.handlePermissionGate(gateSignal(mode));

        expect(result.gateId, `mode=${String(mode)}`).toBe('gate-id');
        expect(gates(), `mode=${String(mode)}`).toBe(1);
      }
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
