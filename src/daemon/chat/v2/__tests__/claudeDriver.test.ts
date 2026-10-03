import { describe, expect, it } from 'vitest';
import type { HarnessEvent } from '../../../../shared/chatv2/harnessEvents';
import { ClaudeDriver } from '../claude/claudeDriver';
import type { ChatV2DriverDecision, ChatV2DriverSink, ChatV2DriverStart } from '../types';
import { FakeClaude, tick, until } from './fakeClaude';

const SESSION_ID = '0f1e2d3c-4b5a-4968-8776-655443322110';

function setup(spec: Partial<ChatV2DriverStart> = {}) {
  const fake = new FakeClaude();
  const driver = new ClaudeDriver({ settingSources: 'project', backend: fake.backend(), readImage: async () => Buffer.from('img') });
  const events: HarnessEvent[] = [];
  const decisions: ChatV2DriverDecision[] = [];
  const gone: string[] = [];
  const exits: Array<{ code: number | null }> = [];
  const sink: ChatV2DriverSink = {
    event: (e) => events.push(e),
    decision: (d) => decisions.push(d),
    decisionGone: (id) => gone.push(id),
    exited: (info) => exits.push(info),
  };
  const start = () => driver.start({
    cwd: '/tmp/x',
    env: { PATH: '/usr/bin', WMUX_GATE: '0' },
    mode: 'default',
    model: 'haiku',
    providerSession: { id: SESSION_ID, mode: 'new' },
    ...spec,
  }, sink);
  return { fake, driver, events, decisions, gone, exits, start };
}

