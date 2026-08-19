// #922 — the plugin-host IPC seam.
//
// This is the one place a plugin's workspace binding is established: the host
// component passes the workspace it is SHOWING as its own argument, and this
// handler turns it into a dispatch option that no request envelope can reach.
// The tests below pin that seam from both sides — what reaches the router when
// the host supplies a workspace, and what reaches it when the argument is
// malformed or absent.

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { IPC } from '../../../../shared/constants';
import type { RpcRequest, RpcResponse } from '../../../../shared/rpc';
import type { RpcRouter } from '../../../pipe/RpcRouter';
import { registerPluginHostHandlers } from '../pluginHost.handler';

const handlers = new Map<string, (...args: unknown[]) => Promise<unknown>>();

vi.mock('electron', () => ({
  ipcMain: {
    removeHandler: vi.fn(),
    handle: vi.fn((channel: string, fn: (...args: unknown[]) => Promise<unknown>) => {
      handlers.set(channel, fn);
    }),
  },
}));

type DispatchArgs = [RpcRequest, Record<string, unknown> | undefined];

let dispatch: ReturnType<typeof vi.fn>;

function setup() {
  handlers.clear();
  dispatch = vi.fn(async (): Promise<RpcResponse> => ({ id: 'x', ok: true, result: {} }));
  const router = { dispatch } as unknown as RpcRouter;
  const loader = {
    get: (name: string) =>
      name === 'demo' ? { manifest: { name: 'demo', version: '1.0.0' } } : undefined,
  };
  registerPluginHostHandlers(router, () => loader as never);
  const rpc = handlers.get(IPC.PLUGINS_RPC);
  expect(rpc, 'plugins:rpc handler was never registered').toBeDefined();
  return rpc!;
}

// NOT `beforeEach(setup)`: setup returns the handler, and vitest treats a
// function returned from a hook as its teardown callback — it would then be
// invoked with no arguments after every test.
beforeEach(() => { setup(); });

describe('plugins:rpc host workspace binding', () => {
  it('forwards the host workspace as a dispatch option, not as a param', async () => {
    const rpc = setup();

    await rpc({}, 'demo', 'browser.navigate', { url: 'https://example.test' }, 'ws-host');

    const [request, opts] = dispatch.mock.calls[0] as DispatchArgs;
    expect(opts).toEqual({ firstParty: true, hostedWorkspace: 'ws-host' });
    // The params are forwarded verbatim: the binding is carried beside them, so
    // main can compare what the plugin asked for against where it lives.
    expect(request.params).toEqual({ url: 'https://example.test' });
    expect(request.clientName).toBe('demo');
  });

  it('keeps the plugin from naming its own binding through params', async () => {
    const rpc = setup();

    await rpc({}, 'demo', 'browser.navigate', { hostedWorkspace: 'ws-forged' }, 'ws-host');

    const [request, opts] = dispatch.mock.calls[0] as DispatchArgs;
    expect(opts).toEqual({ firstParty: true, hostedWorkspace: 'ws-host' });
    // Still present in params — the router does not read it there, and
    // stripping it would hide a hostile plugin from the audit trail.
    expect(request.params).toEqual({ hostedWorkspace: 'ws-forged' });
  });

  it.each([undefined, '', '   '])('says "hosted, unbound" rather than going quiet (%p)', async (value) => {
    const rpc = setup();

    await rpc({}, 'demo', 'workspace.current', {}, value);

    const [, opts] = dispatch.mock.calls[0] as DispatchArgs;
    // The key is present with a null value. Omitting it would make this
    // indistinguishable from a caller that is not the plugin host at all, and
    // the browser lane would then let the plugin name its own workspace.
    expect(opts).toEqual({ firstParty: true, hostedWorkspace: null });
  });

  it('refuses a non-string host workspace instead of coercing it', async () => {
    const rpc = setup();

    await expect(rpc({}, 'demo', 'workspace.current', {}, { id: 'ws-host' }))
      .rejects.toThrow(/host workspace/i);
    expect(dispatch).not.toHaveBeenCalled();
  });
});
