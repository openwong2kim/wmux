// Security regression coverage for source-qualified privileged client names.
// A trusted iframe plugin can share a clientName with a bundled wire client,
// but only PipeServer's positive, non-envelope marker may enter the curated
// first-party or internal-CLI allowlist lanes.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  PluginIdentityRecord,
  RpcContext,
  RpcRequest,
  RpcResponse,
} from '../../../shared/rpc';
import {
  __resetConfiguredFirstPartyClientsForTests,
  setConfiguredFirstPartyClients,
} from '../../mcp/firstParty';
import { RpcRouter } from '../RpcRouter';

function approved(name: string, declaredCapabilities = ['ui.sidebar']): PluginIdentityRecord {
  return {
    name,
    status: 'trusted',
    declaredCapabilities,
    firstSeen: 1000,
    lastSeen: 2000,
  };
}

type Handler = (
  params: Record<string, unknown>,
  ctx?: RpcContext,
) => Promise<unknown>;
type DispatchOptions = NonNullable<Parameters<RpcRouter['dispatch']>[1]>;

let router: RpcRouter;
let records: Map<string, PluginIdentityRecord>;
let surfaceNewHandler: Handler;
let workspaceNewHandler: Handler;
let workspaceCurrentHandler: Handler;
let systemIdentifyHandler: Handler;

beforeEach(() => {
  __resetConfiguredFirstPartyClientsForTests();
  records = new Map<string, PluginIdentityRecord>();
  router = new RpcRouter();
  surfaceNewHandler = vi.fn<Handler>(async () => ({ id: 'surface-2' }));
  workspaceNewHandler = vi.fn<Handler>(async () => ({ id: 'workspace-2' }));
  workspaceCurrentHandler = vi.fn<Handler>(async () => ({ id: 'workspace-1' }));
  systemIdentifyHandler = vi.fn<Handler>(async () => ({ name: 'wmux' }));
  router.register('surface.new', surfaceNewHandler);
  router.register('workspace.new', workspaceNewHandler);
  router.register('workspace.current', workspaceCurrentHandler);
  router.register('system.identify', systemIdentifyHandler);
  router.setTrustLookup(async (name) => records.get(name));
  router.setEnforcementMode('enforce');
});

afterEach(() => {
  __resetConfiguredFirstPartyClientsForTests();
});

