import { describe, expect, it } from 'vitest';
import {
  CHATV2_IPC,
  CHATV2_PROVIDER_SESSION_ID,
  CHATV2_RPC,
  chatV2HistoryEpoch,
  parseChatV2Params,
  type ChatV2ResultByMethod,
} from '../ipc';
import { CHATV2_MAX_PROMPT_BYTES } from '../limits';

const session = { paneId: 'pty-1', chatSessionId: 'c2-abc' };
const epoch = '0123456789abcdef';

describe('chat-v2 method tables', () => {
  it('pairs every RPC method with an IPC channel', () => {
    for (const method of Object.keys(CHATV2_RPC)) {
      expect(CHATV2_IPC).toHaveProperty(method);
      expect(CHATV2_RPC[method as keyof typeof CHATV2_RPC]).toBe(`daemon.chatv2.${method}`);
    }
  });

  it('lets a success value be built for every result type', () => {
    const ok: ChatV2ResultByMethod['answer'] = { ok: true };
    const close: ChatV2ResultByMethod['close'] = { ok: true };
    const dup: ChatV2ResultByMethod['send'] = { ok: true, clientMessageId: 'client-0001', seq: 4, duplicate: true };
    expect([ok, close, dup].every((r) => r.ok)).toBe(true);
  });
});

describe('parseChatV2Params', () => {
  it('accepts a claude create and keeps an explicit model', () => {
    expect(parseChatV2Params('create', { paneId: 'pty-1', agent: 'claude', mode: 'default' }))
      .toEqual({ paneId: 'pty-1', agent: 'claude', mode: 'default' });
    expect(parseChatV2Params('create', { paneId: 'pty-1', agent: 'claude', mode: 'bypass', model: 'claude-opus-5-5' }))
      .toEqual({ paneId: 'pty-1', agent: 'claude', mode: 'bypass', model: 'claude-opus-5-5' });
  });

  it('refuses agents, modes and models v1 does not run, and drops renderer-supplied paths or argv', () => {
    expect(parseChatV2Params('create', { paneId: 'pty-1', agent: 'codex', mode: 'default' })).toBeNull();
    expect(parseChatV2Params('create', { paneId: 'pty-1', agent: 'claude', mode: 'yolo' })).toBeNull();
    for (const model of ['x; rm', '--dangerously-skip-permissions', '-p', '', '.hidden']) {
      expect(parseChatV2Params('create', { paneId: 'pty-1', agent: 'claude', mode: 'default', model })).toBeNull();
    }
    expect(parseChatV2Params('create', { paneId: '../etc', agent: 'claude', mode: 'default' })).toBeNull();
    expect(parseChatV2Params('create', { paneId: 'pty-1', agent: 'claude', mode: 'default', cwd: '/', argv: ['x'] }))
      .toEqual({ paneId: 'pty-1', agent: 'claude', mode: 'default' });
  });

  it('validates a send, measuring the prompt in UTF-8 bytes', () => {
    const ok = { ...session, epoch, clientMessageId: 'client-0001', text: 'hi' };
    expect(parseChatV2Params('send', ok)).toEqual(ok);
    expect(parseChatV2Params('send', { ...ok, attachments: ['/tmp/a.png'] })).toEqual({ ...ok, attachments: ['/tmp/a.png'] });
    expect(parseChatV2Params('send', { ...ok, clientMessageId: 'short' })).toBeNull();
    expect(parseChatV2Params('send', { ...ok, text: '   ' })).toBeNull();
    expect(parseChatV2Params('send', { ...ok, attachments: ['relative.png'] })).toBeNull();
    expect(parseChatV2Params('send', { ...ok, epoch: 'not-an-epoch' })).toBeNull();
    const korean = '가'.repeat(Math.floor(CHATV2_MAX_PROMPT_BYTES / 3));
    expect(parseChatV2Params('send', { ...ok, text: korean })).not.toBeNull();
    expect(parseChatV2Params('send', { ...ok, text: `${korean}가` })).toBeNull();
  });

  it('names an answer by request id', () => {
    expect(parseChatV2Params('answer', { ...session, requestId: 'c6ab0e7b-f8c3-4bdd-95b6-ca5a9ec8849f', decision: 'allow' }))
      .toEqual({ ...session, requestId: 'c6ab0e7b-f8c3-4bdd-95b6-ca5a9ec8849f', decision: 'allow' });
    expect(parseChatV2Params('answer', { ...session, requestId: 'r1', decision: 'allow', answers: [{ keys: ['1'], other: 'x' }] }))
      .toEqual({ ...session, requestId: 'r1', decision: 'allow', answers: [{ keys: ['1'], other: 'x' }] });
    expect(parseChatV2Params('answer', { ...session, approvalId: 'a1', decision: 'allow' })).toBeNull();
    expect(parseChatV2Params('answer', { ...session, requestId: 'r1', decision: 'always' })).toBeNull();
    expect(parseChatV2Params('answer', { ...session, requestId: 'r1', decision: 'allow', answers: [{ keys: 1 }] })).toBeNull();
  });

  it('pages history and bodies by block id', () => {
    expect(parseChatV2Params('history', { ...session, epoch, beforeBlockId: '12.1' })).toEqual({ ...session, epoch, beforeBlockId: '12.1' });
    expect(parseChatV2Params('history', { ...session, epoch, beforeIndex: 40 })).toBeNull();
    expect(parseChatV2Params('bodies', { ...session, epoch, blockId: '3.1', field: 'detail' }))
      .toEqual({ ...session, epoch, blockId: '3.1', field: 'detail' });
    expect(parseChatV2Params('bodies', { ...session, epoch, blockId: '3.1', field: 'input' })).toBeNull();
  });

  it('needs a chat session id where the method names one', () => {
    for (const method of ['snapshot', 'interrupt', 'toTerminal', 'close'] as const) {
      expect(parseChatV2Params(method, session)).toEqual(session);
      expect(parseChatV2Params(method, { paneId: 'pty-1' })).toBeNull();
    }
  });
});

describe('ids', () => {
  it('accepts only UUID provider session ids for resume', () => {
    expect(CHATV2_PROVIDER_SESSION_ID.test('c6ab0e7b-f8c3-4bdd-95b6-ca5a9ec8849f')).toBe(true);
    expect(CHATV2_PROVIDER_SESSION_ID.test('--dangerously-skip-permissions')).toBe(false);
  });

  it('gives the phone a distinct history epoch', () => {
    expect(chatV2HistoryEpoch('c2-abc', epoch)).toBe(`c2:c2-abc:${epoch}`);
  });
});
