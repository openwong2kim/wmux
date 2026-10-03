import { describe, expect, it, vi } from 'vitest';
import { applyHarnessEvent } from '../../../shared/chatv2/apply';
import type { HarnessEvent, HarnessEventType } from '../../../shared/chatv2/harnessEvents';
import { newChatSession, type Session } from '../../../shared/chatv2/session';
import type { ChatV2Binding } from '../../../shared/chatv2/ipc';
import {
  ChatV2CancelReceipts,
  buildChatV2Object,
  chatV2Cancel,
  chatV2Page,
  chatV2SendResponse,
  projectChatV2Session,
  type ChatV2PhoneHost,
} from '../chatWire';

/** Fold events from a fresh session, stamping seq 1.. and at = 1000 + seq. */
function fold(events: HarnessEvent[], from: Session = newChatSession({ id: 'c1', harness: 'claude', cwd: '/w' })): Session {
  let session = from;
  let seq = from.blocks.length ? 100 : 0;
  for (const event of events) {
    seq += 1;
    session = applyHarnessEvent(session, { seq, at: 1000 + seq, event });
  }
  return session;
}

const user = (text = 'hi'): HarnessEvent => ({ type: 'user.message', text, clientMessageId: 'cm-00000001' });
const rows = (events: HarnessEvent[]) => projectChatV2Session(fold(events));

/**
 * One case per HarnessEvent type: fold it after an opening user turn and read
 * the phone rows it adds. Events that only change the session head add none.
 */
