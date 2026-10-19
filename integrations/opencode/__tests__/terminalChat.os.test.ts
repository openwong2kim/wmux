import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
// A standalone JS plugin runs in OpenCode's Bun, without wmux's TS runtime.
// @ts-expect-error Standalone integration asset intentionally has no TS runtime dependency.
import { terminalChatHandler, projectTuiMessages, tui } from '../plugins/wmux-chat-tui.mjs';
function fixture() {
  const promptAsync = vi.fn(async () => ({}));
  const abort = vi.fn(async () => true);
  const api = { route: { current: { name: 'session', params: { sessionID: 'ses_one' } } },
    ui: { dialog: { open: false } }, client: { session: { promptAsync, abort } as { promptAsync: typeof promptAsync; abort?: typeof abort } },
    state: { ready: true, session: { get: (id: string) => ({ id }), status: () => ({ type: 'idle' }), permission: () => [], question: () => [],
      messages: () => [{ id: 'msg_one', sessionID: 'ses_one', role: 'user' }] },
      part: () => [{ id: 'part_one', sessionID: 'ses_one', messageID: 'msg_one', type: 'text', text: 'hello' }] } };
  return { api, promptAsync, abort, handler: terminalChatHandler(api, 'epoch') };
}
afterEach(() => { vi.useRealTimers(); });
describe('OpenCode existing TUI bridge', () => {
  it('projects only the selected session and refuses injected or other-session parts', () => {
    const f = fixture(); expect(projectTuiMessages(f.api, 'ses_one').events).toMatchObject([{ kind: 'user_text', text: 'hello' }]);
    expect(projectTuiMessages(f.api, 'ses_two').events).toEqual([]);
    f.api.state.part = () => [{ id: 'part_one', sessionID: 'ses_one', messageID: 'msg_one', type: 'text', text: 'context', synthetic: true }];
    expect(projectTuiMessages(f.api, 'ses_one').events).toEqual([]);
  });
  it('sends through the existing TUI client exactly once, with native selection and epoch guards', async () => {
    const f = fixture(); const read = await f.handler({ action: 'read' });
    const request = { action: 'send', sessionId: 'ses_one', epoch: read.epoch, text: 'next', requestId: 'request-1234567890' };
    expect(await f.handler(request)).toEqual({ result: 'sent' });
    expect(await f.handler(request)).toEqual({ result: 'sent' });
    expect(f.promptAsync).toHaveBeenCalledTimes(1);
    expect(f.promptAsync).toHaveBeenCalledWith({ sessionID: 'ses_one', parts: [{ type: 'text', text: 'next' }] }, { throwOnError: true });
    f.api.route.current.params.sessionID = 'ses_two';
    expect(await f.handler(request)).toEqual({ result: 'session_changed' });
    f.api.route.current.params.sessionID = 'ses_one';
    expect(await f.handler(request)).toEqual({ result: 'session_changed' });
    expect(f.promptAsync).toHaveBeenCalledTimes(1);
  });
  it('blocks dialogs and uncertain dispatch without guessing permission or retrying', async () => {
    const f = fixture(); const read = await f.handler({ action: 'read' });
    const request = { action: 'send', sessionId: 'ses_one', epoch: read.epoch, text: 'next', requestId: 'request-1234567890' };
    f.api.ui.dialog.open = true;
    expect(await f.handler(request)).toEqual({ result: 'blocked' });
    expect(f.promptAsync).not.toHaveBeenCalled();
    f.api.ui.dialog.open = false;
    f.promptAsync.mockRejectedValue(new Error('connection lost'));
    expect(await f.handler(request)).toEqual({ result: 'unconfirmed' });
    expect(await f.handler(request)).toEqual({ result: 'unconfirmed' });
    expect(f.promptAsync).toHaveBeenCalledTimes(1);
  });
  it('fences concurrent and accepted sends until native completion is observed', async () => {
    const f = fixture(); const read = await f.handler({ action: 'read' });
    let finish!: () => void;
    f.promptAsync.mockImplementation(() => new Promise(resolve => { finish = () => resolve({}); }));
    const request = { action: 'send', sessionId: 'ses_one', epoch: read.epoch, text: 'next', requestId: 'request-1234567890' };
    const first = f.handler(request);
    const second = { ...request, requestId: 'request-9876543210' };
    expect(await f.handler(second)).toEqual({ result: 'busy' });
    finish(); expect(await first).toEqual({ result: 'sent' });
    expect(await f.handler(second)).toEqual({ result: 'busy' });
    f.api.state.session.status = () => ({ type: 'busy' });
    expect((await f.handler({ action: 'read' })).phase).toBe('running');
    f.api.state.session.status = () => ({ type: 'idle' });
    expect((await f.handler({ action: 'read' })).phase).toBe('complete');
    expect(f.promptAsync).toHaveBeenCalledTimes(1);
  });
  it('refuses distinctly when 512 young receipts are held and prunes only expired ones', async () => {
    vi.useFakeTimers(); vi.setSystemTime(1_760_000_000_000);
    const f = fixture();
    // A completed assistant message releases the admission fence after each send.
    const messages: unknown[] = [];
    f.api.state.session.messages = () => messages as never;
    const send = async (n: number) => {
      const read = await f.handler({ action: 'read' });
      const result = await f.handler({ action: 'send', sessionId: 'ses_one', epoch: read.epoch, text: `m${n}`, requestId: `request-${String(n).padStart(12, '0')}` });
      messages.push({ id: `done_${n}`, sessionID: 'ses_one', role: 'assistant', time: { completed: 1 } });
      return result;
    };
    for (let n = 0; n < 256; n++) expect(await send(n)).toEqual({ result: 'sent' });
    vi.setSystemTime(1_760_000_000_000 + 60 * 60 * 1000);
    for (let n = 256; n < 512; n++) expect(await send(n)).toEqual({ result: 'sent' });
    expect(await send(512)).toEqual({ result: 'unavailable', reason: 'receipts-full' });
    // 24 h after the first half, only the first half has expired.
    vi.setSystemTime(1_760_000_000_000 + 24 * 60 * 60 * 1000 + 10 * 60 * 1000);
    expect(await send(513)).toEqual({ result: 'sent' });
    expect(f.promptAsync).toHaveBeenCalledTimes(513);
    // A younger receipt still replays instead of dispatching again.
    const read = await f.handler({ action: 'read' });
    expect(await f.handler({ action: 'send', sessionId: 'ses_one', epoch: read.epoch, text: 'm300', requestId: `request-${String(300).padStart(12, '0')}` })).toEqual({ result: 'sent' });
    expect(f.promptAsync).toHaveBeenCalledTimes(513);
  });
  it('serves an epoch that carries no part of the loopback token', async () => {
    const home = mkdtempSync(join(tmpdir(), 'wmux-chat-tui-'));
    const env = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, WMUX_PTY_ID: process.env.WMUX_PTY_ID, WMUX_DATA_SUFFIX: process.env.WMUX_DATA_SUFFIX };
    const disposers: (() => void)[] = [];
    // os.homedir() reads USERPROFILE on Windows, HOME elsewhere.
    Object.assign(process.env, { HOME: home, USERPROFILE: home, WMUX_PTY_ID: 'pty-epoch-test', WMUX_DATA_SUFFIX: '-epoch-test' });
    try {
      const f = fixture();
      await tui({ ...f.api, lifecycle: { onDispose: (fn: () => void) => disposers.push(fn) } });
      const file = join(home, '.wmux-epoch-test', 'terminal-chat', `${createHash('sha256').update('pty-epoch-test').digest('hex')}.json`);
      const { port, token } = JSON.parse(readFileSync(file, 'utf8'));
      const response = await fetch(`http://127.0.0.1:${port}/`, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ action: 'read' }) });
      const { epoch } = await response.json();
      expect(epoch).toMatch(/^[0-9a-f]{32}:\d+:ses_one$/);
      expect(token).not.toContain(epoch.split(':')[0]);
    } finally {
      for (const dispose of disposers) dispose();
      for (const [key, value] of Object.entries(env)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
      rmSync(home, { recursive: true, force: true });
    }
  });
  describe('abort', () => {
    const running = async () => {
      const f = fixture(); f.api.state.session.status = () => ({ type: 'busy' });
      const read = await f.handler({ action: 'read' });
      return { f, read, request: { action: 'abort', sessionId: 'ses_one', epoch: read.epoch, turnId: read.turnId } };
    };
    it('advertises abort and a turn id minted on idle -> running, held until the turn completes', async () => {
      const f = fixture();
      const idle = await f.handler({ action: 'read' });
      expect(idle).toMatchObject({ actions: ['read', 'send', 'abort'], turnId: expect.stringMatching(/^t1:oc\.[0-9a-f]{24}$/) });
      expect(idle).not.toHaveProperty('turnStartedAt');
      expect((await f.handler({ action: 'read' })).turnId).toBe(idle.turnId);
      // Busy is seen before the prompt's user message arrives.
      f.api.state.session.status = () => ({ type: 'busy' });
      const busy = await f.handler({ action: 'read' });
      expect(busy.turnId).not.toBe(idle.turnId);
      expect(busy.turnStartedAt).toEqual(expect.any(Number));
      const messages = [{ id: 'msg_one', sessionID: 'ses_one', role: 'user' }, { id: 'msg_two', sessionID: 'ses_one', role: 'user' }];
      f.api.state.session.messages = () => messages as never;
      expect((await f.handler({ action: 'read' })).turnId).toBe(busy.turnId);
      // A queued, synthetic or compaction user message mid-turn keeps it too.
      messages.push({ id: 'msg_three', sessionID: 'ses_one', role: 'user' });
      expect((await f.handler({ action: 'read' })).turnId).toBe(busy.turnId);
      f.api.state.session.status = () => ({ type: 'idle' });
      const done = await f.handler({ action: 'read' });
      expect(done).toMatchObject({ phase: 'complete', turnId: busy.turnId });
      f.api.state.session.status = () => ({ type: 'busy' });
      expect((await f.handler({ action: 'read' })).turnId).not.toBe(busy.turnId);
    });
    it('a TUI client without abort advertises read and send only, and refuses the action', async () => {
      const f = fixture(); delete f.api.client.session.abort;
      const handler = terminalChatHandler(f.api, 'epoch');
      const read = await handler({ action: 'read' });
      expect(read.actions).toEqual(['read', 'send']);
      await expect(handler({ action: 'abort', sessionId: 'ses_one', epoch: read.epoch })).rejects.toThrow();
    });
    it('aborts the selected session only while its turn runs', async () => {
      const { f, request } = await running();
      expect(await f.handler(request)).toMatchObject({ result: 'sent', turnId: request.turnId, phase: 'running' });
      expect(f.abort).toHaveBeenCalledWith({ sessionID: 'ses_one' }, { throwOnError: true });
    });
    it('idle is not_running; only a permission or question is prompt_active', async () => {
      const f = fixture(); const read = await f.handler({ action: 'read' });
      const request = { action: 'abort', sessionId: 'ses_one', epoch: read.epoch };
      expect(await f.handler(request)).toMatchObject({ result: 'not_running', phase: 'complete' });
      f.api.state.session.status = () => ({ type: 'busy' });
      f.api.state.session.permission = () => [{ id: 'per_1' }] as never;
      expect(await f.handler(request)).toMatchObject({ result: 'prompt_active', phase: 'awaiting_input' });
      f.api.state.session.permission = () => [];
      f.api.state.session.question = () => [{ id: 'que_1' }] as never;
      expect(await f.handler(request)).toMatchObject({ result: 'prompt_active' });
      expect(f.abort).not.toHaveBeenCalled();
      // A picker or palette the user opened does not hold the abort.
      f.api.state.session.question = () => [];
      f.api.ui.dialog.open = true;
      expect(await f.handler(request)).toMatchObject({ result: 'sent', phase: 'running' });
      expect(f.abort).toHaveBeenCalledTimes(1);
    });
    it('an ordinary dialog changes neither phase nor turn state; only send holds for it', async () => {
      const f = fixture(); f.api.ui.dialog.open = true;
      // Idle with a palette open: complete, not awaiting_input.
      const idle = await f.handler({ action: 'read' });
      expect(idle.phase).toBe('complete');
      expect(await f.handler({ action: 'send', sessionId: 'ses_one', epoch: idle.epoch, text: 'next', requestId: 'request-1234567890' }))
        .toEqual({ result: 'blocked' });
      expect(f.promptAsync).not.toHaveBeenCalled();
      // Busy with the palette open, aborted: the turn ends while it stays open.
      f.api.state.session.status = () => ({ type: 'busy' });
      const busy = await f.handler({ action: 'read' });
      expect(busy.phase).toBe('running');
      expect(await f.handler({ action: 'abort', sessionId: 'ses_one', epoch: busy.epoch, turnId: busy.turnId })).toMatchObject({ result: 'sent' });
      f.api.state.session.status = () => ({ type: 'idle' });
      expect(await f.handler({ action: 'read' })).toMatchObject({ phase: 'complete', turnId: busy.turnId });
      expect(await f.handler({ action: 'abort', sessionId: 'ses_one', epoch: busy.epoch, turnId: busy.turnId }))
        .toMatchObject({ result: 'not_running', phase: 'complete' });
    });
    it('the admission fence answers pending under the turn id the running turn keeps', async () => {
      const f = fixture(); const settled = await f.handler({ action: 'read' });
      let finish!: () => void;
      f.promptAsync.mockImplementation(() => new Promise(resolve => { finish = () => resolve({}); }));
      const before = Date.now();
      const sent = f.handler({ action: 'send', sessionId: 'ses_one', epoch: settled.epoch, text: 'next', requestId: 'request-1234567890' });
      const fenced = await f.handler({ action: 'read' });
      expect(fenced.phase).toBe('running');
      expect(fenced.turnId).not.toBe(settled.turnId);
      expect(fenced.turnStartedAt).toBeGreaterThanOrEqual(before);
      expect(await f.handler({ action: 'abort', sessionId: 'ses_one', epoch: fenced.epoch, turnId: fenced.turnId }))
        .toMatchObject({ result: 'pending', phase: 'running' });
      finish(); await sent;
      expect(f.abort).not.toHaveBeenCalled();
      // Once the TUI is busy the fence is over; the turn id is unchanged.
      f.api.state.session.status = () => ({ type: 'busy' });
      const busy = await f.handler({ action: 'read' });
      expect(busy).toMatchObject({ turnId: fenced.turnId, turnStartedAt: fenced.turnStartedAt });
      expect(await f.handler({ action: 'abort', sessionId: 'ses_one', epoch: busy.epoch, turnId: busy.turnId })).toMatchObject({ result: 'sent' });
    });
    it('checks session, generation and turn like send', async () => {
      const { f, request } = await running();
      expect(await f.handler({ ...request, sessionId: 'ses_two' })).toEqual({ result: 'session_changed' });
      expect(await f.handler({ ...request, epoch: 'epoch:9:ses_one' })).toEqual({ result: 'session_changed' });
      expect(await f.handler({ ...request, turnId: 't1:oc.000000000000000000000000' })).toMatchObject({ result: 'not_running', turnId: request.turnId });
      f.api.route.current.params.sessionID = 'ses_two';
      await f.handler({ action: 'read' });
      f.api.route.current.params.sessionID = 'ses_one';
      // Away and back keeps the session id, not the generation.
      expect(await f.handler(request)).toEqual({ result: 'session_changed' });
      expect(f.abort).not.toHaveBeenCalled();
    });
    it('an abort that throws is unconfirmed, never retried', async () => {
      const { f, request } = await running();
      f.abort.mockRejectedValueOnce(new Error('connection lost'));
      expect(await f.handler(request)).toMatchObject({ result: 'unconfirmed' });
      expect(f.abort).toHaveBeenCalledTimes(1);
    });
  });
  it('never invents a new session for the TUI home screen', async () => {
    const f = fixture(); f.api.route.current.name = 'home';
    expect(await f.handler({ action: 'read' })).toMatchObject({ available: false });
    expect(f.promptAsync).not.toHaveBeenCalled();
  });
});

