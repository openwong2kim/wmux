import { describe, expect, it, vi } from 'vitest';
import type { RpcRouter } from '../../RpcRouter';
import type { RpcContext } from '../../../../shared/rpc';
import { ComputerError, parseComputerErrorMessage } from '../../../../shared/computer/errors';
import type { ComputerService } from '../../../computer/ComputerService';
import { registerComputerRpc } from '../computer.rpc';

type Handler = (params: Record<string, unknown>, ctx?: RpcContext) => Promise<unknown>;

// Which workspace owns each pane right now, as main's resolver would answer.
const INSTANCE_1 = '11111111-2222-4333-8444-555555555555';
const INSTANCE_2 = '66666666-7777-4888-9999-aaaaaaaaaaaa';
const PANES: Record<string, string> = { 'pty-a1': 'ws-a', 'pty-a2': 'ws-a', 'pty-b1': 'ws-b' };

function setup(service: Partial<ComputerService>) {
  const handlers = new Map<string, Handler>();
  const router = { register: (method: string, handler: Handler) => handlers.set(method, handler) } as unknown as RpcRouter;
  const getService = vi.fn(() => service as ComputerService);
  registerComputerRpc(router, getService, async (ptyId) => {
    if (ptyId === 'pty-throws') throw new Error('renderer gone');
    return PANES[ptyId] ?? null;
  });
  const call = (method: string, params: Record<string, unknown>, ctx?: Partial<RpcContext>) =>
    handlers.get(method)!(params, ctx as RpcContext);
  return { handlers, call, getService };
}

async function errorOf(promise: Promise<unknown>) {
  try {
    await promise;
    return null;
  } catch (err) {
    return parseComputerErrorMessage((err as Error).message);
  }
}

describe('computer.rpc', () => {
  it('registers exactly the computer.* methods', () => {
    const { handlers, getService } = setup({});
    expect([...handlers.keys()].sort()).toEqual([
      'computer.act',
      'computer.capabilities',
      'computer.getAppState',
      'computer.listApps',
      'computer.listWindows',
    ]);
    // Nothing is constructed until a call arrives.
    expect(getService).not.toHaveBeenCalled();
  });

  it('keys identity on the caller pane or process, so agents of one kind never share grants', async () => {
    const getAppState = vi.fn(async () => ({}));
    const { call } = setup({ getAppState } as never);
    const as = (identity: Record<string, string>, ctx: Partial<RpcContext> = {}) =>
      call('computer.getAppState', { app: 'Notepad', workspaceId: 'ws-forged', ...identity }, { clientName: 'claude-code', ...ctx });
    await as({ senderPtyId: 'pty-a1' });
    await as({ senderPtyId: 'pty-a2' }); // split pane of the same workspace
    await as({ senderPtyId: 'pty-b1' }); // another workspace
    await as({ senderPtyId: 'pty-a1' }, { workspaceClaim: { kind: 'bound', workspaceId: 'ws-a' } });
    await as({}, { commanderWorkspace: 'ws-a' });
    await as({ callerInstance: INSTANCE_1 }); // two processes with no pane
    await as({ callerInstance: INSTANCE_2 });
    await as({ callerInstance: INSTANCE_1 }, { workspaceClaim: { kind: 'bound', workspaceId: 'ws-c' } });
    const keys = getAppState.mock.calls.map((c) => (c as unknown[])[0] as string);
    expect(keys.slice(0, 5)).toEqual([
      'claude-code @ ws-a/pty-a1',
      'claude-code @ ws-a/pty-a2',
      'claude-code @ ws-b/pty-b1',
      'claude-code @ ws-a/pty-a1',
      'claude-code @ ws-a/commander',
    ]);
    expect(keys[5]).toMatch(/^claude-code \(no pane\) #[0-9a-f]{12}$/);
    expect(keys[6]).toMatch(/^claude-code \(no pane\) #[0-9a-f]{12}$/);
    expect(keys[5]).not.toBe(keys[6]);
    // The key never carries the raw instance id another agent could present.
    expect(keys[5]).not.toContain(INSTANCE_1.slice(0, 8));
    expect(keys[7]).toMatch(/^claude-code @ ws-c #[0-9a-f]{12}$/);
  });

  it('refuses a caller it cannot pin to a pane or process instead of sharing an identity', async () => {
    const getAppState = vi.fn(async () => ({}));
    const { call } = setup({ getAppState } as never);
    const codeOf = async (params: Record<string, unknown>, ctx: Partial<RpcContext> = { clientName: 'c' }) =>
      (await errorOf(call('computer.getAppState', { app: 'x', ...params }, ctx)))?.code;
    expect(await codeOf({ senderPtyId: 'pty-unknown' })).toBe('invalid_argument');
    expect(await codeOf({ senderPtyId: 'pty-throws' })).toBe('invalid_argument');
    expect(await codeOf({})).toBe('invalid_argument');
    expect(await codeOf({ callerInstance: 'not-a-uuid' })).toBe('invalid_argument');
    expect(await codeOf({ senderPtyId: 'pty-b1' }, { clientName: 'c', workspaceClaim: { kind: 'bound', workspaceId: 'ws-a' } }))
      .toBe('invalid_argument');
    expect(await codeOf({ callerInstance: INSTANCE_1 }, { clientName: 'c', hostedWorkspace: 'ws-a' })).toBe('invalid_argument');
    expect(getAppState).not.toHaveBeenCalled();
  });

  it('lists apps without pane resolution', async () => {
    const listApps = vi.fn(async () => ({ apps: [] }));
    const { call } = setup({ listApps } as never);
    await call('computer.listApps', { senderPtyId: 'pty-unknown' }, { clientName: 'c' });
    expect(listApps).toHaveBeenCalled();
  });

  it('refuses an anonymous caller and a stale workspace claim', async () => {
    const { call } = setup({ getAppState: vi.fn() } as never);
    expect((await errorOf(call('computer.getAppState', { app: 'x' }, {})))?.code).toBe('invalid_argument');
    expect((await errorOf(call('computer.getAppState', { app: 'x' }, {
      clientName: 'c',
      workspaceClaim: { kind: 'stale' },
    })))?.code).toBe('invalid_argument');
  });

  it('only accepts control actions on computer.act', async () => {
    const control = vi.fn(async () => ({ method: 'synthetic', verification: 'unverified' }));
    const { call } = setup({ control } as never);
    expect((await errorOf(call('computer.act', { action: 'getAppState', senderPtyId: 'pty-a1' }, { clientName: 'c' })))?.code).toBe('invalid_argument');
    await call('computer.act', { action: 'click', snapshotId: 's1', index: 2, senderPtyId: 'pty-a1' }, { clientName: 'c' });
    expect(control).toHaveBeenCalledWith('c @ ws-a/pty-a1', { action: 'click', snapshotId: 's1', index: 2 });
  });

  it('encodes service errors as [code] message and wraps unknown ones as internal', async () => {
    const { call } = setup({
      listApps: vi.fn(async () => { throw new ComputerError('permission_missing', 'accessibility'); }),
      capabilities: vi.fn(async () => { throw new Error('boom'); }),
    } as never);
    expect(await errorOf(call('computer.listApps', {}, { clientName: 'c' }))).toEqual({ code: 'permission_missing', message: 'accessibility' });
    expect(await errorOf(call('computer.capabilities', {}, { clientName: 'c' }))).toEqual({ code: 'internal', message: 'boom' });
  });
});