describe('ClaudeDriver', () => {
  it('spawns claude -p stream-json with the stdio permission tool and one --model argument', async () => {
    const t = setup();
    await t.start();
    expect(t.fake.args).toEqual(expect.arrayContaining(['-p', '--input-format', 'stream-json', '--permission-prompt-tool', 'stdio', '--setting-sources=project', '--model=haiku']));
    expect(t.fake.args.join(' ')).toContain(`--permission-mode default --session-id ${SESSION_ID}`);
    expect(t.events.map((e) => e.type)).toEqual(['session.providerBound', 'session.started']);
    await t.driver.stop();
  });

  it('resumes and runs bypass with the skip-permissions pair', async () => {
    const t = setup({ mode: 'bypass', model: '', providerSession: { id: SESSION_ID, mode: 'resume' } });
    await t.start();
    expect(t.fake.args.join(' ')).toContain(`--permission-mode bypassPermissions --allow-dangerously-skip-permissions --resume ${SESSION_ID}`);
    expect(t.fake.args.some((a) => a.startsWith('--model'))).toBe(false);
    await t.driver.stop();
  });

  it('rejects start when the handshake never comes back', async () => {
    const t = setup();
    t.fake.handshake = false;
    const started = t.start();
    await tick(20);
    t.fake.exit(1, null);
    await expect(started).rejects.toThrow(/startup/);
    expect(t.exits).toHaveLength(1);
    expect(t.events.some((e) => e.type === 'session.ended')).toBe(false);
  });

  it('raises exactly one decision and one approval.requested per can_use_tool', async () => {
    const t = setup();
    await t.start();
    await t.driver.send({ text: 'hi', attachments: [] });
    t.fake.toolUse('toolu_1', 'Write', { file_path: '/tmp/x/a.txt', content: 'a' });
    t.fake.canUseTool('req-1', 'Write', { file_path: '/tmp/x/a.txt', content: 'a' }, 'toolu_1');
    // Claude can resend a request it is still waiting on.
    t.fake.canUseTool('req-1', 'Write', { file_path: '/tmp/x/a.txt', content: 'a' }, 'toolu_1');
    await until(() => t.decisions.length > 0);
    await tick(20);
    expect(t.decisions).toEqual([expect.objectContaining({ kind: 'permission', requestId: 'req-1', toolName: 'Write', question: 'Allow Write?' })]);
    expect(t.events.filter((e) => e.type === 'approval.requested')).toEqual([
      expect.objectContaining({ requestId: 'req-1', callId: 'toolu_1' }),
    ]);
    await t.driver.stop();
  });

  it('writes one control_response per request id, whatever answers it', async () => {
    const t = setup();
    await t.start();
    await t.driver.send({ text: 'hi', attachments: [] });
    t.fake.canUseTool('req-2', 'Bash', { command: 'ls' }, 'toolu_2');
    await until(() => t.decisions.length === 1);
    const [first, second] = await Promise.all([
      t.driver.answer('req-2', { decision: 'approve', formKind: 'permission' }),
      t.driver.answer('req-2', { decision: 'deny', formKind: 'permission' }),
    ]);
    expect([first, second]).toEqual(['ok', 'not-found']);
    await tick(10);
    expect(t.fake.responses('req-2')).toEqual([{ behavior: 'allow', updatedInput: { command: 'ls' } }]);
    await t.driver.stop();
  });

  it('keys AskUserQuestion q0/1… and answers with the chosen labels', async () => {
    const t = setup();
    await t.start();
    await t.driver.send({ text: 'hi', attachments: [] });
    const input = { questions: [{ question: 'Which color?', header: 'Color', multiSelect: false, options: [{ label: 'Red' }, { label: 'Blue' }] }] };
    t.fake.canUseTool('req-q', 'AskUserQuestion', input, 'toolu_q');
    await until(() => t.decisions.length === 1);
    const decision = t.decisions[0];
    expect(decision).toMatchObject({ kind: 'questions', questions: [{ id: 'q0', options: [{ key: '1', label: 'Red' }, { key: '2', label: 'Blue' }], allowOther: true }] });
    expect(t.events.find((e) => e.type === 'question.asked')).toMatchObject({ requestId: 'req-q', callId: 'toolu_q' });
    await expect(t.driver.answer('req-q', { decision: 'approve', formKind: 'questions', answers: [{ keys: ['2'] }] })).resolves.toBe('ok');
    await tick(10);
    expect(t.fake.responses('req-q')).toEqual([{ behavior: 'allow', updatedInput: { questions: input.questions, answers: { 'Which color?': 'Blue' } } }]);
    await t.driver.stop();
  });

  it('reports a request Claude cancelled as gone', async () => {
    const t = setup();
    await t.start();
    await t.driver.send({ text: 'hi', attachments: [] });
    t.fake.canUseTool('req-3', 'Bash', { command: 'ls' });
    await until(() => t.decisions.length === 1);
    t.fake.out({ type: 'control_cancel_request', request_id: 'req-3' });
    await until(() => t.gone.length === 1);
    await expect(t.driver.answer('req-3', { decision: 'approve', formKind: 'permission' })).resolves.toBe('not-found');
    await t.driver.stop();
  });

  it('ends a turn on its result, and an interrupted one as interrupted', async () => {
    const t = setup();
    await t.start();
    await t.driver.send({ text: 'hi', attachments: [] });
    t.fake.out({ type: 'stream_event', session_id: 's', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello' } } });
    t.fake.result();
    await until(() => t.events.some((e) => e.type === 'turn.ended'));
    expect(t.events.filter((e) => e.type === 'turn.ended')).toEqual([{ type: 'turn.ended', outcome: 'completed' }]);
    expect(t.events).toContainEqual({ type: 'message.delta', text: 'Hello' });

    await t.driver.send({ text: 'again', attachments: [] });
    await expect(t.driver.interrupt()).resolves.toBe(true);
    await tick(10);
    expect(t.fake.stdin.some((l) => l.type === 'control_request' && (l.request as { subtype?: string }).subtype === 'interrupt')).toBe(true);
    t.fake.result('error_during_execution', { is_error: true, terminal_reason: 'aborted_streaming' });
    await until(() => t.events.filter((e) => e.type === 'turn.ended').length === 2);
    expect(t.events.filter((e) => e.type === 'turn.ended')[1]).toEqual({ type: 'turn.ended', outcome: 'interrupted' });
    await t.driver.stop();
  });

  it('drops a pending request with the turn and reports the exit once, after session.ended', async () => {
    const t = setup();
    await t.start();
    await t.driver.send({ text: 'hi', attachments: [] });
    t.fake.canUseTool('req-4', 'Bash', { command: 'ls' });
    await until(() => t.decisions.length === 1);
    t.fake.exit(1, null);
    await until(() => t.exits.length === 1);
    expect(t.events[t.events.length - 1]).toEqual({ type: 'session.ended', code: 1 });
    expect(t.events.some((e) => e.type === 'turn.ended')).toBe(false);
    await expect(t.driver.answer('req-4', { decision: 'approve', formKind: 'permission' })).resolves.toBe('not-found');
  });

  it('denies at once a request id the answer RPC could not name', async () => {
    const t = setup();
    await t.start();
    await t.driver.send({ text: 'hi', attachments: [] });
    t.fake.canUseTool('bad id/with space', 'Bash', { command: 'ls' });
    await until(() => t.fake.responses('bad id/with space').length === 1);
    expect(t.fake.responses('bad id/with space')[0]).toMatchObject({ behavior: 'deny' });
    expect(t.decisions).toHaveLength(0);
    await t.driver.stop();
  });
});
