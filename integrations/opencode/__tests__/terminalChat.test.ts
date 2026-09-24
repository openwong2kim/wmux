import { describe, expect, it, vi } from 'vitest';
// A standalone JS plugin runs in OpenCode's Bun, without wmux's TS runtime.
// @ts-expect-error Standalone integration asset intentionally has no TS runtime dependency.
import { terminalChatHandler, projectTuiMessages } from '../plugins/wmux-chat-tui.mjs';
function fixture() {
  const promptAsync = vi.fn(async () => ({}));
  const api = { route: { current: { name: 'session', params: { sessionID: 'ses_one' } } },
    ui: { dialog: { open: false } }, client: { session: { promptAsync } },
    state: { ready: true, session: { get: (id: string) => ({ id }), status: () => ({ type: 'idle' }), permission: () => [], question: () => [],
      messages: () => [{ id: 'msg_one', sessionID: 'ses_one', role: 'user' }] },
      part: () => [{ id: 'part_one', sessionID: 'ses_one', messageID: 'msg_one', type: 'text', text: 'hello' }] } };
  return { api, promptAsync, handler: terminalChatHandler(api, 'epoch') };
}
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
  it('never invents a new session for the TUI home screen', async () => {
    const f = fixture(); f.api.route.current.name = 'home';
    expect(await f.handler({ action: 'read' })).toMatchObject({ available: false });
    expect(f.promptAsync).not.toHaveBeenCalled();
  });
});
