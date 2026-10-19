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

const JUST_AFTER_ENTRY = Date.parse('2026-10-17T02:31:37.700Z');

function gate(opts: { turnOpen?: boolean; isReader?: (id: string, path: string) => boolean; start?: number } = {}) {
  // The daemon clock, by default just after Claude Code wrote the entry.
  let now = opts.start ?? JUST_AFTER_ENTRY;
  const sent: AgentSignal[] = [];
  const turnEnds = new ApiErrorTurnEnds({
    // The pane's open turn started at TURN_OPENED_AT.
    isCurrentOpenTurn: (_id, at) => (opts.turnOpen ?? true) && at >= TURN_OPENED_AT,
    isReader: opts.isReader ?? (() => true),
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
    const g = gate({ start: TURN_OPENED_AT });
    // The previous turn's Stop, then this turn's prompt: neither speaks for its end.
    g.turnEnds.noteHookSignal('pty-1', 'agent.stop');
    g.turnEnds.noteHookSignal('pty-1', 'agent.user_prompt_submit');
    g.advance(JUST_AFTER_ENTRY - TURN_OPENED_AT);
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

  it('leaves a retry alone: a new prompt drops the pending error and an older one never re-arms', () => {
    const g = gate();
    g.turnEnds.noteLine('pty-1', '/t.jsonl', apiError('server_error', 'overloaded'));
    g.advance(1000);
    // The user retries before the grace runs out; the retry's entries are late.
    g.turnEnds.noteHookSignal('pty-1', 'agent.user_prompt_submit');
    // A new watch replays the old error after the prompt.
    g.turnEnds.noteLine('pty-1', '/t.jsonl', apiError('server_error', 'overloaded'));
    g.advance(GRACE_MS);
    g.turnEnds.settle();
    expect(g.sent).toEqual([]);
  });

  it('keeps the error of the turn whose prompt hook arrived late', () => {
    const g = gate();
    g.turnEnds.noteLine('pty-1', '/t.jsonl', apiError('oauth_org_not_allowed', NOTICE));
    // The prompt hook fired before the error was written, but is ingested after.
    g.turnEnds.noteHookSignal('pty-1', 'agent.user_prompt_submit', TURN_OPENED_AT);
    g.advance(GRACE_MS);
    g.turnEnds.settle();
    expect(g.sent.map((s) => s.ptyId)).toEqual(['pty-1']);
  });

  it('a Stop that fired before the error does not speak for it, however late it arrives', () => {
    const g = gate();
    g.turnEnds.noteLine('pty-1', '/t.jsonl', apiError('rate_limit', 'limit'));
    g.advance(1000);
    // Fired at the turn's start (background work left), ingested after the error.
    g.turnEnds.noteHookSignal('pty-1', 'agent.stop', TURN_OPENED_AT);
    g.advance(GRACE_MS);
    g.turnEnds.settle();
    expect(g.sent.map((s) => s.ptyId)).toEqual(['pty-1']);
  });

  it('a queued prompt Claude Code starts after the error means the turn went on', () => {
    const g = gate();
    g.turnEnds.noteLine('pty-1', '/t.jsonl', apiError('server_error', 'overloaded'));
    g.turnEnds.noteLine('pty-1', '/t.jsonl', JSON.stringify({ type: 'attachment', isSidechain: false, attachment: { type: 'queued_command', prompt: 'next' }, timestamp: '2026-10-17T02:31:38.000Z' }));
    g.advance(GRACE_MS);
    g.turnEnds.settle();
    expect(g.sent).toEqual([]);
  });

  it("carries the turn's prompt id, the one Claude Code puts on its hooks", () => {
    const g = gate();
    g.turnEnds.noteLine('pty-1', '/t.jsonl', JSON.stringify({ type: 'user', promptId: 'b49e8ee5-dc46-478d-ae45-cdbb94cb3d42', message: { role: 'user', content: 'hi' }, timestamp: '2026-10-17T02:31:37.200Z' }));
    // A subagent's prompt is not the lead turn's.
    g.turnEnds.noteLine('pty-1', '/t.jsonl', JSON.stringify({ type: 'attachment', isSidechain: true, promptId: '00000000-0000-0000-0000-000000000000', timestamp: '2026-10-17T02:31:37.300Z' }));
    g.turnEnds.noteLine('pty-1', '/t.jsonl', apiError('oauth_org_not_allowed', NOTICE));
    g.advance(GRACE_MS);
    g.turnEnds.settle();
    expect(g.sent.map((s) => s.payload.prompt_id)).toEqual(['b49e8ee5-dc46-478d-ae45-cdbb94cb3d42']);
  });

  it("falls back to the prompt hook's id when the turn's user entry was never read", () => {
    const g = gate({ start: TURN_OPENED_AT });
    g.turnEnds.noteHookSignal('pty-1', 'agent.user_prompt_submit', TURN_OPENED_AT, 'p-hook');
    g.advance(JUST_AFTER_ENTRY - TURN_OPENED_AT);
    g.turnEnds.noteLine('pty-1', '/t.jsonl', apiError('oauth_org_not_allowed', NOTICE));
    g.advance(GRACE_MS);
    g.turnEnds.settle();
    expect(g.sent.map((s) => s.payload.prompt_id)).toEqual(['p-hook']);
  });

  it('takes the id of a prompt hook that arrives after the error was read', () => {
    const g = gate();
    g.turnEnds.noteLine('pty-1', '/t.jsonl', apiError('oauth_org_not_allowed', NOTICE));
    g.advance(1000);
    g.turnEnds.noteHookSignal('pty-1', 'agent.user_prompt_submit', TURN_OPENED_AT, 'p-late');
    g.advance(GRACE_MS);
    g.turnEnds.settle();
    expect(g.sent.map((s) => s.payload.prompt_id)).toEqual(['p-late']);
  });

  it('still closes the turn when a background subagent writes after the lead turn died', () => {
    const g = gate();
    g.turnEnds.noteLine('pty-1', '/t.jsonl', apiError('oauth_org_not_allowed', NOTICE));
    g.turnEnds.noteLine('pty-1', '/t.jsonl', reply.replace('"type":"assistant"', '"type":"assistant","isSidechain":true'));
    g.advance(GRACE_MS);
    g.turnEnds.settle();
    expect(g.sent.map((s) => s.ptyId)).toEqual(['pty-1']);
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

  it('hands over an error line that was still being written when the watch began', () => {
    const file = path.join(dir, 's.jsonl');
    const error = apiError('oauth_org_not_allowed', NOTICE);
    fs.writeFileSync(file, `${turnDuration}\n${error.slice(0, 40)}`);
    const binding: ResumeBinding = { agent: 'claude', sessionId: 's', cwd: dir, transcriptPath: file, ts: 0 };
    const lines: string[] = [];
    const watcher = new TranscriptActivityWatcher({
      listSessionIds: () => ['pty-1'],
      getBinding: () => binding,
      isAgentAlive: () => true,
      emit: () => undefined,
      onClaudeLine: (_id, _p, line) => { lines.push(line); },
      minGapMs: 0,
    });
    watcher.tick();
    expect(lines).toEqual([turnDuration]);
    fs.appendFileSync(file, `${error.slice(40)}\n`);
    watcher.tick();
    expect(lines).toEqual([turnDuration, error]);
  });

  it('hands over the tail of a transcript replaced at the same path', () => {
    const file = path.join(dir, 's.jsonl');
    fs.writeFileSync(file, `${turnDuration}\n`);
    const binding: ResumeBinding = { agent: 'claude', sessionId: 's', cwd: dir, transcriptPath: file, ts: 0 };
    const lines: string[] = [];
    const watcher = new TranscriptActivityWatcher({
      listSessionIds: () => ['pty-1'],
      getBinding: () => binding,
      isAgentAlive: () => true,
      emit: () => undefined,
      onClaudeLine: (_id, _p, line) => { lines.push(line); },
      minGapMs: 0,
    });
    watcher.tick();
    const error = apiError('oauth_org_not_allowed', NOTICE);
    const next = `${file}.next`;
    fs.writeFileSync(next, `${error}\n`);
    fs.renameSync(next, file);
    // In the same tick, so afterTick never settles on a file it has not read.
    watcher.tick();
    expect(lines).toEqual([turnDuration, error]);
  });

  it('drops a pending error when the watcher skips lines after it', () => {
    const file = path.join(dir, 's.jsonl');
    fs.writeFileSync(file, `${turnDuration}\n`);
    const binding: ResumeBinding = { agent: 'claude', sessionId: 's', cwd: dir, transcriptPath: file, ts: 0 };
    let watcher: TranscriptActivityWatcher | null = null;
    const g = gate({ isReader: (id, p) => watcher?.readsLines(id, p) === true });
    watcher = new TranscriptActivityWatcher({
      listSessionIds: () => ['pty-1'],
      getBinding: () => binding,
      isAgentAlive: () => true,
      emit: () => undefined,
      onClaudeLine: (id, p, line) => g.turnEnds.noteLine(id, p, line),
      onClaudeGap: (id) => g.turnEnds.noteGap(id),
      afterTick: () => g.turnEnds.settle(),
      minGapMs: 0,
    });
    watcher.tick();
    fs.appendFileSync(file, `${apiError('server_error', 'overloaded')}\n`);
    watcher.tick();
    // The turn goes on: a reply, then more than one tick can read.
    const blob = JSON.stringify({ type: 'system', subtype: 'blob', data: 'x'.repeat(300 * 1024) });
    fs.appendFileSync(file, `${reply}\n${blob}\n`);
    g.advance(GRACE_MS);
    watcher.tick();
    expect(g.sent).toEqual([]);

    // The same through a replacement whose replay window misses the reply.
    fs.appendFileSync(file, `${apiError('server_error', 'overloaded')}\n`);
    watcher.tick();
    const next = `${file}.next`;
    fs.writeFileSync(next, `${apiError('server_error', 'overloaded')}\n${reply}\n${JSON.stringify({ type: 'system', subtype: 'blob', data: 'y'.repeat(100 * 1024) })}\n`);
    fs.renameSync(next, file);
    g.advance(GRACE_MS);
    watcher.tick();
    expect(g.sent).toEqual([]);

    // And through a watch that lost the file for a tick and was created again.
    fs.appendFileSync(file, `${apiError('server_error', 'overloaded')}\n`);
    watcher.tick();
    fs.renameSync(file, next);
    watcher.tick();
    fs.appendFileSync(next, `${reply}\n${JSON.stringify({ type: 'system', subtype: 'blob', data: 'z'.repeat(100 * 1024) })}\n`);
    fs.renameSync(next, file);
    g.advance(GRACE_MS);
    watcher.tick();
    expect(g.sent).toEqual([]);
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

  it('closes only the pane that kept a shared transcript, not the one it was handed over from', () => {
    const file = path.join(dir, 's.jsonl');
    fs.writeFileSync(file, `${apiError('oauth_org_not_allowed', NOTICE)}\n${turnDuration}\n`);
    const binding: ResumeBinding = { agent: 'claude', sessionId: 's', cwd: dir, transcriptPath: file, ts: 0 };
    let watcher: TranscriptActivityWatcher | null = null;
    const g = gate({ isReader: (id, p) => watcher?.readsLines(id, p) === true });
    watcher = new TranscriptActivityWatcher({
      listSessionIds: () => ['pty-old', 'pty-new'],
      getBinding: () => binding,
      isAgentAlive: () => true,
      emit: () => undefined,
      onClaudeLine: (id, p, line) => g.turnEnds.noteLine(id, p, line),
      afterTick: () => g.turnEnds.settle(),
      minGapMs: 0,
    });
    // pty-old reads the error first; then pty-new's agent speaks and takes the file.
    watcher.noteHookSignal('pty-old', 'agent.session_start');
    watcher.tick();
    expect(watcher.watchedSessions()).toEqual(['pty-old']);
    g.advance(1);
    watcher.noteHookSignal('pty-new', 'agent.session_start');
    watcher.tick();
    expect(watcher.watchedSessions()).toEqual(['pty-new']);
    g.advance(GRACE_MS);
    watcher.tick();
    expect(g.sent.map((s) => s.ptyId)).toEqual(['pty-new']);
  });
});
