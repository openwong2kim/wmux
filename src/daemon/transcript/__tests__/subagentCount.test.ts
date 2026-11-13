import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ResumeBinding } from '../../../shared/agentResume';
import { ClaudeSubagentCounter, CodexSubagentCounter } from '../subagentCount';
import { READ_CAP_BYTES, TranscriptActivityWatcher } from '../TranscriptActivityWatcher';
import { SUBAGENT_COUNT_REFRESH_MS } from '../../../shared/subagentCount';

const ts = '2026-10-20T12:00:00.000Z';

// Codex multi_agent v2 shapes, as written to the parent rollout.
const codexCall = (name: string, callId: string) => JSON.stringify({
  timestamp: ts, type: 'response_item', payload: { type: 'function_call', name, call_id: callId, arguments: '{"target":"x","message":"m"}' },
});
const codexSub = (kind: string, id: string, thread: string) => JSON.stringify({
  timestamp: ts, type: 'event_msg', payload: {
    type: 'item_completed',
    item: { type: 'SubAgentActivity', model: 'm', reasoning_effort: 'low', id, kind, agent_thread_id: thread, agent_path: `/root/${thread}` },
  },
});

// Claude Code shapes.
const claudeToolUse = (id: string, name: string, input: unknown = {}) => JSON.stringify({
  type: 'assistant', timestamp: ts, message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] },
});
const claudeToolResult = (id: string, text: string) => JSON.stringify({
  type: 'user', timestamp: ts, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: [{ type: 'text', text }] }] },
});
const asyncLaunched = (agentId: string) => `Async agent launched successfully. (This tool result is internal metadata)\nagentId: ${agentId}`;
const notificationBody = (taskId: string, toolUseId: string) =>
  `<task-notification>\n<task-id>${taskId}</task-id>\n<tool-use-id>${toolUseId}</tool-use-id>\n<status>completed</status>\n<summary>done</summary>\n</task-notification>`;
const queueNotification = (taskId: string, toolUseId: string) => JSON.stringify({
  type: 'queue-operation', operation: 'enqueue', timestamp: ts, sessionId: 's', content: notificationBody(taskId, toolUseId),
});
const attachmentNotification = (taskId: string, toolUseId: string) => JSON.stringify({
  type: 'attachment', timestamp: ts, attachment: { type: 'queued_command', commandMode: 'task-notification', prompt: notificationBody(taskId, toolUseId) },
});
const userPrompt = (text: string) => JSON.stringify({ type: 'user', timestamp: ts, message: { role: 'user', content: text } });

