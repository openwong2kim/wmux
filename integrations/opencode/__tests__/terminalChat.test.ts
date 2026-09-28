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
    it('advertises abort and a turn id that holds for the turn and changes with the next prompt', async () => {
      const f = fixture();
      const read = await f.handler({ action: 'read' });
      expect(read).toMatchObject({ actions: ['read', 'send', 'abort'], turnId: expect.stringMatching(/^t1:oc\.[0-9a-f]{24}$/) });
      expect((await f.handler({ action: 'read' })).turnId).toBe(read.turnId);
      f.api.state.session.messages = () => [{ id: 'msg_one', sessionID: 'ses_one', role: 'user' },
        { id: 'msg_two', sessionID: 'ses_one', role: 'user', time: { created: 1_760_000_000_000 } }] as never;
      const next = await f.handler({ action: 'read' });
      expect(next.turnId).not.toBe(read.turnId);
      expect(next.turnStartedAt).toBe(1_760_000_000_000);
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
    it('idle is not_running and the dialog is prompt_active, without an abort', async () => {
      const f = fixture(); const read = await f.handler({ action: 'read' });
      const request = { action: 'abort', sessionId: 'ses_one', epoch: read.epoch };
      expect(await f.handler(request)).toMatchObject({ result: 'not_running', phase: 'complete' });
      f.api.state.session.status = () => ({ type: 'busy' });
      f.api.ui.dialog.open = true;
      expect(await f.handler(request)).toMatchObject({ result: 'prompt_active', phase: 'awaiting_input' });
      f.api.ui.dialog.open = false;
      f.api.state.session.permission = () => [{ id: 'per_1' }] as never;
      expect(await f.handler(request)).toMatchObject({ result: 'prompt_active' });
      expect(f.abort).not.toHaveBeenCalled();
    });
    it('the admission fence is not_running, with a turn id of its own', async () => {
      const f = fixture(); const settled = await f.handler({ action: 'read' });
      let finish!: () => void;
      f.promptAsync.mockImplementation(() => new Promise(resolve => { finish = () => resolve({}); }));
      const sent = f.handler({ action: 'send', sessionId: 'ses_one', epoch: settled.epoch, text: 'next', requestId: 'request-1234567890' });
      const fenced = await f.handler({ action: 'read' });
      expect(fenced.phase).toBe('running');
      expect(fenced.turnId).not.toBe(settled.turnId);
      expect(await f.handler({ action: 'abort', sessionId: 'ses_one', epoch: fenced.epoch, turnId: fenced.turnId }))
        .toMatchObject({ result: 'not_running', phase: 'running' });
      finish(); await sent;
      expect(f.abort).not.toHaveBeenCalled();
      // Once the TUI is busy the fence is over and the turn can be aborted.
      f.api.state.session.status = () => ({ type: 'busy' });
      const busy = await f.handler({ action: 'read' });
      expect(busy.turnId).not.toBe(fenced.turnId);
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