describe('OpenCode decisions (permissions and questions)', () => {
  // Root ses_one with a direct child ses_kid and a grandchild ses_deep; the
  // TUI state has no session list, so children are found through events.
  function decisionsFixture() {
    const f = fixture();
    const handlers: Record<string, (event: unknown) => void> = {};
    const perms: Record<string, Array<Record<string, unknown>>> = { ses_one: [], ses_kid: [], ses_deep: [], ses_other: [] };
    const questions: Record<string, Array<Record<string, unknown>>> = { ses_one: [], ses_kid: [], ses_deep: [], ses_other: [] };
    const parents: Record<string, string | undefined> = { ses_one: undefined, ses_kid: 'ses_one', ses_deep: 'ses_kid', ses_other: undefined };
    const reply = vi.fn(async (_input: unknown): Promise<unknown> => ({ data: true, response: { status: 200 } }));
    const qReply = vi.fn(async (_input: unknown): Promise<unknown> => ({ data: true, response: { status: 200 } }));
    const qReject = vi.fn(async (_input: unknown): Promise<unknown> => ({ data: true, response: { status: 200 } }));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- a loose fake of the TUI api
    const api = f.api as any;
    api.event = { on: (type: string, fn: (event: unknown) => void) => { handlers[type] = fn; } };
    api.client.permission = { reply };
    api.client.question = { reply: qReply, reject: qReject };
    api.state.session.get = (id: string) => (id in parents ? { id, parentID: parents[id] } : undefined);
    api.state.session.permission = (id: string) => perms[id] ?? [];
    api.state.session.question = (id: string) => questions[id] ?? [];
    const handler = terminalChatHandler(api, 'epoch');
    const ask = (sessionID: string, id = `per_${sessionID}`) => {
      perms[sessionID]!.push({ id, sessionID, permission: 'bash', patterns: ['touch a'], always: ['*'], metadata: {} });
      handlers['permission.asked']?.({ properties: { id, sessionID } });
    };
    return { api, handler, perms, questions, reply, qReply, qReject, ask };
  }
  it('advertises decisions next to read, send and abort', async () => {
    const d = decisionsFixture();
    expect((await d.handler({ action: 'read' })).actions).toEqual(['read', 'send', 'abort', 'decisions']);
  });
  it("a direct child's permission blocks the root route: phase awaiting_input", async () => {
    const d = decisionsFixture();
    expect((await d.handler({ action: 'read' })).phase).toBe('complete');
    d.ask('ses_kid');
    expect((await d.handler({ action: 'read' })).phase).toBe('awaiting_input');
  });
  it("lists what the TUI draws: the route's own and its direct children's, never a grandchild's or another root's", async () => {
    const d = decisionsFixture();
    d.ask('ses_one'); d.ask('ses_kid'); d.ask('ses_deep'); d.ask('ses_other');
    const read = await d.handler({ action: 'decisions.read' });
    expect(read).toMatchObject({ available: true, sessionId: 'ses_one', gone: [] });
    expect(read.decisions.map((x: { requestId: string }) => x.requestId)).toEqual(['per_ses_one', 'per_ses_kid']);
    expect(read.decisions[1]).toEqual({ kind: 'permission', requestId: 'per_ses_kid', sessionId: 'ses_kid', digest: expect.stringMatching(/^[0-9a-f]{32}$/), permission: 'bash', patterns: ['touch a'] });
    // A child route draws none.
    d.api.route.current.params.sessionID = 'ses_kid';
    expect((await d.handler({ action: 'decisions.read' })).decisions).toEqual([]);
  });
  it('finds a child its task call started even when no event announced it (a TUI restart)', async () => {
    const d = decisionsFixture();
    d.perms.ses_kid!.push({ id: 'per_early', sessionID: 'ses_kid', permission: 'bash', patterns: ['ls'], always: [], metadata: {} });
    expect((await d.handler({ action: 'read' })).phase).toBe('complete');
    d.api.state.session.messages = () => [{ id: 'msg_a', sessionID: 'ses_one', role: 'assistant' }];
    d.api.state.part = () => [{ id: 'p', sessionID: 'ses_one', messageID: 'msg_a', type: 'tool', tool: 'task', state: { status: 'running', metadata: { sessionId: 'ses_kid' } } }];
    expect((await d.handler({ action: 'read' })).phase).toBe('awaiting_input');
    expect((await d.handler({ action: 'decisions.read' })).decisions.map((x: { requestId: string }) => x.requestId)).toEqual(['per_early']);
  });
  it('answers a request in its own session even when the route shows another one', async () => {
    const d = decisionsFixture();
    d.ask('ses_kid');
    const [listedKid] = (await d.handler({ action: 'decisions.read' })).decisions;
    d.api.route.current.name = 'home';
    expect(await d.handler({ action: 'decisions.reply', kind: 'permission', requestId: 'per_ses_kid', sessionId: 'ses_kid', digest: listedKid.digest, reply: 'once' })).toEqual({ result: 'ok' });
    expect(d.reply).toHaveBeenCalledWith({ requestID: 'per_ses_kid', reply: 'once' });
    // `gone` answers for known requests by their own session, whatever the route.
    d.perms.ses_kid = [];
    expect((await d.handler({ action: 'decisions.read', known: [{ requestId: 'per_ses_kid', sessionId: 'ses_kid' }] })).gone).toEqual(['per_ses_kid']);
  });
  it('refuses `always`, a request not listed and a grandchild; a 404 is not_found, a throw unconfirmed', async () => {
    const d = decisionsFixture();
    d.ask('ses_one'); d.ask('ses_deep');
    const [own] = (await d.handler({ action: 'decisions.read' })).decisions;
    const base = { action: 'decisions.reply', kind: 'permission', requestId: 'per_ses_one', sessionId: 'ses_one', digest: own.digest };
    expect(await d.handler({ ...base, reply: 'always' })).toEqual({ result: 'refused' });
    // The same id asking something else now: the card the phone saw is stale.
    d.perms.ses_one![0]!.patterns = ['rm -rf /'];
    expect(await d.handler({ ...base, reply: 'once' })).toEqual({ result: 'changed' });
    d.perms.ses_one![0]!.patterns = ['touch a'];
    expect(await d.handler({ ...base, requestId: 'per_nope', reply: 'once' })).toEqual({ result: 'not_found' });
    expect(await d.handler({ ...base, requestId: 'per_ses_deep', sessionId: 'ses_deep', reply: 'once' })).toEqual({ result: 'not_found' });
    expect(d.reply).not.toHaveBeenCalled();
    d.reply.mockResolvedValueOnce({ error: { _tag: 'PermissionNotFoundError' }, response: { status: 404 } });
    expect(await d.handler({ ...base, reply: 'reject' })).toEqual({ result: 'not_found' });
    d.reply.mockRejectedValueOnce(new Error('socket hang up'));
    expect(await d.handler({ ...base, reply: 'reject' })).toEqual({ result: 'unconfirmed' });
  });
  it('replies by option index with OpenCode\'s own labels; typed answers only where custom is allowed', async () => {
    const d = decisionsFixture();
    d.questions.ses_one = [{ id: 'que_1', sessionID: 'ses_one', questions: [
      { question: 'Color?', header: 'Color', options: [{ label: 'Red', description: 'r' }] },
      { question: 'Size?', header: 'Size', custom: false, multiple: true, options: [{ label: 'S', description: '' }, { label: 'L', description: '' }] }] }];
    const read = await d.handler({ action: 'decisions.read' });
    expect(read.decisions[0].questions[1]).toEqual({ question: 'Size?', header: 'Size', multiple: true, custom: false, options: [{ label: 'S' }, { label: 'L' }] });
    expect(read.decisions[0].truncated).toBeUndefined();
    const base = { action: 'decisions.reply', kind: 'question', requestId: 'que_1', sessionId: 'ses_one', digest: read.decisions[0].digest };
    expect(await d.handler({ ...base, answers: [{ options: [0] }, { options: [], other: 'XL' }] })).toEqual({ result: 'refused' });
    expect(await d.handler({ ...base, answers: [{ options: [0] }] })).toEqual({ result: 'refused' });
    expect(await d.handler({ ...base, answers: [{ options: [5] }, { options: [0] }] })).toEqual({ result: 'refused' });
    expect(await d.handler({ ...base, answers: [{ options: [], other: '  ' }, { options: [0] }] })).toEqual({ result: 'refused' });
    expect(await d.handler({ ...base, answers: [{ options: [0, 0] }, { options: [0] }] })).toEqual({ result: 'refused' });
    expect(d.qReply).not.toHaveBeenCalled();
    expect(await d.handler({ ...base, answers: [{ options: [], other: 'Teal' }, { options: [1, 0] }] })).toEqual({ result: 'ok' });
    expect(d.qReply).toHaveBeenCalledWith({ requestID: 'que_1', answers: [['Teal'], ['L', 'S']] });
    expect(await d.handler({ ...base, reject: true })).toEqual({ result: 'ok' });
    expect(d.qReject).toHaveBeenCalledWith({ requestID: 'que_1' });
  });
  it('marks a request it had to cut as truncated, and a long label answers with its full text', async () => {
    const d = decisionsFixture();
    const long = 'L'.repeat(250);
    d.questions.ses_one = [{ id: 'que_2', sessionID: 'ses_one', questions: [{ question: 'Pick', header: 'P', options: [{ label: long }, { label: 'short' }] }] }];
    const [item] = (await d.handler({ action: 'decisions.read' })).decisions;
    expect(item.truncated).toBe(true);
    expect(item.questions[0].options[0].label).toHaveLength(200);
    // The plugin maps the index back to OpenCode's own, whole label.
    expect(await d.handler({ action: 'decisions.reply', kind: 'question', requestId: 'que_2', sessionId: 'ses_one', digest: item.digest, answers: [{ options: [0] }] })).toEqual({ result: 'ok' });
    expect(d.qReply).toHaveBeenCalledWith({ requestID: 'que_2', answers: [[long]] });
    d.questions.ses_one = [{ id: 'que_3', sessionID: 'ses_one', questions: Array.from({ length: 9 }, (_, i) => ({ question: `q${i}`, header: '', options: [{ label: 'a' }] })) }];
    expect((await d.handler({ action: 'decisions.read' })).decisions[0].truncated).toBe(true);
  });
});
