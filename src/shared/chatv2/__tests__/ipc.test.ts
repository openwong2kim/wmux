import { describe, expect, it } from 'vitest';
import { CHATV2_IPC, CHATV2_MAX_PROMPT_CHARS, CHATV2_RPC, chatV2HistoryEpoch, parseChatV2Params } from '../ipc';

const session = { paneId: 'pty-1', chatSessionId: 'c2-abc' };

describe('chat-v2 method tables', () => {
  it('pairs every RPC method with an IPC channel', () => {
    for (const method of Object.keys(CHATV2_RPC)) {
      expect(CHATV2_IPC).toHaveProperty(method);
      expect(CHATV2_RPC[method as keyof typeof CHATV2_RPC]).toBe(`daemon.chatv2.${method}`);
    }
  });
});

describe('parseChatV2Params', () => {
  it('accepts a claude create and defaults the model', () => {
    expect(parseChatV2Params('create', { paneId: 'pty-1', agent: 'claude', mode: 'default' }))
      .toEqual({ paneId: 'pty-1', agent: 'claude', mode: 'default' });
    expect(parseChatV2Params('create', { paneId: 'pty-1', agent: 'claude', mode: 'bypass', model: 'claude-opus-5-5' }))
      .toEqual({ paneId: 'pty-1', agent: 'claude', mode: 'bypass', model: 'claude-opus-5-5' });
  });

  it('refuses agents and modes v1 does not run, and renderer-supplied paths or argv', () => {
    expect(parseChatV2Params('create', { paneId: 'pty-1', agent: 'codex', mode: 'default' })).toBeNull();
    expect(parseChatV2Params('create', { paneId: 'pty-1', agent: 'claude', mode: 'yolo' })).toBeNull();
    expect(parseChatV2Params('create', { paneId: 'pty-1', agent: 'claude', mode: 'default', model: 'x; rm' })).toBeNull();
    expect(parseChatV2Params('create', { paneId: '../etc', agent: 'claude', mode: 'default' })).toBeNull();
    const extra = parseChatV2Params('create', { paneId: 'pty-1', agent: 'claude', mode: 'default', cwd: '/', argv: ['x'] });
    expect(extra).toEqual({ paneId: 'pty-1', agent: 'claude', mode: 'default' });
  });

  it('validates a send', () => {
    const ok = { ...session, epoch: 'e1', clientMessageId: 'client-0001', text: 'hi' };
    expect(parseChatV2Params('send', ok)).toEqual(ok);
    expect(parseChatV2Params('send', { ...ok, attachments: ['/tmp/a.png'] })).toEqual({ ...ok, attachments: ['/tmp/a.png'] });
    expect(parseChatV2Params('send', { ...ok, clientMessageId: 'short' })).toBeNull();
    expect(parseChatV2Params('send', { ...ok, text: '   ' })).toBeNull();
    expect(parseChatV2Params('send', { ...ok, text: 'x'.repeat(CHATV2_MAX_PROMPT_CHARS + 1) })).toBeNull();
    expect(parseChatV2Params('send', { ...ok, attachments: ['relative.png'] })).toBeNull();
    expect(parseChatV2Params('send', { ...ok, epoch: undefined })).toBeNull();
  });

  it('validates an answer', () => {
    expect(parseChatV2Params('answer', { ...session, approvalId: 'a1', decision: 'allow' }))
      .toEqual({ ...session, approvalId: 'a1', decision: 'allow' });
    expect(parseChatV2Params('answer', { ...session, approvalId: 'a1', decision: 'allow', answers: [{ keys: ['1'] }] }))
      .toEqual({ ...session, approvalId: 'a1', decision: 'allow', answers: [{ keys: ['1'] }] });
    expect(parseChatV2Params('answer', { ...session, approvalId: 'a1', decision: 'always' })).toBeNull();
    expect(parseChatV2Params('answer', { ...session, approvalId: 'a1', decision: 'allow', answers: [{ keys: 1 }] })).toBeNull();
  });

  it('needs a chat session id where the method names one', () => {
    for (const method of ['snapshot', 'interrupt', 'toTerminal', 'close'] as const) {
      expect(parseChatV2Params(method, session)).toEqual(session);
      expect(parseChatV2Params(method, { paneId: 'pty-1' })).toBeNull();
    }
    expect(parseChatV2Params('history', { ...session, epoch: 'e1', beforeIndex: 40 })).toEqual({ ...session, epoch: 'e1', beforeIndex: 40 });
    expect(parseChatV2Params('history', { ...session, epoch: 'e1', beforeIndex: -1 })).toBeNull();
  });
});

describe('chatV2HistoryEpoch', () => {
  it('is distinct from the file, tui and managed epochs', () => {
    expect(chatV2HistoryEpoch('c2-abc', 'e1')).toBe('c2:c2-abc:e1');
  });
});
