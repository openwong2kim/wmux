import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatAdapterContext } from '../adapter';
import { CodexChatAdapter } from '../CodexChatAdapter';

const wire = vi.hoisted(() => ({
  message: (_method: string, _params: unknown, _id?: string | number) => { /* replaced by mock transport */ },
  close: (_reason: string) => { /* replaced by mock transport */ }, request: vi.fn(), notify: vi.fn(), respond: vi.fn(), reject: vi.fn(),
}));
vi.mock('../JsonRpcProcess', () => ({ JsonRpcProcess: class {
  constructor(_command: string, _args: string[], _cwd: string, _env: unknown, message: typeof wire.message, close: typeof wire.close) { wire.message = message; wire.close = close; }
  request = wire.request; notify = wire.notify; respond = wire.respond; reject = wire.reject;
  close() { /* mock has no process */ }
} }));
beforeEach(() => {
  vi.clearAllMocks();
  wire.request.mockImplementation(async (method: string) => method === 'thread/start' || method === 'thread/resume'
    ? { thread: { id: 'thread', turns: [] } } : method === 'turn/start' ? { turn: { id: 'turn' } } : {});
});
function context(): ChatAdapterContext { return { cwd: '/tmp', env: {}, emit: vi.fn(), request: vi.fn(async () => ({ optionId: 'accept' })), disconnected: vi.fn() }; }

describe('Codex official protocol adapter', () => {
  it('waits for provider completion, ignores foreign threads and accumulates deltas', async () => {
    const adapter = new CodexChatAdapter(); const ctx = context(); await adapter.connect(ctx);
    const done = vi.fn(); const turn = adapter.prompt('hello', 'request').then(done); await Promise.resolve();
    expect(done).not.toHaveBeenCalled();
    wire.message('item/agentMessage/delta', { threadId: 'foreign', itemId: 'a', delta: 'leak' });
    expect(ctx.emit).not.toHaveBeenCalled();
    wire.message('item/agentMessage/delta', { threadId: 'thread', turnId: 'turn', itemId: 'a', delta: 'hel' });
    wire.message('item/agentMessage/delta', { threadId: 'thread', turnId: 'turn', itemId: 'a', delta: 'lo' });
    expect(ctx.emit).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'a', text: 'hello' }));
    wire.message('turn/completed', { threadId: 'thread', turn: { id: 'turn', status: 'completed', items: [] } });
    await turn; expect(done).toHaveBeenCalledOnce();
  });
  it('does not grant session-wide permissions and rejects stale/unknown client requests', async () => {
    const adapter = new CodexChatAdapter(); const ctx = context(); await adapter.connect(ctx);
    const turn = adapter.prompt('hello', 'request'); await Promise.resolve();
    wire.message('item/commandExecution/requestApproval', { threadId: 'thread', turnId: 'old', command: 'x' }, 1);
    expect(wire.reject).toHaveBeenCalledWith(1);
    wire.message('item/commandExecution/requestApproval', { threadId: 'thread', turnId: 'turn', command: 'echo hi' }, 2);
    await Promise.resolve();
    expect(wire.respond).toHaveBeenCalledWith(2, { decision: 'accept' });
    wire.message('unknown/request', { threadId: 'thread', turnId: 'turn' }, 3);
    expect(wire.reject).toHaveBeenCalledWith(3);
    wire.message('turn/completed', { threadId: 'thread', turn: { id: 'turn', status: 'completed' } }); await turn;
  });
  it('surfaces disconnect as uncertain completion rather than a successful answer', async () => {
    const adapter = new CodexChatAdapter(); const ctx = context(); await adapter.connect(ctx);
    const turn = adapter.prompt('hello', 'request'); await Promise.resolve();
    wire.close('connection lost');
    await expect(turn).rejects.toThrow('connection lost');
    expect(ctx.disconnected).toHaveBeenCalledWith('connection lost');
  });
  it('refuses a resume response with a different conversation ID', async () => {
    const adapter = new CodexChatAdapter();
    await expect(adapter.connect({ ...context(), sessionId: 'different' })).rejects.toThrow('identity mismatch');
  });
});
