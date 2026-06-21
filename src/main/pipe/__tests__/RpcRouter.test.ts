// Direct tests for the RpcRouter dispatch + envelope-context plumbing.
// Covers Phase 2.1 additions (per-request context lift, optional handler
// second arg backwards-compat, legacy-contact recorder) AND the Phase 2.2
// shadow-mode enforcement wiring: trust lookup, would-be rejection
// recording, and the "shadow never blocks" guarantee.

import { describe, expect, it, vi } from 'vitest';
import { RpcRouter } from '../RpcRouter';
import type {
  PluginIdentityRecord,
  RpcContext,
  RpcMethod,
  RpcRejection,
} from '../../../shared/rpc';

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
  it('stamps origin=local on the dispatched context (LanLink PR-1)', async () => {
    const router = new RpcRouter();
    const handler = vi.fn<HandlerSig>(async () => 'ok');
    router.register('pane.list', handler);
    await router.dispatch({ id: 'r-origin', method: 'pane.list', params: {} });
    const [, ctx] = handler.mock.calls[0];
    // The local pipe / loopback router is local by construction; a future
    // LanLink listener is the only path that should ever stamp 'remote'.
    expect(ctx?.origin).toBe('local');
  });

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

// === Phase 2.2 — shadow-mode enforcement ===

function trustRecord(
  overrides: Partial<PluginIdentityRecord> &
    Pick<PluginIdentityRecord, 'name' | 'status'>,
): PluginIdentityRecord {
  return { firstSeen: 1000, lastSeen: 2000, ...overrides };
}

describe('RpcRouter shadow-mode enforcement wiring', () => {
  it('queries trust lookup only for envelope-carrying requests', async () => {
    const router = makeRouter();
    const lookup = vi.fn(async () => undefined);
    router.setTrustLookup(lookup);

    await router.dispatch({ id: 'r-1', method: 'pane.list', params: {} });
    expect(lookup).not.toHaveBeenCalled();

    await router.dispatch({
      id: 'r-2',
      method: 'pane.list',
      params: {},
      clientName: 'p1',
    });
    expect(lookup).toHaveBeenCalledWith('p1');
  });

  it('proceeds to handler even when enforcer would reject (shadow does not block)', async () => {
    const router = new RpcRouter();
    const handler = vi.fn(async () => 'handler-ran');
    router.register('pane.list', handler);
    router.setTrustLookup(async () =>
      trustRecord({
        name: 'p1',
        status: 'trusted',
        declaredCapabilities: ['meta.read'],
      }),
    );
    const sink = vi.fn();
    router.setShadowRejectionSink(sink);

    const response = await router.dispatch({
      id: 'r-1',
      method: 'pane.list',
      params: {},
      clientName: 'p1',
    });
    expect(handler).toHaveBeenCalledTimes(1);
    expect(response.ok).toBe(true);
    if (response.ok) expect(response.result).toBe('handler-ran');
    expect(sink).toHaveBeenCalledTimes(1);
    const sinkCall = sink.mock.calls[0][0] as {
      clientName: string | undefined;
      method: RpcMethod;
      rejection: RpcRejection;
    };
    expect(sinkCall.method).toBe('pane.list');
    expect(sinkCall.clientName).toBe('p1');
    expect(sinkCall.rejection.reason).toBe('capability-not-declared');
  });

  it('does not log when the enforcer allows', async () => {
    const router = new RpcRouter();
    router.register('pane.list', async () => ({ panes: [] }));
    router.setTrustLookup(async () =>
      trustRecord({
        name: 'p1',
        status: 'trusted',
        declaredCapabilities: ['pane.read'],
      }),
    );
    const sink = vi.fn();
    router.setShadowRejectionSink(sink);

    await router.dispatch({
      id: 'r-1',
      method: 'pane.list',
      params: {},
      clientName: 'p1',
    });
    expect(sink).not.toHaveBeenCalled();
  });

  it('treats clientName-stamped requests with no trust record as unconfirmed (shadow logs, handler still runs)', async () => {
    const router = makeRouter();
    router.setTrustLookup(async () => undefined);
    const sink = vi.fn();
    router.setShadowRejectionSink(sink);

    const response = await router.dispatch({
      id: 'r-1',
      method: 'pane.list',
      params: {},
      clientName: 'fresh-plugin',
    });
    expect(response.ok).toBe(true);
    expect(sink).toHaveBeenCalledTimes(1);
    const r = (sink.mock.calls[0][0] as { rejection: RpcRejection }).rejection;
    expect(r.reason).toBe('identity-status');
    if (r.reason === 'identity-status') expect(r.status).toBe('unconfirmed');
  });

  it('rejects identity-status=denied in shadow (handler still runs)', async () => {
    const router = makeRouter();
    router.setTrustLookup(async () =>
      trustRecord({
        name: 'p1',
        status: 'denied',
        declaredCapabilities: ['pane.read'],
      }),
    );
    const sink = vi.fn();
    router.setShadowRejectionSink(sink);

    const response = await router.dispatch({
      id: 'r-1',
      method: 'pane.list',
      params: {},
      clientName: 'p1',
    });
    expect(response.ok).toBe(true); // shadow mode never blocks
    const r = (sink.mock.calls[0][0] as { rejection: RpcRejection }).rejection;
    expect(r.reason).toBe('identity-status');
    if (r.reason === 'identity-status') expect(r.status).toBe('denied');
  });

  it('does not log identity bootstrap RPCs (capability: null in the map)', async () => {
    const router = new RpcRouter();
    router.register('mcp.identify', async () => ({ ok: true }));
    router.setTrustLookup(async () => undefined);
    const sink = vi.fn();
    router.setShadowRejectionSink(sink);

    await router.dispatch({
      id: 'r-1',
      method: 'mcp.identify',
      params: {},
      clientName: 'fresh-plugin',
    });
    expect(sink).not.toHaveBeenCalled();
  });

  it('swallows trust-lookup errors and treats them as no-record (shadow still runs)', async () => {
    const router = makeRouter();
    router.setTrustLookup(async () => {
      throw new Error('disk read failed');
    });
    const sink = vi.fn();
    router.setShadowRejectionSink(sink);

    const response = await router.dispatch({
      id: 'r-1',
      method: 'pane.list',
      params: {},
      clientName: 'p1',
    });
    expect(response.ok).toBe(true);
    // Treated as no-record → unconfirmed → shadow log fires.
    expect(sink).toHaveBeenCalledTimes(1);
  });

  it('swallows shadow-sink errors so dispatch never fails because of telemetry', async () => {
    const router = makeRouter();
    router.setTrustLookup(async () => undefined);
    router.setShadowRejectionSink(() => {
      throw new Error('disk full');
    });
    const response = await router.dispatch({
      id: 'r-1',
      method: 'pane.list',
      params: {},
      clientName: 'p1',
    });
    expect(response.ok).toBe(true);
  });
});