const cases: Record<HarnessEventType, { events: HarnessEvent[]; expected: unknown[] }> = {
  'session.started': { events: [{ type: 'session.started' }], expected: [] },
  'session.ended': {
    events: [{ type: 'session.ended', code: 1 }],
    expected: [{ id: '1.1:end', kind: 'meta', subtype: 'turn_aborted', label: 'The turn failed' }],
  },
  'session.error': {
    events: [{ type: 'session.error', message: 'Auth expired' }],
    expected: [{ id: '2.1', kind: 'meta', subtype: 'unknown', label: 'Auth expired' }],
  },
  'session.providerBound': { events: [{ type: 'session.providerBound', providerSessionId: 'p' }], expected: [] },
  'turn.started': { events: [{ type: 'turn.started', providerTurnId: 'pt' }], expected: [] },
  'session.configChanged': { events: [{ type: 'session.configChanged', model: 'opus' }], expected: [] },
  status: {
    events: [{ type: 'status', text: 'Compacting' }],
    expected: [{ id: '2.1', kind: 'meta', subtype: 'unknown', label: 'Compacting' }],
  },
  'usage.limited': { events: [{ type: 'usage.limited', resetsAt: 5 }], expected: [] },
  'background.updated': { events: [{ type: 'background.updated', tasks: ['build'] }], expected: [] },
  interjection: {
    events: [{ type: 'interjection', text: 'Hold on', customType: 'review' }],
    expected: [{ id: '2.1', kind: 'meta', subtype: 'unknown', label: 'Hold on' }],
  },
  'user.message': { events: [user('second')], expected: [{ id: '2.1', kind: 'user_text', text: 'second', ts: 1002 }] },
  'turn.ended': {
    events: [{ type: 'turn.ended', outcome: 'interrupted' }],
    expected: [{ id: '1.1:end', kind: 'meta', subtype: 'turn_aborted', label: 'Interrupted' }],
  },
  'message.delta': {
    events: [{ type: 'message.delta', text: 'Hello' }],
    expected: [{ id: '2.1', kind: 'assistant_text', text: 'Hello' }],
  },
  'message.completed': {
    events: [{ type: 'message.delta', text: 'Done.' }, { type: 'message.completed' }],
    expected: [{ id: '2.1', kind: 'assistant_text', text: 'Done.' }],
  },
  'image.generated': {
    events: [{ type: 'image.generated', itemId: 'i', path: '/tmp/a.png', name: 'a.png', mimeType: 'image/png', size: 3 }],
    expected: [{ id: '2.1', kind: 'meta', subtype: 'unknown', label: 'Image: a.png' }],
  },
  'reasoning.delta': {
    events: [{ type: 'reasoning.delta', text: 'thinking' }],
    expected: [{ id: '2.1', kind: 'assistant_text', text: 'thinking', thinking: true }],
  },
  'reasoning.completed': {
    events: [{ type: 'reasoning.delta', text: 'hmm' }, { type: 'reasoning.completed' }],
    expected: [{ id: '2.1', kind: 'assistant_text', text: 'hmm', thinking: true }],
  },
  'tool.started': {
    events: [{ type: 'tool.started', callId: 't1', title: 'Read', kind: 'read', preview: { kind: 'read', path: '/w/a.ts' } }],
    expected: [{ id: '2.1', kind: 'tool_use', toolUseId: 't1', name: expect.any(String), argSummary: '/w/a.ts' }],
  },
  'tool.updated': {
    events: [
      { type: 'tool.started', callId: 't1', title: 'Bash', kind: 'shell' },
      { type: 'tool.updated', callId: 't1', status: 'completed', detail: 'ls', preview: { kind: 'shell', output: 'a.ts' } },
    ],
    expected: [
      { id: '2.1', kind: 'tool_use', toolUseId: 't1', name: expect.any(String), argSummary: 'ls', input: { n: 1, bytes: 2, inline: 'ls' } },
      { id: '2.1:result', kind: 'tool_result', toolUseId: 't1', ok: true, bytes: 4, output: { n: 1, bytes: 4, inline: 'a.ts' } },
    ],
  },
  'agent.step': {
    events: [
      { type: 'tool.started', callId: 'a1', title: 'Agent', kind: 'agent' },
      { type: 'agent.step', callId: 'a1', stepId: 's1', kind: 'tool', text: 'Read a.ts', agentName: 'Reviewer' },
    ],
    expected: [
      { id: '2.1', kind: 'tool_use', toolUseId: 'a1', name: expect.any(String), argSummary: '' },
      { id: '2.1:agent', kind: 'meta', subtype: 'subagent', label: expect.stringMatching(/: 1 step$/) },
    ],
  },
  'approval.requested': {
    events: [
      { type: 'tool.started', callId: 't1', title: 'Write', kind: 'write' },
      { type: 'approval.requested', requestId: 'r1', title: 'Write', callId: 't1' },
    ],
    expected: [
      { id: '2.1', kind: 'tool_use', toolUseId: 't1', name: expect.any(String), argSummary: '' },
      { id: '2.1:approval', kind: 'meta', subtype: 'unknown', label: expect.stringMatching(/^Waiting for approval: /), ts: 1003 },
    ],
  },
  'approval.resolved': {
    events: [
      { type: 'approval.requested', requestId: 'r1', title: 'Write', kind: 'write' },
      { type: 'approval.resolved', requestId: 'r1', decision: 'deny' },
    ],
    expected: [
      { id: '2.1', kind: 'tool_use', toolUseId: '2.1', name: expect.any(String), argSummary: '' },
      { id: '2.1:approval', kind: 'meta', subtype: 'unknown', label: 'Denied', ts: 1002 },
    ],
  },
  'question.asked': {
    events: [{
      type: 'question.asked', requestId: 'q1',
      questions: [{ id: 'q', prompt: 'Which file?', multiSelect: false, allowCustom: true, options: [{ id: 'a', label: 'a.ts' }] }],
    }],
    expected: [{ id: 'question:q1', kind: 'meta', subtype: 'unknown', label: 'Question: Which file?', ts: 1002 }],
  },
  'question.updated': {
    events: [
      { type: 'question.asked', requestId: 'q1', title: 'Pick one', questions: [] },
      { type: 'question.updated', requestId: 'q1', autoResolveAt: 9 },
    ],
    expected: [{ id: 'question:q1', kind: 'meta', subtype: 'unknown', label: 'Question: Pick one', ts: 1002 }],
  },
  'question.resolved': {
    events: [
      { type: 'question.asked', requestId: 'q1', title: 'Pick one', questions: [] },
      { type: 'question.resolved', requestId: 'q1', decision: 'answered' },
    ],
    expected: [],
  },
  'tasks.updated': {
    events: [{ type: 'tasks.updated', items: [{ text: 'Write tests', status: 'completed' }, { text: 'Ship', status: 'in_progress' }] }],
    expected: [{ id: '2.1', kind: 'assistant_text', text: '- [x] Write tests\n- [ ] Ship (in progress)' }],
  },
  plan: {
    events: [{ type: 'plan', text: '1. Read\n2. Fix', streaming: false }],
    expected: [{ id: '2.1', kind: 'assistant_text', text: '1. Read\n2. Fix' }],
  },
  context: { events: [{ type: 'context', used: 10, window: 100 }], expected: [] },
  'turn.metrics': { events: [{ type: 'turn.metrics', inputTokens: 5 }], expected: [] },
};

