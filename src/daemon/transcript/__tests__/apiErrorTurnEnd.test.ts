import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AgentSignal } from '../../../shared/hooks/signal-types';
import type { ResumeBinding } from '../../../shared/agentResume';
import { ApiErrorTurnEnds, GRACE_MS, apiErrorFromTranscriptLine, stopFailureSignal } from '../apiErrorTurnEnd';
import { TranscriptActivityWatcher } from '../TranscriptActivityWatcher';

const TURN_OPENED_AT = Date.parse('2026-10-17T02:31:37.106Z');
const NOTICE = 'Your organization has disabled Claude subscription access for Claude Code · Use an Anthropic API key instead, or ask your admin to enable access';
// The entry Claude Code 2.1.302 wrote for the live repro (fields trimmed).
const apiError = (error: string, text: string, timestamp = '2026-10-17T02:31:37.645Z') => JSON.stringify({
  type: 'assistant', uuid: 'e1', timestamp, isApiErrorMessage: true, error,
  message: { role: 'assistant', content: [{ type: 'text', text }] },
});
const turnDuration = JSON.stringify({ type: 'system', subtype: 'turn_duration', durationMs: 458, timestamp: '2026-10-17T02:31:37.653Z' });
const reply = JSON.stringify({ type: 'assistant', uuid: 'a2', timestamp: '2026-10-17T02:31:39.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'retried fine' }] } });

function gate(opts: { turnOpen?: boolean } = {}) {
  // The daemon clock, just after Claude Code wrote the entry.
  let now = Date.parse('2026-10-17T02:31:37.700Z');
  const sent: AgentSignal[] = [];
  const turnEnds = new ApiErrorTurnEnds({
    // The pane's open turn started at TURN_OPENED_AT.
    isCurrentOpenTurn: (_id, at) => (opts.turnOpen ?? true) && at >= TURN_OPENED_AT,
    signalFor: (id, _path, end) => stopFailureSignal(id, { agent: 'claude', sessionId: 's', cwd: '/w' }, end, now),
    emit: (signal) => sent.push(signal),
    now: () => now,
  });
  return { turnEnds, sent, advance: (ms: number) => { now += ms; } };
}

describe('apiErrorFromTranscriptLine', () => {
  it('reads the error code, the text Claude showed and the entry time', () => {
    expect(apiErrorFromTranscriptLine(apiError('oauth_org_not_allowed', NOTICE)))
      .toEqual({ error: 'oauth_org_not_allowed', message: NOTICE, at: Date.parse('2026-10-17T02:31:37.645Z') });
    expect(apiErrorFromTranscriptLine(reply)).toBeNull();
    expect(apiErrorFromTranscriptLine(turnDuration)).toBeNull();
    // A subagent's failure is not the pane's turn end.
    expect(apiErrorFromTranscriptLine(apiError('rate_limit', 'x').replace('"type":"assistant"', '"type":"assistant","isSidechain":true'))).toBeNull();
  });
});

describe('ApiErrorTurnEnds', () => {
  it('closes the current open turn with the stop_failure the hook would have sent, once', () => {
    const g = gate();
    // The previous turn's Stop, then this turn's prompt: neither speaks for its end.
    g.turnEnds.noteHookSignal('pty-1', 'agent.stop');
    g.turnEnds.noteHookSignal('pty-1', 'agent.user_prompt_submit');
    g.turnEnds.noteLine('pty-1', '/t.jsonl', apiError('rate_limit', "You've hit your limit · resets 3pm"));
    g.turnEnds.noteLine('pty-1', '/t.jsonl', turnDuration);
    g.turnEnds.settle();
    expect(g.sent).toEqual([]); // the real hook still has time
    g.advance(GRACE_MS);
    g.turnEnds.settle();
    g.advance(GRACE_MS);
    g.turnEnds.settle();
    expect(g.sent).toEqual([{
      kind: 'agent.stop_failure', agent: 'claude', agentSessionId: 's', cwd: '/w', ptyId: 'pty-1',
      ts: Date.parse('2026-10-17T02:31:37.700Z') + GRACE_MS,
      // rate_limit + the notice: the usage-limit registry reads exactly these.
      payload: { error: 'rate_limit', last_assistant_message: "You've hit your limit · resets 3pm" },
    }]);
  });

  it('stays silent when the hook spoke, the turn went on, the entry predates the turn, or no turn is open', () => {
    const hooked = gate();
    hooked.turnEnds.noteLine('pty-1', '/t.jsonl', apiError('oauth_org_not_allowed', NOTICE));
    hooked.advance(1000);
    hooked.turnEnds.noteHookSignal('pty-1', 'agent.stop_failure');
    hooked.advance(GRACE_MS);
    hooked.turnEnds.settle();
    expect(hooked.sent).toEqual([]);

    const resumed = gate();
    resumed.turnEnds.noteLine('pty-1', '/t.jsonl', apiError('server_error', 'overloaded'));
    resumed.turnEnds.noteLine('pty-1', '/t.jsonl', reply);
    resumed.advance(GRACE_MS);
    resumed.turnEnds.settle();
    expect(resumed.sent).toEqual([]);

    const earlier = gate();
    earlier.turnEnds.noteLine('pty-1', '/t.jsonl', apiError('oauth_org_not_allowed', NOTICE, '2026-10-17T02:29:08.891Z'));
    earlier.advance(GRACE_MS);
    earlier.turnEnds.settle();
    expect(earlier.sent).toEqual([]);

    const closed = gate({ turnOpen: false });
    closed.turnEnds.noteLine('pty-1', '/t.jsonl', apiError('oauth_org_not_allowed', NOTICE));
    closed.advance(GRACE_MS);
    closed.turnEnds.settle();
    expect(closed.sent).toEqual([]);
  });
});

describe('TranscriptActivityWatcher → Claude lines', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tx-apierr-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('hands over the tail written before the watch existed, then every appended line, hook-fed or not', () => {
    const file = path.join(dir, 's.jsonl');
    // A fresh session whose first turn failed before the transcript was watched.
    fs.writeFileSync(file, `${apiError('oauth_org_not_allowed', NOTICE)}\n${turnDuration}\n`);
    const binding: ResumeBinding = { agent: 'claude', sessionId: 's', cwd: dir, transcriptPath: file, ts: 0 };
    const lines: string[] = [];
    let ticks = 0;
    const watcher = new TranscriptActivityWatcher({
      listSessionIds: () => ['pty-1'],
      getBinding: () => binding,
      isAgentAlive: () => true,
      emit: () => undefined,
      onClaudeLine: (id, p, line) => { expect([id, p]).toEqual(['pty-1', file]); lines.push(line); },
      afterTick: () => { ticks += 1; },
      minGapMs: 0,
    });
    watcher.tick();
    expect(lines).toEqual([apiError('oauth_org_not_allowed', NOTICE), turnDuration]);
    fs.appendFileSync(file, `${reply}\n`);
    watcher.tick();
    expect(lines).toEqual([apiError('oauth_org_not_allowed', NOTICE), turnDuration, reply]);
    // A per-tool hook takes the activity line, not the API-error turn end.
    watcher.noteHookSignal('pty-1', 'agent.tool_started');
    watcher.tick();
    fs.appendFileSync(file, `${turnDuration}\n`);
    watcher.tick();
    expect(lines).toEqual([apiError('oauth_org_not_allowed', NOTICE), turnDuration, reply, turnDuration]);
    expect(ticks).toBe(4);
  });

  it('replays a transcript two panes share once, for the pane that keeps it', () => {
    const file = path.join(dir, 's.jsonl');
    fs.writeFileSync(file, `${apiError('oauth_org_not_allowed', NOTICE)}\n${turnDuration}\n`);
    const binding: ResumeBinding = { agent: 'claude', sessionId: 's', cwd: dir, transcriptPath: file, ts: 0 };
    const counts: Record<string, number> = {};
    const watcher = new TranscriptActivityWatcher({
      listSessionIds: () => ['pty-old', 'pty-new'],
      getBinding: () => binding,
      isAgentAlive: () => true,
      emit: () => undefined,
      onClaudeLine: (id) => { counts[id] = (counts[id] ?? 0) + 1; },
      minGapMs: 0,
    });
    watcher.noteHookSignal('pty-new', 'agent.session_start');
    for (let i = 0; i < 5; i++) watcher.tick();
    expect(watcher.watchedSessions()).toEqual(['pty-new']);
    expect(counts).toEqual({ 'pty-new': 2 });
  });
});