describe('CodexSubagentCounter', () => {
  it('counts started agents until they complete, and a followup_task restarts one', () => {
    const c = new CodexSubagentCounter();
    c.noteLine(codexCall('spawn_agent', 'call-1'));
    c.noteLine(codexSub('started', 'call-1', 'thread-a'));
    expect(c.count).toBe(1);
    c.noteLine(codexCall('spawn_agent', 'call-2'));
    c.noteLine(codexSub('started', 'call-2', 'thread-b'));
    expect(c.count).toBe(2);
    c.noteLine(codexSub('completed', 'subagent-completed-1', 'thread-a'));
    expect(c.count).toBe(1);
    // A follow-up task gives the finished agent new work.
    c.noteLine(codexCall('followup_task', 'call-3'));
    c.noteLine(codexSub('interacted', 'call-3', 'thread-a'));
    expect(c.count).toBe(2);
    c.noteLine(codexSub('completed', 'subagent-completed-2', 'thread-a'));
    c.noteLine(codexSub('completed', 'subagent-completed-3', 'thread-b'));
    expect(c.count).toBe(0);
  });

  it('a send_message changes nothing: neither to a running agent nor to an idle one', () => {
    const c = new CodexSubagentCounter();
    c.noteLine(codexSub('started', 'call-1', 'thread-a'));
    c.noteLine(codexCall('send_message', 'call-2'));
    c.noteLine(codexSub('interacted', 'call-2', 'thread-a'));
    expect(c.count).toBe(1);
    c.noteLine(codexSub('completed', 'subagent-completed-1', 'thread-a'));
    expect(c.count).toBe(0);
    // A child reporting to its parent (or a message to an idle agent).
    c.noteLine(codexCall('send_message', 'call-3'));
    c.noteLine(codexSub('interacted', 'call-3', 'thread-root'));
    expect(c.count).toBe(0);
  });

  it('an interacted whose call was never seen changes nothing; an interrupt ends a run', () => {
    const c = new CodexSubagentCounter();
    c.noteLine(codexSub('interacted', 'unseen-call', 'thread-a'));
    expect(c.count).toBe(0);
    c.noteLine(codexSub('started', 'call-1', 'thread-a'));
    c.noteLine(codexSub('interrupted', 'call-2', 'thread-a'));
    expect(c.count).toBe(0);
  });

  it('an interrupt of the parent turn ends every child; a turn that completes does not', () => {
    const c = new CodexSubagentCounter();
    c.noteLine(codexSub('started', 'call-1', 'thread-a'));
    c.noteLine(codexSub('started', 'call-2', 'thread-b'));
    c.noteLine(JSON.stringify({ timestamp: ts, type: 'event_msg', payload: { type: 'task_complete', turn_id: 't1' } }));
    expect(c.count).toBe(2);
    c.noteLine(JSON.stringify({ timestamp: ts, type: 'event_msg', payload: { type: 'turn_aborted', turn_id: 't2', reason: 'interrupted' } }));
    expect(c.count).toBe(0);
  });

  it('a duplicate start counts one agent, and reset forgets everything', () => {
    const c = new CodexSubagentCounter();
    c.noteLine(codexSub('started', 'call-1', 'thread-a'));
    c.noteLine(codexSub('started', 'call-1', 'thread-a'));
    expect(c.count).toBe(1);
    c.reset();
    expect(c.count).toBe(0);
    c.noteLine('not json SubAgentActivity');
    expect(c.count).toBe(0);
  });
});

