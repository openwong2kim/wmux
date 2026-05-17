// Direct tests for the RpcRouter dispatch + envelope-context plumbing.
// These cover the Phase 2.1 additions: per-request context lift, optional
// handler second arg backwards-compat, and the legacy-contact recorder
// that fires when an RPC arrives without a clientName envelope.

import { describe, expect, it, vi } from 'vitest';
import { RpcRouter } from '../RpcRouter';
import type { RpcContext, RpcMethod } from '../../../shared/rpc';

type HandlerSig = (
  params: Record<string, unknown>,
  ctx?: RpcContext,
) => Promise<unknown>;

function makeRouter() {
  const router = new RpcRouter();
  router.register('pane.list', async () => ({ panes: [] }));
  return router;
}

describe('RpcRouter dispatch envelope', () => {
  it('lifts clientName / clientVersion into the handler context', async () => {
    const router = new RpcRouter();
    const handler = vi.fn<HandlerSig>(async () => 'ok');
    router.register('pane.list', handler);
    await router.dispatch({
      id: 'r-1',
      method: 'pane.list',
      params: {},
      clientName: 'claude-ai',
      clientVersion: '1.2.3',
    });
    const [, ctx] = handler.mock.calls[0];
    expect(ctx?.clientName).toBe('claude-ai');
    expect(ctx?.clientVersion).toBe('1.2.3');
  });

  it('treats whitespace-only envelope fields as absent', async () => {
    const router = new RpcRouter();
    const handler = vi.fn<HandlerSig>(async () => 'ok');
    router.register('pane.list', handler);
    await router.dispatch({
      id: 'r-2',
      method: 'pane.list',
      params: {},
      clientName: '   ',
      clientVersion: '',
    });
    const [, ctx] = handler.mock.calls[0];
    expect(ctx?.clientName).toBeUndefined();
    expect(ctx?.clientVersion).toBeUndefined();
  });

  it('keeps legacy zero-arg / single-arg handlers working (backwards-compat)', async () => {
    const router = new RpcRouter();
    router.register('pane.list', async (params) => ({ echoed: params }));
    const response = await router.dispatch({
      id: 'r-3',
      method: 'pane.list',
      params: { hello: 'world' },
    });
    expect(response.ok).toBe(true);
    if (response.ok) expect(response.result).toEqual({ echoed: { hello: 'world' } });
  });
});

describe('RpcRouter legacy-contact recorder', () => {
  it('fires once per process when the first envelope-less RPC dispatches', async () => {
    const router = makeRouter();
    const recorder = vi.fn();
    router.setLegacyContactRecorder(recorder);

    await router.dispatch({ id: 'r-1', method: 'pane.list', params: {} });
    await router.dispatch({ id: 'r-2', method: 'pane.list', params: {} });
    await router.dispatch({ id: 'r-3', method: 'pane.list', params: {} });

    expect(recorder).toHaveBeenCalledTimes(1);
    expect(recorder).toHaveBeenCalledWith('pane.list');
  });

  it('does not fire when the envelope carries a clientName', async () => {
    const router = makeRouter();
    const recorder = vi.fn();
    router.setLegacyContactRecorder(recorder);

    await router.dispatch({
      id: 'r-1',
      method: 'pane.list',
      params: {},
      clientName: 'claude-ai',
    });
    expect(recorder).not.toHaveBeenCalled();
  });

  it('does not fire for mcp.identify / mcp.declarePermissions (handler owns identity)', async () => {
    const router = new RpcRouter();
    router.register('mcp.identify', async () => ({ ok: true }));
    router.register('mcp.declarePermissions', async () => ({ ok: true }));
    const recorder = vi.fn();
    router.setLegacyContactRecorder(recorder);

    await router.dispatch({ id: 'r-1', method: 'mcp.identify', params: {} });
    await router.dispatch({
      id: 'r-2',
      method: 'mcp.declarePermissions',
      params: {},
    });
    expect(recorder).not.toHaveBeenCalled();
  });

  it('survives a throwing recorder without failing the RPC', async () => {
    // Trust-store writes are best-effort; if the recorder throws, the
    // request itself must still resolve normally.
    const router = makeRouter();
    router.setLegacyContactRecorder(() => {
      throw new Error('disk full');
    });
    const response = await router.dispatch({
      id: 'r-1',
      method: 'pane.list',
      params: {},
    });
    expect(response.ok).toBe(true);
  });

  it('resets the once-flag when the recorder is replaced (test ergonomics)', async () => {
    const router = makeRouter();
    const first = vi.fn();
    router.setLegacyContactRecorder(first);
    await router.dispatch({ id: 'r-1', method: 'pane.list' as RpcMethod, params: {} });
    expect(first).toHaveBeenCalledTimes(1);

    const second = vi.fn();
    router.setLegacyContactRecorder(second);
    await router.dispatch({ id: 'r-2', method: 'pane.list' as RpcMethod, params: {} });
    expect(second).toHaveBeenCalledTimes(1);
  });
});