describe('RpcRouter legacy traffic counter', () => {
  it('ticks on every envelope-less RPC (not process-once like the trust recorder)', async () => {
    const router = makeRouter();
    const counter = { record: vi.fn() };
    router.setLegacyTrafficCounter(counter);

    await router.dispatch({ id: 'r-1', method: 'pane.list', params: {} });
    await router.dispatch({ id: 'r-2', method: 'pane.list', params: {} });
    await router.dispatch({ id: 'r-3', method: 'pane.list', params: {} });

    expect(counter.record).toHaveBeenCalledTimes(3);
    expect(counter.record.mock.calls.map((c) => c[0])).toEqual([
      'pane.list',
      'pane.list',
      'pane.list',
    ]);
  });

  it('does NOT tick for envelope-carrying requests', async () => {
    const router = makeRouter();
    const counter = { record: vi.fn() };
    router.setLegacyTrafficCounter(counter);

    await router.dispatch({
      id: 'r-1',
      method: 'pane.list',
      params: {},
      clientName: 'p1',
    });
    expect(counter.record).not.toHaveBeenCalled();
  });

  it('does NOT tick for identity-bootstrap RPCs (handler owns identity recording)', async () => {
    const router = new RpcRouter();
    router.register('mcp.identify', async () => ({ ok: true }));
    router.register('mcp.declarePermissions', async () => ({ ok: true }));
    const counter = { record: vi.fn() };
    router.setLegacyTrafficCounter(counter);

    await router.dispatch({ id: 'r-1', method: 'mcp.identify', params: {} });
    await router.dispatch({
      id: 'r-2',
      method: 'mcp.declarePermissions',
      params: {},
    });
    expect(counter.record).not.toHaveBeenCalled();
  });

  it('runs in parallel with the process-once trust recorder (both fire on first call)', async () => {
    const router = makeRouter();
    const recorder = vi.fn();
    const counter = { record: vi.fn() };
    router.setLegacyContactRecorder(recorder);
    router.setLegacyTrafficCounter(counter);

    await router.dispatch({ id: 'r-1', method: 'pane.list', params: {} });
    expect(recorder).toHaveBeenCalledTimes(1);
    expect(counter.record).toHaveBeenCalledTimes(1);

    // Second call: recorder is process-once (silent), counter keeps ticking.
    await router.dispatch({ id: 'r-2', method: 'pane.list', params: {} });
    expect(recorder).toHaveBeenCalledTimes(1);
    expect(counter.record).toHaveBeenCalledTimes(2);
  });

  it('survives a throwing counter without failing the RPC', async () => {
    const router = makeRouter();
    router.setLegacyTrafficCounter({
      record: () => {
        throw new Error('counter blew up');
      },
    });
    const response = await router.dispatch({
      id: 'r-1',
      method: 'pane.list',
      params: {},
    });
    expect(response.ok).toBe(true);
  });
});