describe('ClaudeSubagentCounter', () => {
  it('a subagent\'s own records in the lead\'s transcript change nothing', () => {
    const c = new ClaudeSubagentCounter();
    c.noteLine(claudeToolUse('toolu_1', 'Agent'));
    expect(c.count).toBe(1);
    const side = (line: string) => JSON.stringify({ ...JSON.parse(line), isSidechain: true });
    c.noteLine(side(userPrompt('the subagent\'s task')));
    expect(c.count).toBe(1);
    c.noteLine(side(claudeToolUse('toolu_9', 'Agent')));
    expect(c.count).toBe(1);
  });

  it('an async agent counts from its launch until its task-notification', () => {
    const c = new ClaudeSubagentCounter();
    c.noteLine(claudeToolUse('toolu_1', 'Agent', { prompt: 'p', run_in_background: true }));
    c.noteLine(claudeToolResult('toolu_1', asyncLaunched('a111')));
    expect(c.count).toBe(1);
    c.noteLine(queueNotification('a111', 'toolu_1'));
    expect(c.count).toBe(0);
  });

  it('the queued_command shape settles it too, by agent id alone', () => {
    const c = new ClaudeSubagentCounter();
    c.noteLine(claudeToolUse('toolu_1', 'Agent'));
    c.noteLine(claudeToolResult('toolu_1', asyncLaunched('a111')));
    c.noteLine(attachmentNotification('a111', 'other-id'));
    expect(c.count).toBe(0);
  });

  it('the user record that delivers a notification settles it', () => {
    const c = new ClaudeSubagentCounter();
    c.noteLine(claudeToolUse('toolu_1', 'Agent'));
    c.noteLine(claudeToolResult('toolu_1', asyncLaunched('a111')));
    c.noteLine(JSON.stringify({ type: 'user', isMeta: true, origin: { kind: 'task-notification' }, timestamp: ts, message: { role: 'user', content: notificationBody('a111', 'toolu_1') } }));
    expect(c.count).toBe(0);
  });

  it('a request blob that copies an earlier launch does not revive it', () => {
    const c = new ClaudeSubagentCounter();
    c.noteLine(claudeToolUse('toolu_1', 'Agent'));
    c.noteLine(claudeToolResult('toolu_1', asyncLaunched('a111')));
    c.noteLine(queueNotification('a111', 'toolu_1'));
    const copied = [JSON.parse(claudeToolUse('toolu_1', 'Agent')).message, JSON.parse(claudeToolResult('toolu_1', asyncLaunched('a111'))).message];
    c.noteLine(JSON.stringify({ type: 'api-request-blob', message: { content: copied.flatMap((m) => m.content) }, messages: copied }));
    expect(c.count).toBe(0);
  });

  it('a TaskStop naming the agent settles it', () => {
    const c = new ClaudeSubagentCounter();
    c.noteLine(claudeToolUse('toolu_1', 'Task'));
    c.noteLine(claudeToolResult('toolu_1', asyncLaunched('a111')));
    c.noteLine(claudeToolUse('toolu_2', 'Agent'));
    c.noteLine(claudeToolResult('toolu_2', asyncLaunched('a222')));
    expect(c.count).toBe(2);
    c.noteLine(claudeToolUse('toolu_3', 'TaskStop', { task_id: 'a111' }));
    expect(c.count).toBe(1);
  });

  it('a background shell or a Monitor is not a subagent', () => {
    const c = new ClaudeSubagentCounter();
    c.noteLine(claudeToolUse('toolu_1', 'Bash', { command: 'npm run dev', run_in_background: true }));
    c.noteLine(claudeToolResult('toolu_1', 'Command running in background with ID: b123'));
    c.noteLine(claudeToolUse('toolu_2', 'Monitor', {}));
    c.noteLine(claudeToolResult('toolu_2', 'Monitor started (task m456)'));
    expect(c.count).toBe(0);
  });

  it('a foreground Agent call counts until its result, or until the user types a new prompt', () => {
    const c = new ClaudeSubagentCounter();
    c.noteLine(claudeToolUse('toolu_1', 'Agent'));
    expect(c.count).toBe(1);
    c.noteLine(claudeToolResult('toolu_1', 'The report.'));
    expect(c.count).toBe(0);
    c.noteLine(claudeToolUse('toolu_2', 'Agent'));
    c.noteLine(userPrompt('never mind'));
    expect(c.count).toBe(0);
  });

  it('a result that only quotes a launch started nothing', () => {
    const c = new ClaudeSubagentCounter();
    c.noteLine(claudeToolUse('toolu_1', 'Agent'));
    c.noteLine(claudeToolResult('toolu_1', `The log says: ${asyncLaunched('a111')}`));
    expect(c.count).toBe(0);
  });
});

