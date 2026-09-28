import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserWindow } from 'electron';
import type { RpcRouter } from '../../RpcRouter';
import type { RpcContext } from '../../../../shared/rpc';
import { registerCompanyRpc } from '../company.rpc';

const { sendToRendererMock } = vi.hoisted(() => ({ sendToRendererMock: vi.fn() }));
vi.mock('../_bridge', () => ({ sendToRenderer: sendToRendererMock }));

type Handler = (params: Record<string, unknown>, ctx?: RpcContext) => unknown;

function capture(method: string): Handler {
  let handler: Handler | undefined;
  const router = {
    register: (m: string, fn: Handler) => {
      if (m === method) handler = fn;
    },
  };
  registerCompanyRpc(router as unknown as RpcRouter, () => ({}) as BrowserWindow);
  if (!handler) throw new Error(`${method} not registered`);
  return handler;
}

// The renderer submits a company message itself only when main says the call
// came from the operator's own surface; every other one goes through the
// approval gate. That flag must be main's to set.
const CASES: Array<[string, Record<string, unknown>]> = [
  ['company.broadcast', { message: 'hi' }],
  ['company.sendDept', { deptId: 'd', message: 'hi' }],
  ['company.sendMember', { deptId: 'd', memberId: 'm', message: 'hi' }],
  ['company.a2a.send', { from: 'A', to: 'B', message: 'hi' }],
  ['company.a2a.broadcast', { from: 'A', message: 'hi' }],
  ['company.message', { from: 'A', to: 'B', message: 'hi' }],
];

describe('company delivery methods: operator origin is stamped, never forwarded', () => {
  beforeEach(() => sendToRendererMock.mockReset().mockResolvedValue({ ok: true }));

  it.each(CASES)('%s drops a caller-supplied operatorOrigin', async (method, params) => {
    await capture(method)({ ...params, operatorOrigin: true }, { origin: 'local' } as unknown as RpcContext);
    expect(sendToRendererMock.mock.calls[0]?.[2]).not.toHaveProperty('operatorOrigin');
  });

  it.each(CASES)('%s stamps operatorOrigin for the operator surface', async (method, params) => {
    await capture(method)(params, { origin: 'local', operator: true } as unknown as RpcContext);
    expect(sendToRendererMock.mock.calls[0]?.[2]).toMatchObject({ operatorOrigin: true });
  });
});