describe('RpcRouter dispatch provenance', () => {
  it('marks the renderer operator distinctly while preserving firstParty semantics', async () => {
    let seen: RpcContext | undefined;
    router.register('system.identify', async (_params, ctx) => {
      seen = ctx;
      return { name: 'wmux' };
    });

    const response = await router.dispatch(
      { id: 'operator', method: 'system.identify', params: {} },
      { operator: true },
    );

    expect(response.ok).toBe(true);
    expect(seen).toMatchObject({
      origin: 'local',
      operator: true,
      firstParty: true,
    });
    expect(seen?.externalWire).toBeUndefined();
  });

  it.each([
    ['compiled first-party', 'claude-code', 'surface.new', false],
    ['configured first-party', 'hermes-agent', 'surface.new', true],
    ['internal CLI', 'wmux-cli', 'workspace.new', false],
  ] as const)(
    'rejects an approved iframe collision with the %s lane before its handler',
    async (_label, clientName, method, configureName) => {
      if (configureName) setConfiguredFirstPartyClients([clientName]);
      records.set(clientName, approved(clientName));

      const response = await router.dispatch(
        { id: `iframe-${clientName}`, method, params: {}, clientName },
        { firstParty: true },
      );

      expect(response.ok).toBe(false);
      if (method === 'workspace.new') {
        expect(workspaceNewHandler).not.toHaveBeenCalled();
      } else {
        expect(surfaceNewHandler).not.toHaveBeenCalled();
      }
    },
  );

  it('keeps ordinary declared-capability access for a colliding iframe name', async () => {
    records.set(
      'claude-code',
      approved('claude-code', ['ui.sidebar', 'workspace.read']),
    );

    const response = await router.dispatch(
      {
        id: 'iframe-declared',
        method: 'workspace.current',
        params: {},
        clientName: 'claude-code',
      },
      { firstParty: true },
    );

    expect(response.ok).toBe(true);
    expect(workspaceCurrentHandler).toHaveBeenCalledOnce();
    expect(surfaceNewHandler).not.toHaveBeenCalled();
  });

  it('preserves legitimate compiled, configured, and CLI calls on the local wire', async () => {
    setConfiguredFirstPartyClients(['hermes-agent']);
    for (const [clientName, method] of [
      ['claude-code', 'surface.new'],
      ['hermes-agent', 'surface.new'],
      ['wmux-cli', 'workspace.new'],
    ] as const) {
      const response = await router.dispatch(
        { id: `wire-${clientName}`, method, params: {}, clientName },
        { externalWire: true },
      );
      expect(response.ok, `${clientName} should retain its wire allowlist`).toBe(true);
    }
    expect(surfaceNewHandler).toHaveBeenCalledTimes(2);
    expect(workspaceNewHandler).toHaveBeenCalledOnce();
  });

  it('ignores forged provenance fields in the raw request body', async () => {
    records.set('claude-code', approved('claude-code'));
    const forged = {
      id: 'raw-forgery',
      method: 'surface.new',
      params: {},
      clientName: 'claude-code',
      externalWire: true,
    } as unknown as RpcRequest;

    const response = await router.dispatch(forged);

    expect(response.ok).toBe(false);
    expect(surfaceNewHandler).not.toHaveBeenCalled();
  });

  it('ignores a forged operator marker in the raw request body', async () => {
    let seen: RpcContext | undefined;
    router.register('system.identify', async (_params, ctx) => {
      seen = ctx;
      return { name: 'wmux' };
    });
    const forged = {
      id: 'raw-operator-forgery',
      method: 'system.identify',
      params: {},
      operator: true,
    } as unknown as RpcRequest;

    const response = await router.dispatch(forged);

    expect(response.ok).toBe(true);
    expect(seen?.operator).toBeUndefined();
    expect(seen?.firstParty).toBe(false);
  });

  it('ignores raw firstParty/externalWire fields on a legitimate wire call', async () => {
    const request = {
      id: 'raw-fields-on-wire',
      method: 'surface.new',
      params: {},
      clientName: 'claude-code',
      firstParty: true,
      externalWire: false,
    } as unknown as RpcRequest;

    const response = await router.dispatch(request, { externalWire: true });

    expect(response.ok).toBe(true);
    expect(surfaceNewHandler).toHaveBeenCalledOnce();
  });

  it.each([
    { firstParty: true, externalWire: true },
    { operator: true, externalWire: true },
    { operator: true, firstParty: true },
  ])('hard-rejects conflicting dispatch options even in shadow mode: %o', async (conflictingShape) => {
    const trustLookup = vi.fn(async () => approved('claude-code'));
    router.setTrustLookup(trustLookup);
    router.setEnforcementMode('shadow');
    const conflicting = conflictingShape as unknown as DispatchOptions;

    const response = await router.dispatch(
      {
        id: 'conflicting-source',
        method: 'system.identify',
        params: {},
        clientName: 'claude-code',
      },
      conflicting,
    );

    expect(response).toEqual({
      id: 'conflicting-source',
      ok: false,
      error: 'Invalid RPC dispatch provenance',
    });
    expect(trustLookup).not.toHaveBeenCalled();
    expect(systemIdentifyHandler).not.toHaveBeenCalled();
  });

  it('threads the plugin host workspace onto the context it dispatches (#922)', async () => {
    let seen: RpcContext | undefined;
    router.register('system.identify', async (_params, ctx) => {
      seen = ctx;
      return { name: 'wmux' };
    });

    const response = await router.dispatch(
      {
        id: 'hosted',
        method: 'system.identify',
        params: { workspaceId: 'ws-other' },
        clientName: 'hello-panel',
      },
      { firstParty: true, hostedWorkspace: 'ws-host' },
    );

    expect(response.ok).toBe(true);
    // The option wins over anything the request carried: the params still say
    // 'ws-other' and the context says 'ws-host'. Keeping both visible is the
    // point — the handler decides, and it can only decide if it can tell them
    // apart.
    expect(seen?.hostedWorkspace).toBe('ws-host');
    expect(seen?.firstParty).toBe(true);
  });

  it('never lets a request envelope populate the host workspace (#922)', async () => {
    let seen: RpcContext | undefined;
    router.register('system.identify', async (_params, ctx) => {
      seen = ctx;
      return { name: 'wmux' };
    });

    const response = await router.dispatch(
      {
        id: 'forged',
        method: 'system.identify',
        params: { hostedWorkspace: 'ws-forged' },
        clientName: 'hello-panel',
        // A wire client is free to put this on the envelope; it is not a
        // field the router reads.
        ...({ hostedWorkspace: 'ws-forged' } as Record<string, unknown>),
      } as RpcRequest,
      { externalWire: true },
    );

    expect(response.ok).toBe(true);
    expect(seen?.hostedWorkspace).toBeUndefined();
  });

  it('rejects a host workspace supplied off the plugin-host lane (#922)', async () => {
    for (const lane of [{ externalWire: true }, { operator: true }] as const) {
      const response = await router.dispatch(
        {
          id: 'hosted-off-lane',
          method: 'system.identify',
          params: {},
          clientName: 'claude-code',
        },
        { ...lane, hostedWorkspace: 'ws-host' } as unknown as DispatchOptions,
      );

      // Loud, not lenient: dropping the field would leave a context that reads
      // as merely unscoped, which is the state this lane exists to end.
      expect(response).toEqual({
        id: 'hosted-off-lane',
        ok: false,
        error: 'Invalid RPC dispatch provenance',
      });
    }
    expect(systemIdentifyHandler).not.toHaveBeenCalled();
  });

  it('does not inherit external-wire provenance into an unmarked nested dispatch', async () => {
    records.set('claude-code', approved('claude-code'));
    router.register('system.identify', async () =>
      router.dispatch({
        id: 'nested-privileged',
        method: 'surface.new',
        params: {},
        clientName: 'claude-code',
      }),
    );

    const outer = await router.dispatch(
      {
        id: 'outer-wire',
        method: 'system.identify',
        params: {},
        clientName: 'claude-code',
      },
      { externalWire: true },
    );

    expect(outer.ok).toBe(true);
    if (!outer.ok) throw new Error('expected the outer dispatch to succeed');
    const nested = outer.result as RpcResponse;
    expect(nested.ok).toBe(false);
    expect(surfaceNewHandler).not.toHaveBeenCalled();
  });
});