describe('ClaudeSubagentCounter — background work (what a turn leaves running)', () => {
  const userNotification = (body: string) => JSON.stringify({ type: 'user', timestamp: ts, origin: { kind: 'task-notification' }, message: { role: 'user', content: body } });
  const event = (taskId: string, toolUseId: string) =>
    `<task-notification>\n<task-id>${taskId}</task-id>\n<tool-use-id>${toolUseId}</tool-use-id>\n<summary>Monitor event: "x"</summary>\n<event>line</event>\n</task-notification>`;

  it('a background shell and a Monitor run until a notification with a status is handed to the agent; `count` never moves', () => {
    const c = new ClaudeSubagentCounter();
    c.noteLine(claudeToolUse('toolu_1', 'Bash', { command: 'sleep 20', run_in_background: true }));
    c.noteLine(claudeToolResult('toolu_1', 'Command running in background with ID: b123. Output is being written to: /tmp/x'));
    c.noteLine(claudeToolUse('toolu_2', 'Monitor', {}));
    c.noteLine(claudeToolResult('toolu_2', 'Monitor started (task m456, expires in 15m unless the source ends first)'));
    expect(c.background).toBe(2);
    // Queued only: not the agent's yet.
    c.noteLine(queueNotification('b123', 'toolu_1'));
    expect(c.background).toBe(2);
    c.noteLine(userNotification(notificationBody('b123', 'toolu_1')));
    expect(c.background).toBe(1);
    // A Monitor's event (no status) is not its end; its last one is.
    c.noteLine(userNotification(event('m456', 'toolu_2')));
    expect(c.background).toBe(1);
    c.noteLine(attachmentNotification('m456', 'toolu_2'));
    expect(c.background).toBe(0);
    expect(c.count).toBe(0);
  });

  it('a TaskStop / KillShell naming it ends it; a turn end and a new prompt do not', () => {
    const c = new ClaudeSubagentCounter();
    c.noteLine(claudeToolUse('toolu_1', 'Bash', { command: 'npm run dev', run_in_background: true }));
    c.noteLine(claudeToolResult('toolu_1', 'Command running in background with ID: b123'));
    c.noteLine(JSON.stringify({ type: 'assistant', timestamp: ts, message: { role: 'assistant', content: [{ type: 'text', text: 'started' }], stop_reason: 'end_turn' } }));
    c.noteLine(userPrompt('and now?'));
    expect(c.background).toBe(1);
    c.noteLine(claudeToolUse('toolu_2', 'KillShell', { shell_id: 'b123' }));
    expect(c.background).toBe(0);
  });

  it('a foreground command, a result that only quotes a start, and a call cut off by a new prompt start nothing', () => {
    const c = new ClaudeSubagentCounter();
    c.noteLine(claudeToolUse('toolu_1', 'Bash', { command: 'ls' }));
    c.noteLine(claudeToolResult('toolu_1', 'a.txt'));
    c.noteLine(claudeToolUse('toolu_2', 'Bash', { command: 'cat log' }));
    c.noteLine(claudeToolResult('toolu_2', 'The log says: Command running in background with ID: b9'));
    c.noteLine(claudeToolUse('toolu_3', 'Bash', { command: 'sleep 9', run_in_background: true }));
    c.noteLine(userPrompt('stop'));
    c.noteLine(claudeToolResult('toolu_3', 'Command running in background with ID: b10'));
    expect(c.background).toBe(0);
  });

  it('an async agent is background work too, until its end is handed to the agent; its subagent count is as before', () => {
    const c = new ClaudeSubagentCounter();
    c.noteLine(claudeToolUse('toolu_1', 'Agent'));
    c.noteLine(claudeToolResult('toolu_1', asyncLaunched('a111')));
    expect([c.count, c.background]).toEqual([1, 1]);
    // Queued while the lead's turn runs: no subagent runs any more, but the lead has not heard it.
    c.noteLine(queueNotification('a111', 'toolu_1'));
    expect([c.count, c.background]).toEqual([0, 1]);
    c.noteLine(userNotification(notificationBody('a111', 'toolu_1')));
    expect([c.count, c.background]).toEqual([0, 0]);
    // A TaskStop of one ends it for both.
    c.noteLine(claudeToolUse('toolu_2', 'Agent'));
    c.noteLine(claudeToolResult('toolu_2', asyncLaunched('a222')));
    c.noteLine(claudeToolUse('toolu_3', 'TaskStop', { task_id: 'a222' }));
    expect([c.count, c.background]).toEqual([0, 0]);
  });
});

