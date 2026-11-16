// a2a.remote.answer on main's pipe: who may answer, and what reaches the daemon.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { registerRemoteAnswerRpc } from '../remoteAnswer.rpc';
import type { RpcContext } from '../../../../shared/rpc';

type Handler = (params: Record<string, unknown>, ctx?: RpcContext) => Promise<unknown>;

const local = { origin: 'local' } as RpcContext;
const answer = { taskId: 'rt-1', pickerId: '0123456789abcdef', option: 2, senderPtyId: 'pty-a' };

let handlers: Map<string, Handler>;
let daemon: { isConnected: boolean; a2aRemoteAnswer: ReturnType<typeof vi.fn> };

beforeEach(() => {
  handlers = new Map();
  daemon = { isConnected: true, a2aRemoteAnswer: vi.fn(async () => ({ ok: true, taskId: 'rt-1', messageId: 'an-1' })) };
  const router = { register: (m: string, h: Handler) => handlers.set(m, h) };
  registerRemoteAnswerRpc(router as never, () => null, {
    getDaemonClient: () => daemon as never,
    resolveCaller: async (pty) => (pty === 'pty-a' ? { workspaceId: 'ws-a' } : null),
  });
});

const call = (p: Record<string, unknown>, ctx: RpcContext = local) =>
  handlers.get('a2a.remote.answer')!(p, ctx) as Promise<{ ok?: boolean; error?: { code: string } }>;

describe('a2a.remote.answer', () => {
  it('passes the workspace the caller\'s pane resolves to, never one from params', async () => {
    expect(await call({ ...answer, workspaceId: 'ws-spoofed' })).toEqual({ ok: true, taskId: 'rt-1', messageId: 'an-1' });
    expect(daemon.a2aRemoteAnswer).toHaveBeenCalledWith({ taskId: 'rt-1', workspaceId: 'ws-a', pickerId: '0123456789abcdef', option: 2 });
  });

  it('refuses a remote caller, a caller with no resolvable pane, and a missing field', async () => {
    expect(await call(answer, { origin: 'remote' } as RpcContext)).toMatchObject({ ok: false, error: { code: 'NOT_AUTHORIZED' } });
    expect(await call({ ...answer, senderPtyId: 'pty-unknown' })).toMatchObject({ ok: false, error: { code: 'NOT_AUTHORIZED' } });
    expect(await call({ ...answer, senderPtyId: undefined })).toMatchObject({ ok: false, error: { code: 'NOT_AUTHORIZED' } });
    expect(await call({ ...answer, option: '2' })).toMatchObject({ ok: false, error: { code: 'INVALID_ARGUMENT' } });
    expect(daemon.a2aRemoteAnswer).not.toHaveBeenCalled();
  });

  it('a hosted caller answers only from a pane of its own workspace, and an unbound one from none', async () => {
    expect(await call(answer, { origin: 'local', hostedWorkspace: 'ws-other' } as RpcContext)).toMatchObject({ ok: false, error: { code: 'NOT_AUTHORIZED' } });
    expect(await call(answer, { origin: 'local', hostedWorkspace: null } as RpcContext)).toMatchObject({ ok: false, error: { code: 'NOT_AUTHORIZED' } });
    expect(daemon.a2aRemoteAnswer).not.toHaveBeenCalled();
    expect(await call(answer, { origin: 'local', hostedWorkspace: 'ws-a' } as RpcContext)).toMatchObject({ ok: true });
  });
});