describe('chat v2 → phone rows', () => {
  it.each(Object.entries(cases))('%s', (_type, { events, expected }) => {
    const all = rows([user(), ...events]);
    expect(all[0]).toMatchObject({ id: '1.1', kind: 'user_text', text: 'hi' });
    expect(all.slice(1)).toEqual(expected);
  });

  it('closes a completed turn without a row, and an aborted one with turn_aborted after its last row', () => {
    const done = rows([user(), { type: 'message.delta', text: 'a' }, { type: 'turn.ended', outcome: 'completed' }]);
    expect(done.map((r) => r.id)).toEqual(['1.1', '2.1']);
    const limited = rows([user(), { type: 'message.delta', text: 'a' }, { type: 'turn.ended', outcome: 'usage-limited' }, user('next')]);
    expect(limited.map((r) => r.id)).toEqual(['1.1', '2.1', '1.1:end', '4.1']);
  });

  it('keeps a tool body inline only up to 4 KiB and says when it was cut', () => {
    const big = 'x'.repeat(5000);
    const out = rows([user(), { type: 'tool.started', callId: 't', title: 'Bash', kind: 'shell' },
      { type: 'tool.updated', callId: 't', status: 'failed', detail: big }]);
    expect(out[1]).toMatchObject({ kind: 'tool_use', input: { bytes: 5000, truncated: true } });
    expect((out[1] as { input: { inline: string } }).input.inline.length).toBe(4096);
    expect(out[2]).toMatchObject({ kind: 'tool_result', ok: false, bytes: 0 });
  });

  it('pages the tail within the managed bounds', () => {
    let session = fold([user()]);
    for (let i = 0; i < 100; i++) session = applyHarnessEvent(session, { seq: 10 + i, at: 1, event: { type: 'status', text: `s${i}` } });
    const page = chatV2Page(session);
    expect(page.events).toHaveLength(80);
    expect(page.truncatedHead).toBe(true);
    expect(page.events.at(-1)).toMatchObject({ label: 's99' });
  });
});

const binding = (over: Partial<ChatV2Binding> = {}): ChatV2Binding => ({
  paneId: 's1', chatSessionId: 'c1', agent: 'claude', mode: 'default', model: '', status: 'running',
  providerSessionId: '0199f1c2-0000-4000-8000-000000000001', epoch: 'a'.repeat(16), seq: 3,
  capabilities: { send: true, interrupt: true, approvals: true, questions: true, images: true, toTerminal: true },
  ...over,
});

