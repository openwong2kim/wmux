import { describe, expect, it, vi } from 'vitest';
import type { RpcRouter } from '../../RpcRouter';
import type { RpcContext } from '../../../../shared/rpc';
import { ComputerError, parseComputerErrorMessage } from '../../../../shared/computer/errors';
import type { ComputerService } from '../../../computer/ComputerService';
import { registerComputerRpc } from '../computer.rpc';

type Handler = (params: Record<string, unknown>, ctx?: RpcContext) => Promise<unknown>;

function setup(service: Partial<ComputerService>) {
  const handlers = new Map<string, Handler>();
  const router = { register: (method: string, handler: Handler) => handlers.set(method, handler) } as unknown as RpcRouter;
  const getService = vi.fn(() => service as ComputerService);
  registerComputerRpc(router, getService);
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

  it('keys identity on the client name, narrowed by a verified workspace claim', async () => {
    const getAppState = vi.fn(async () => ({}));
    const { call } = setup({ getAppState } as never);
    await call('computer.getAppState', { app: 'Notepad' }, { clientName: 'claude-code' });
    await call('computer.getAppState', { app: 'Notepad', workspaceId: 'ws-forged' }, {
      clientName: 'claude-code',
      workspaceClaim: { kind: 'bound', workspaceId: 'ws-1' },
    });
    expect(getAppState.mock.calls.map((c) => (c as unknown[])[0])).toEqual(['claude-code', 'claude-code @ ws-1']);
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
    expect((await errorOf(call('computer.act', { action: 'getAppState' }, { clientName: 'c' })))?.code).toBe('invalid_argument');
    await call('computer.act', { action: 'click', snapshotId: 's1', index: 2 }, { clientName: 'c' });
    expect(control).toHaveBeenCalledWith('c', { action: 'click', snapshotId: 's1', index: 2 });
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
