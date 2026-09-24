import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { OpenCodeChatAdapter } from '../OpenCodeChatAdapter';
import type { ChatAdapterContext } from '../adapter';

const client = vi.hoisted(() => ({
  session: { get: vi.fn(), create: vi.fn(), status: vi.fn(), messages: vi.fn(), prompt: vi.fn(), abort: vi.fn() },
  event: { subscribe: vi.fn() },
}));
vi.mock('@opencode-ai/sdk/v2/client', () => ({ createOpencodeClient: () => client }));
vi.mock('../agentProcess', () => ({
  stopAgent: vi.fn(), spawnAgent: () => {
    const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough() });
    queueMicrotask(() => child.stdout.write('opencode server listening on http://127.0.0.1:12345\n'));
    return child;
  },
}));
const context = (): ChatAdapterContext => ({ cwd: '/tmp', env: {}, emit: vi.fn(), request: vi.fn(async () => ({})), disconnected: vi.fn() });
beforeEach(() => {
  vi.clearAllMocks();
  client.session.create.mockResolvedValue({ data: { id: 'session' } });
  client.session.status.mockResolvedValue({ data: {} });
  client.session.messages.mockResolvedValue({ data: [] });
  client.event.subscribe.mockResolvedValue({ stream: { [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => { /* idle stream */ }) }) } });
});
describe('OpenCode native projection', () => {
  it('projects a successful native write without inventing a before-image', async () => {
    const adapter = new OpenCodeChatAdapter(); const ctx = context(); await adapter.connect(ctx);
    client.session.prompt.mockResolvedValue({ data: { info: { id: 'message', role: 'assistant' }, parts: [{
      id: 'write', messageID: 'message', sessionID: 'session', type: 'tool', tool: 'write',
      state: { status: 'completed', input: { content: 'hello', filePath: '/tmp/proof.txt' }, output: 'Wrote file successfully.',
        metadata: { filepath: '/tmp/proof.txt', exists: false } },
    }] } });
    await adapter.prompt('write a file', 'request');
    expect(ctx.emit).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'tool_result', ok: true,
      files: [{ path: '/tmp/proof.txt', patch: 'After:\nhello', truncated: false, additions: 1, deletions: 0 }] }));
    adapter.close();
  });
  it('accepts a requested native cancellation even when its terminal message precedes abort acknowledgement', async () => {
    const adapter = new OpenCodeChatAdapter(); await adapter.connect(context());
    let complete!: (value: unknown) => void;
    client.session.prompt.mockImplementation(() => new Promise((resolve) => { complete = resolve; }));
    client.session.abort.mockImplementation(async () => {
      complete({ data: { info: { error: { name: 'MessageAbortedError', data: { message: 'Aborted' } } }, parts: [] } });
      await Promise.resolve(); return { data: true };
    });
    const turn = adapter.prompt('long answer', 'request');
    await adapter.cancel(); await expect(turn).resolves.toBeUndefined(); adapter.close();
  });
  it('does not classify an unsolicited native abort as a successful turn', async () => {
    const adapter = new OpenCodeChatAdapter(); await adapter.connect(context());
    client.session.prompt.mockResolvedValue({ data: { info: { error: { name: 'MessageAbortedError', data: { message: 'Aborted' } } } } });
    await expect(adapter.prompt('hello', 'request')).rejects.toThrow('Aborted'); adapter.close();
  });
  it('restores the snapshot before consuming live events', async () => {
    const order: string[] = [];
    client.session.messages.mockImplementation(async () => { order.push('history'); return { data: [] }; });
    client.event.subscribe.mockImplementation(async () => { order.push('stream'); return { stream: { [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => { /* idle stream */ }) }) } }; });
    const adapter = new OpenCodeChatAdapter(); await adapter.connect(context());
    expect(order).toEqual(['history', 'stream']); adapter.close();
  });
  it('refuses to restore an already running native session', async () => {
    client.session.status.mockResolvedValue({ data: { session: { type: 'busy' } } });
    const adapter = new OpenCodeChatAdapter();
    await expect(adapter.connect(context())).rejects.toThrow('already running');
    expect(client.session.messages).not.toHaveBeenCalled(); adapter.close();
  });
});
