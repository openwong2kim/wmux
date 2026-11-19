// a2a.remote.approve on main's pipe: who may answer, which arguments pass, and what reaches the daemon.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { approveArgs, registerRemoteApprovalRpc } from '../remoteApproval.rpc';
import type { RpcContext } from '../../../../shared/rpc';

type Handler = (params: Record<string, unknown>, ctx?: RpcContext) => Promise<unknown>;

const local = { origin: 'local' } as RpcContext;
const approve = { taskId: 'rt-1', promptId: '0123456789abcdef', decision: 'allow', senderPtyId: 'pty-a' };

let handlers: Map<string, Handler>;
let daemon: { isConnected: boolean; a2aRemoteApprove: ReturnType<typeof vi.fn> };

beforeEach(() => {
  handlers = new Map();
  daemon = { isConnected: true, a2aRemoteApprove: vi.fn(async () => ({ ok: true, taskId: 'rt-1', messageId: 'ap-1', pending: true })) };
  const router = { register: (m: string, h: Handler) => handlers.set(m, h) };
  registerRemoteApprovalRpc(router as never, () => null, {
    getDaemonClient: () => daemon as never,
    resolveCaller: async (pty) => (pty === 'pty-a' ? { workspaceId: 'ws-a' } : null),
  });
});

const call = (p: Record<string, unknown>, ctx: RpcContext = local) =>
  handlers.get('a2a.remote.approve')!(p, ctx) as Promise<{ ok?: boolean; error?: { code: string } }>;

describe('approveArgs', () => {
  it('takes a task id, a 16-hex prompt id and allow or deny; nothing else', () => {
    expect(approveArgs({ taskId: ' rt-1 ', promptId: '0123456789abcdef', decision: 'deny' })).toEqual({ taskId: 'rt-1', promptId: '0123456789abcdef', decision: 'deny' });
    for (const bad of [
      { promptId: '0123456789abcdef', decision: 'allow' },
      { taskId: 'rt-1', promptId: '0123456789ABCDEF', decision: 'allow' },
      { taskId: 'rt-1', promptId: '0123456789abcde', decision: 'allow' },
      { taskId: 'rt-1', promptId: '0123456789abcdef', decision: 'yes' },
      { taskId: 'rt-1', promptId: '0123456789abcdef', decision: 'allow always' },
      { taskId: 'rt-1', promptId: '0123456789abcdef' },
    ]) {
      expect(typeof approveArgs(bad)).toBe('string');
    }
  });
});

describe('a2a.remote.approve', () => {
  it('passes the workspace the caller\'s pane resolves to, never one from params', async () => {
    expect(await call({ ...approve, workspaceId: 'ws-spoofed' })).toMatchObject({ ok: true, messageId: 'ap-1' });
    expect(daemon.a2aRemoteApprove).toHaveBeenCalledWith({ taskId: 'rt-1', workspaceId: 'ws-a', promptId: '0123456789abcdef', decision: 'allow' });
  });

  it('refuses a remote caller, a caller with no resolvable pane, and a bad argument, before the daemon', async () => {
    expect(await call(approve, { origin: 'remote' } as RpcContext)).toMatchObject({ ok: false, error: { code: 'NOT_AUTHORIZED' } });
    expect(await call({ ...approve, senderPtyId: 'pty-unknown' })).toMatchObject({ ok: false, error: { code: 'NOT_AUTHORIZED' } });
    expect(await call({ ...approve, senderPtyId: undefined })).toMatchObject({ ok: false, error: { code: 'NOT_AUTHORIZED' } });
    expect(await call({ ...approve, decision: 'approve' })).toMatchObject({ ok: false, error: { code: 'INVALID_ARGUMENT' } });
    expect(await call({ ...approve, promptId: 'p-1' })).toMatchObject({ ok: false, error: { code: 'INVALID_ARGUMENT' } });
    expect(daemon.a2aRemoteApprove).not.toHaveBeenCalled();
  });

  it('a caller bound to a workspace (a claim, a commander token) acts only from a pane of it; a stale claim from none', async () => {
    for (const ctx of [
      { origin: 'local', workspaceClaim: { kind: 'bound', workspaceId: 'ws-b' } },
      { origin: 'local', workspaceClaim: { kind: 'stale' } },
      { origin: 'local', commanderWorkspace: 'ws-b' },
    ] as RpcContext[]) {
      expect(await call(approve, ctx)).toMatchObject({ ok: false, error: { code: 'NOT_AUTHORIZED' } });
    }
    expect(daemon.a2aRemoteApprove).not.toHaveBeenCalled();
    // In the words the MCP server drops a stale identity on.
    expect(JSON.stringify(await call(approve, { origin: 'local', workspaceClaim: { kind: 'bound', workspaceId: 'ws-b' } } as RpcContext))).toMatch(/not owned by workspace ws-b/);
    expect(JSON.stringify(await call(approve, { origin: 'local', workspaceClaim: { kind: 'stale' } } as RpcContext))).toMatch(/the workspace you claimed is gone/);
    expect(await call(approve, { origin: 'local', workspaceClaim: { kind: 'bound', workspaceId: 'ws-a' } } as RpcContext)).toMatchObject({ ok: true });
    expect(await call(approve, { origin: 'local', commanderWorkspace: 'ws-a' } as RpcContext)).toMatchObject({ ok: true });
  });

  it('a hosted caller answers only from a pane of its own workspace, and an unbound one from none', async () => {
    expect(await call(approve, { origin: 'local', hostedWorkspace: 'ws-other' } as RpcContext)).toMatchObject({ ok: false, error: { code: 'NOT_AUTHORIZED' } });
    expect(await call(approve, { origin: 'local', hostedWorkspace: null } as RpcContext)).toMatchObject({ ok: false, error: { code: 'NOT_AUTHORIZED' } });
    expect(daemon.a2aRemoteApprove).not.toHaveBeenCalled();
    expect(await call(approve, { origin: 'local', hostedWorkspace: 'ws-a' } as RpcContext)).toMatchObject({ ok: true });
  });

  it('with the background service away: UNAVAILABLE, nothing sent', async () => {
    daemon.isConnected = false;
    expect(await call(approve)).toMatchObject({ ok: false, error: { code: 'UNAVAILABLE' } });
    expect(daemon.a2aRemoteApprove).not.toHaveBeenCalled();
  });
});