describe('chat v2 `chat` object (shipped phone compatibility)', () => {
  /** The keys today's managed object carries (buildChatObject, managed branch). */
  const MANAGED_KEYS = ['binding', 'agentSessionId', 'historyEpoch', 'historyTruncated', 'agentStatus', 'agentAlive', 'capabilities', 'managed'];
  const MANAGED_CAPS = ['history', 'send', 'permissions', 'cancel', 'fileUndo', 'launch', 'skills'];

  it('reads as a managed binding: read only, managed keys plus streaming:false', () => {
    const session = fold([user()]);
    const chat = buildChatV2Object(binding(), session, undefined);
    expect(Object.keys(chat).sort()).toEqual([...MANAGED_KEYS].sort());
    expect(Object.keys(chat.capabilities as object).sort()).toEqual([...MANAGED_CAPS, 'streaming'].sort());
    expect(chat).toMatchObject({
      binding: 'managed',
      agentSessionId: '0199f1c2-0000-4000-8000-000000000001',
      historyEpoch: `c2:c1:${'a'.repeat(16)}`,
      capabilities: { history: true, send: false, permissions: false, cancel: false, fileUndo: false, streaming: false, launch: false, skills: false },
      managed: { provider: { id: 'claude', name: 'Claude Code' }, phase: 'running' },
    });
  });

  it('shows cancel and the turn only to a chat-cancel caller while a turn runs', () => {
    const running = fold([user()]);
    expect(buildChatV2Object(binding(), running, undefined, { chatCancel: true })).toMatchObject({
      capabilities: { cancel: true }, turn: { id: '1.1', state: 'running', startedAt: 1001 },
    });
    const idle = fold([user(), { type: 'turn.ended', outcome: 'completed' }]);
    expect(buildChatV2Object(binding({ status: 'idle' }), idle, undefined, { chatCancel: true })).toMatchObject({
      capabilities: { cancel: false }, turn: { id: '1.1', state: 'idle' },
    });
  });

  it('carries a pending approval as blocked', () => {
    expect(buildChatV2Object(binding(), fold([user()]), { by: 'approval', approvalId: 'apr_1' }))
      .toMatchObject({ blocked: { by: 'approval', approvalId: 'apr_1' } });
  });

  it('refuses a send exactly as a managed record does', () => {
    expect(chatV2SendResponse('m-1')).toEqual({ status: 409, body: { error: 'managed-read-only', effect: 'none', clientMessageId: 'm-1' } });
  });
});

describe('chat v2 cancel', () => {
  const now = Date.now();
  const ccid = `${now}-6f1d2c3b-4a59-4e87-9b10-2c3d4e5f6a7b`;
  const host = (session: Session, result: unknown = { ok: true, interrupted: true }) => ({
    bindingForPane: () => binding({ status: session.busy ? 'running' : 'idle' }),
    sessionForPane: () => session,
    call: vi.fn(async () => result),
    onPush: () => () => undefined,
  }) as unknown as ChatV2PhoneHost & { call: ReturnType<typeof vi.fn> };
  const run = (h: ChatV2PhoneHost, receipts = new ChatV2CancelReceipts(), over: Record<string, string> = {}) => chatV2Cancel({
    owner: 'device:a', paneId: 's1', now, host: h, receipts, authorized: async () => true,
    body: { agentSessionId: '0199f1c2-0000-4000-8000-000000000001', clientCancelId: ccid, ...over },
  });

  it('interrupts the open turn once and replays a retry', async () => {
    const h = host(fold([user()]));
    const receipts = new ChatV2CancelReceipts();
    expect(await run(h, receipts)).toEqual({ clientCancelId: ccid, replayed: false, effect: 'interrupt-requested', turnId: '1.1' });
    expect(h.call).toHaveBeenCalledWith('interrupt', { paneId: 's1', chatSessionId: 'c1' }, 'web');
    expect(await run(h, receipts)).toMatchObject({ replayed: true, effect: 'interrupt-requested' });
    expect(h.call).toHaveBeenCalledTimes(1);
    expect(await run(h, receipts, { turnId: '1.1' })).toMatchObject({ error: 'cancel-id-conflict' });
  });

  it('refuses without writing when no turn runs or the conversation changed', async () => {
    const idle = host(fold([user(), { type: 'turn.ended', outcome: 'completed' }]));
    expect(await run(idle)).toMatchObject({ error: 'turn-not-running', effect: 'none', turn: { id: '1.1', state: 'idle' } });
    const busy = host(fold([user()]));
    expect(await run(busy, undefined, { agentSessionId: 'other' })).toMatchObject({ error: 'session-changed' });
    expect(await run(busy, undefined, { turnId: '9.1' })).toMatchObject({ error: 'turn-not-running' });
    expect(idle.call).not.toHaveBeenCalled();
    expect(busy.call).not.toHaveBeenCalled();
  });
});