describe('TranscriptActivityWatcher — subagent count', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tx-subagents-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  function harness(agent: 'claude' | 'codex') {
    const file = path.join(dir, `${agent}.jsonl`);
    fs.writeFileSync(file, `${JSON.stringify({ type: 'summary', summary: 'old' })}\n`);
    const state = { alive: true as boolean | undefined, now: 1_000_000 };
    const counts: Array<[string, number]> = [];
    const binding: ResumeBinding = { agent, sessionId: 's', cwd: dir, transcriptPath: file, ts: 0 };
    const watcher = new TranscriptActivityWatcher({
      listSessionIds: () => ['pty-1'],
      getBinding: () => binding,
      isAgentAlive: () => state.alive,
      emit: () => { /* the activity line is not under test here */ },
      emitSubagents: (id, count) => counts.push([id, count]),
      minGapMs: 0,
      now: () => state.now,
    });
    const append = (...lines: string[]) => fs.appendFileSync(file, lines.map((l) => `${l}\n`).join(''));
    return { file, watcher, counts, state, append };
  }

  it('sends the count on change only, and 0 when the agent dies', () => {
    const h = harness('codex');
    h.watcher.tick();
    h.append(codexSub('started', 'c1', 'thread-a'), codexSub('started', 'c2', 'thread-b'));
    h.watcher.tick();
    h.watcher.tick();
    expect(h.counts).toEqual([['pty-1', 2]]);
    h.append(codexSub('completed', 'subagent-completed-1', 'thread-a'));
    h.watcher.tick();
    expect(h.counts.at(-1)).toEqual(['pty-1', 1]);
    h.state.alive = false;
    h.watcher.tick();
    expect(h.counts.at(-1)).toEqual(['pty-1', 0]);
  });

  it('does not count what was written before the watch started', () => {
    const h = harness('codex');
    h.append(codexSub('started', 'c1', 'thread-a'));
    h.watcher.tick();
    h.watcher.tick();
    expect(h.counts).toEqual([]);
  });

  it('a hook-fed pane still sends its count, and a session start resets it', () => {
    const h = harness('claude');
    h.watcher.tick();
    h.watcher.noteHookSignal('pty-1', 'agent.activity');
    h.append(claudeToolUse('toolu_1', 'Agent'), claudeToolResult('toolu_1', asyncLaunched('a111')));
    h.watcher.tick();
    expect(h.counts).toEqual([['pty-1', 1]]);
    h.watcher.noteHookSignal('pty-1', 'agent.session_start');
    expect(h.counts.at(-1)).toEqual(['pty-1', 0]);
  });

  it('re-sends a count that is not 0 while it stands, so a client that missed it gets it back', () => {
    const h = harness('codex');
    h.watcher.tick();
    h.append(codexSub('started', 'c1', 'thread-a'));
    h.watcher.tick();
    h.state.now += SUBAGENT_COUNT_REFRESH_MS - 1;
    h.watcher.tick();
    expect(h.counts).toEqual([['pty-1', 1]]);
    h.state.now += 1;
    h.watcher.tick();
    expect(h.counts).toEqual([['pty-1', 1], ['pty-1', 1]]);
    h.append(codexSub('completed', 'x', 'thread-a'));
    h.watcher.tick();
    h.state.now += SUBAGENT_COUNT_REFRESH_MS * 3;
    h.watcher.tick();
    expect(h.counts.at(-1)).toEqual(['pty-1', 0]);
    expect(h.counts).toHaveLength(3);
  });

  it('a large tool output between two reads keeps a subagent that still runs', () => {
    const h = harness('claude');
    h.watcher.tick();
    h.append(claudeToolUse('toolu_1', 'Agent'), claudeToolResult('toolu_1', asyncLaunched('a111')));
    h.watcher.tick();
    expect(h.counts).toEqual([['pty-1', 1]]);
    h.append(claudeToolUse('toolu_2', 'Read'), claudeToolResult('toolu_2', 'x'.repeat(READ_CAP_BYTES + 50_000)));
    h.watcher.tick();
    expect(h.counts).toEqual([['pty-1', 1]]);
  });

  it('an end written just before a large tool output is still read', () => {
    const h = harness('claude');
    h.watcher.tick();
    h.append(claudeToolUse('toolu_1', 'Agent'), claudeToolResult('toolu_1', asyncLaunched('a111')));
    h.watcher.tick();
    h.append(queueNotification('a111', 'toolu_1'), claudeToolUse('toolu_2', 'Read'), claudeToolResult('toolu_2', 'x'.repeat(READ_CAP_BYTES + 50_000)));
    h.watcher.tick();
    expect(h.counts.at(-1)).toEqual(['pty-1', 0]);
  });

  it('a large record still being written does not lose the count', () => {
    const h = harness('claude');
    h.watcher.tick();
    h.append(claudeToolUse('toolu_1', 'Agent'), claudeToolResult('toolu_1', asyncLaunched('a111')));
    h.watcher.tick();
    // The writer pauses inside a record bigger than the read cap.
    const big = claudeToolResult('toolu_2', 'x'.repeat(READ_CAP_BYTES + 50_000));
    fs.appendFileSync(h.file, big.slice(0, READ_CAP_BYTES + 20_000));
    h.watcher.tick();
    h.watcher.tick();
    fs.appendFileSync(h.file, `${big.slice(READ_CAP_BYTES + 20_000)}\n`);
    h.watcher.tick();
    expect(h.counts).toEqual([['pty-1', 1]]);
  });

  it('a record too big to find its end makes the counter start afresh past it, not stick on it', () => {
    const h = harness('claude');
    h.watcher.tick();
    h.append(claudeToolUse('toolu_1', 'Agent'), claudeToolResult('toolu_1', asyncLaunched('a111')));
    h.watcher.tick();
    h.append(claudeToolResult('toolu_2', 'x'.repeat(9 * 1024 * 1024)));
    h.watcher.tick();
    expect(h.counts.at(-1)).toEqual(['pty-1', 0]);
    // The cursor moved past it: what follows is read.
    h.append(claudeToolUse('toolu_3', 'Agent'));
    h.watcher.tick();
    expect(h.counts.at(-1)).toEqual(['pty-1', 1]);
  });

  it('a large record still being written is not read again until the file grows', () => {
    const h = harness('claude');
    h.watcher.tick();
    h.append(claudeToolUse('toolu_1', 'Agent'));
    h.watcher.tick();
    const big = claudeToolResult('toolu_2', 'x'.repeat(1024 * 1024));
    fs.appendFileSync(h.file, big.slice(0, 900 * 1024));
    h.watcher.tick();
    const reads = vi.spyOn(fs, 'readSync');
    try {
      h.watcher.tick();
      h.watcher.tick();
      // Only the per-tick line-boundary probe, never the record again.
      const bytes = reads.mock.calls.reduce((sum, call) => sum + Number((call as unknown[])[3] ?? 0), 0);
      expect(bytes).toBeLessThan(1024);
    } finally {
      reads.mockRestore();
    }
    fs.appendFileSync(h.file, `${big.slice(900 * 1024)}\n`);
    h.append(claudeToolResult('toolu_1', 'done'));
    h.watcher.tick();
    expect(h.counts.at(-1)).toEqual(['pty-1', 0]);
  });

  it('a short partial record after a large skip is not read again either', () => {
    const h = harness('claude');
    h.watcher.tick();
    h.append(claudeToolUse('toolu_1', 'Agent'));
    h.watcher.tick();
    h.append(claudeToolUse('toolu_2', 'Read'), claudeToolResult('toolu_2', 'x'.repeat(READ_CAP_BYTES + 10_000)));
    fs.appendFileSync(h.file, claudeToolResult('toolu_3', 'y'.repeat(100 * 1024)).slice(0, 100 * 1024));
    h.watcher.tick();
    const reads = vi.spyOn(fs, 'readSync');
    try {
      h.watcher.tick();
      const bytes = reads.mock.calls.reduce((sum, call) => sum + Number((call as unknown[])[3] ?? 0), 0);
      expect(bytes).toBeLessThan(1024);
    } finally {
      reads.mockRestore();
    }
    expect(h.counts).toEqual([['pty-1', 1]]);
  });

  it('a closed pane sends 0 for a count it had sent', () => {
    const h = harness('claude');
    h.watcher.tick();
    h.append(claudeToolUse('toolu_1', 'Agent'));
    h.watcher.tick();
    expect(h.counts).toEqual([['pty-1', 1]]);
    h.watcher.dropSession('pty-1');
    expect(h.counts.at(-1)).toEqual(['pty-1', 0]);
  });
});
