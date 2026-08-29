// #922 PR2 — the dispatch-level hosted workspace binding.
//
// Two layers, tested separately on purpose:
//   1. the pure decision function, which is where the read/write seam and the
//      fail-closed unbound case live;
//   2. the same rules through `RpcRouter.dispatch`, which is where the params
//      the handler actually receives are decided, and where a wire caller must
//      be provably untouched.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  PluginIdentityRecord,
  RpcContext,
  RpcMethod,
  RpcResponse,
} from '../../../shared/rpc';
import type { HostedScopeAuditInput } from '../../audit/shadowRejectionLog';
import {
  HOSTED_BOUND_METHODS,
  hostedConfinement,
  hostedWorkspaceBinding,
} from '../hostedWorkspaceBinding';
import { CAPABILITY_EFFECT } from '../../mcp/methodCapabilityMap';
import { listKnownCapabilities } from '../../mcp/permissionGrammar';
import { RpcRouter } from '../RpcRouter';

const HOST_WS = 'ws-host';
const OTHER_WS = 'ws-victim';

function hostedCtx(hostedWorkspace: string | null): RpcContext {
  return {
    origin: 'local',
    firstParty: true,
    hostedWorkspace,
    clientName: 'hello-panel',
  };
}

describe('hostedWorkspaceBinding — decision', () => {
  it('leaves a wire caller untouched even on a covered method', () => {
    const decision = hostedWorkspaceBinding(
      'pane.list',
      { workspaceId: OTHER_WS },
      { origin: 'local', externalWire: true, clientName: 'some-mcp' },
    );
    expect(decision).toEqual({ kind: 'untouched' });
  });

  it('leaves the renderer operator untouched — it may act across workspaces', () => {
    const decision = hostedWorkspaceBinding(
      'pane.split',
      { workspaceId: OTHER_WS },
      { origin: 'local', operator: true, firstParty: true },
    );
    expect(decision).toEqual({ kind: 'untouched' });
  });

  it('leaves a hosted caller untouched on a method outside the covered set', () => {
    // `events.poll` resolves its own hosted scope per event class (#959).
    // Injecting workspaceId here would narrow its lifecycle firehose.
    const decision = hostedWorkspaceBinding(
      'events.poll',
      { workspaceId: OTHER_WS },
      hostedCtx(HOST_WS),
    );
    expect(decision).toEqual({ kind: 'untouched' });
  });

  it('resolves an omitted workspaceId to the binding on a read', () => {
    const decision = hostedWorkspaceBinding('pane.list', {}, hostedCtx(HOST_WS));
    expect(decision).toEqual({
      kind: 'bound',
      params: { workspaceId: HOST_WS },
      hostedWorkspaceId: HOST_WS,
    });
  });

  it('resolves an omitted workspaceId to the binding on a write too', () => {
    const decision = hostedWorkspaceBinding(
      'pane.split',
      { paneId: 'p1' },
      hostedCtx(HOST_WS),
    );
    expect(decision).toEqual({
      kind: 'bound',
      params: { paneId: 'p1', workspaceId: HOST_WS },
      hostedWorkspaceId: HOST_WS,
    });
  });

  it('passes a caller that names its own workspace through unchanged', () => {
    const decision = hostedWorkspaceBinding(
      'pane.list',
      { workspaceId: HOST_WS },
      hostedCtx(HOST_WS),
    );
    expect(decision).toEqual({
      kind: 'bound',
      params: { workspaceId: HOST_WS },
      hostedWorkspaceId: HOST_WS,
    });
  });

  it.each<[RpcMethod, string]>([
    ['pane.list', 'pane.read'],
    ['pane.search', 'pane.search'],
    ['input.readScreen', 'terminal.read'],
  ])('READ %s substitutes the binding for a foreign workspace', (method) => {
    const decision = hostedWorkspaceBinding(
      method,
      { workspaceId: OTHER_WS, query: 'secret' },
      hostedCtx(HOST_WS),
    );
    expect(decision).toEqual({
      kind: 'bound',
      params: { workspaceId: HOST_WS, query: 'secret' },
      hostedWorkspaceId: HOST_WS,
      substitutedFrom: OTHER_WS,
    });
  });

  it.each<RpcMethod>(['pane.split', 'browser.open', 'browser.close'])(
    'WRITE %s refuses a foreign workspace',
    (method) => {
      const decision = hostedWorkspaceBinding(
        method,
        { workspaceId: OTHER_WS },
        hostedCtx(HOST_WS),
      );
      expect(decision).toEqual({
        kind: 'refused',
        reason: 'hosted-workspace-mismatch',
        requestedWorkspaceId: OTHER_WS,
        hostedWorkspaceId: HOST_WS,
      });
    },
  );

  it('never mutates the caller-supplied params object', () => {
    const params = { workspaceId: OTHER_WS };
    hostedWorkspaceBinding('pane.list', params, hostedCtx(HOST_WS));
    expect(params).toEqual({ workspaceId: OTHER_WS });
  });

  it.each<RpcMethod>(['pane.list', 'pane.split'])(
    'an unbound host refuses %s rather than falling through',
    (method) => {
      // The fail-open PR1 closed, one layer up: if this fell through, an
      // unbound plugin would be free to name its own workspace and end up
      // LESS confined than a bound one.
      const decision = hostedWorkspaceBinding(
        method,
        { workspaceId: OTHER_WS },
        hostedCtx(null),
      );
      expect(decision).toEqual({
        kind: 'refused',
        reason: 'hosted-workspace-unbound',
        requestedWorkspaceId: OTHER_WS,
      });
    },
  );

  it('an unbound host is refused even when it names nothing', () => {
    const decision = hostedWorkspaceBinding('pane.list', {}, hostedCtx(null));
    expect(decision).toEqual({
      kind: 'refused',
      reason: 'hosted-workspace-unbound',
    });
  });

  it('treats a blank binding as unbound', () => {
    const decision = hostedWorkspaceBinding('pane.list', {}, hostedCtx('   '));
    expect(decision).toEqual({
      kind: 'refused',
      reason: 'hosted-workspace-unbound',
    });
  });

  it('covers the plugin-reachable body-scoped methods from BOTH bypass patterns', () => {
    // The list is pinned here for readability; `hostedWorkspaceBinding.drift.test.ts`
    // is what actually proves nothing is missing, by scanning the tree.
    expect([...HOSTED_BOUND_METHODS].sort()).toEqual([
      'browser.close',
      'browser.open',
      'input.readScreen',
      'input.send',
      'input.sendKey',
      'meta.setSkills',
      'pane.clearMetadata',
      'pane.getMetadata',
      'pane.list',
      'pane.search',
      'pane.setMetadata',
      'pane.split',
      'terminal.readEvents',
    ]);
  });

  it.each<[RpcMethod, 'read' | 'write']>([
    ['terminal.readEvents', 'read'],
    ['pane.getMetadata', 'read'],
    ['input.send', 'write'],
    ['input.sendKey', 'write'],
    ['pane.setMetadata', 'write'],
    ['pane.clearMetadata', 'write'],
    ['meta.setSkills', 'write'],
  ])('%s takes the %s verdict its capability implies', (method, effect) => {
    const decision = hostedWorkspaceBinding(
      method,
      { workspaceId: OTHER_WS },
      hostedCtx(HOST_WS),
    );
    expect(decision.kind).toBe(effect === 'write' ? 'refused' : 'bound');
  });
});

describe('hostedConfinement — the pane-addressed methods', () => {
  it('is inert for a caller that is not the plugin host', () => {
    expect(hostedConfinement(undefined)).toEqual({ kind: 'none' });
    expect(
      hostedConfinement({ origin: 'local', externalWire: true, clientName: 'cli' }),
    ).toEqual({ kind: 'none' });
    expect(
      hostedConfinement({ origin: 'local', operator: true, firstParty: true }),
    ).toEqual({ kind: 'none' });
  });

  it('hands back the host-derived binding for a bound plugin', () => {
    expect(hostedConfinement(hostedCtx(HOST_WS))).toEqual({
      kind: 'confine',
      workspaceId: HOST_WS,
    });
  });

  it.each([null, '', '   '])('refuses an unbound plugin (%p) instead of leaving it unconfined', (binding) => {
    expect(hostedConfinement(hostedCtx(binding as string | null))).toEqual({ kind: 'refuse' });
  });
});

describe('CAPABILITY_EFFECT', () => {
  it('classifies every known capability, so none defaults to the write lane by omission', () => {
    const unclassified = listKnownCapabilities().filter(
      (cap) => CAPABILITY_EFFECT[cap] === undefined,
    );
    expect(unclassified).toEqual([]);
  });
});

// ── Through the router ─────────────────────────────────────────────────────

type Handler = (params: Record<string, unknown>, ctx?: RpcContext) => Promise<unknown>;

/** Narrow the RpcResponse union so a failure's text can be asserted on. */
function errorOf(res: RpcResponse): string {
  return res.ok ? '<response was ok>' : res.error;
}

function approved(name: string, declaredCapabilities: string[]): PluginIdentityRecord {
  return {
    name,
    status: 'trusted',
    declaredCapabilities,
    firstSeen: 1000,
    lastSeen: 2000,
  };
}

const PLUGIN_CAPS = [
  'ui.sidebar',
  'workspace.read',
  'pane.read',
  'pane.search',
  'pane.create',
  'terminal.read',
  'browser.navigate',
  'events.subscribe',
];

describe('RpcRouter — hosted workspace binding at dispatch', () => {
  let router: RpcRouter;
  let handlers: Map<RpcMethod, ReturnType<typeof vi.fn<Handler>>>;
  let hostedSink: ReturnType<typeof vi.fn<(input: HostedScopeAuditInput) => void>>;

  const covered: RpcMethod[] = [
    'pane.list',
    'pane.search',
    'pane.split',
    'input.readScreen',
    'browser.open',
    'browser.close',
  ];

  beforeEach(() => {
    router = new RpcRouter();
    handlers = new Map();
    for (const method of [...covered, 'events.poll' as RpcMethod]) {
      const fn = vi.fn<Handler>(async () => ({ ok: true }));
      handlers.set(method, fn);
      router.register(method, fn);
    }
    router.setTrustLookup(async (name) =>
      name === 'hello-panel' ? approved('hello-panel', PLUGIN_CAPS) : undefined,
    );
    router.setEnforcementMode('enforce');
    hostedSink = vi.fn<(input: HostedScopeAuditInput) => void>();
    router.setHostedScopeSink(hostedSink);
  });

  const dispatchHosted = (
    method: RpcMethod,
    params: Record<string, unknown>,
    hostedWorkspace: string | null = HOST_WS,
  ) =>
    router.dispatch(
      { id: '1', method, params, clientName: 'hello-panel' },
      { firstParty: true, hostedWorkspace },
    );

  it('hands the handler the binding when the plugin omits workspaceId', async () => {
    const res = await dispatchHosted('pane.list', {});
    expect(res.ok).toBe(true);
    expect(handlers.get('pane.list')!.mock.calls[0][0]).toEqual({
      workspaceId: HOST_WS,
    });
    expect(hostedSink).not.toHaveBeenCalled();
  });

  it('answers a foreign READ about the hosting workspace, and audits it', async () => {
    const res = await dispatchHosted('input.readScreen', {
      workspaceId: OTHER_WS,
      ptyId: 'daemon-victim',
    });
    expect(res.ok).toBe(true);
    // The handler's own assertWorkspaceOwnsPty now runs against the binding,
    // so the foreign pty is refused downstream instead of being read.
    expect(handlers.get('input.readScreen')!.mock.calls[0][0]).toEqual({
      workspaceId: HOST_WS,
      ptyId: 'daemon-victim',
    });
    expect(hostedSink).toHaveBeenCalledWith({
      clientName: 'hello-panel',
      method: 'input.readScreen',
      outcome: 'substituted',
      requestedWorkspaceId: OTHER_WS,
      hostedWorkspaceId: HOST_WS,
    });
  });

  it('refuses a foreign WRITE before the handler runs, and audits it', async () => {
    const res = await dispatchHosted('pane.split', {
      workspaceId: OTHER_WS,
      paneId: 'p1',
    });
    expect(res.ok).toBe(false);
    expect(errorOf(res)).toContain('HOSTED_SCOPE_REFUSED');
    expect(handlers.get('pane.split')).not.toHaveBeenCalled();
    expect(hostedSink).toHaveBeenCalledWith({
      clientName: 'hello-panel',
      method: 'pane.split',
      outcome: 'refused',
      reason: 'hosted-workspace-mismatch',
      requestedWorkspaceId: OTHER_WS,
      hostedWorkspaceId: HOST_WS,
    });
  });

  it('never names another workspace in the refusal text', async () => {
    const res = await dispatchHosted('browser.open', {
      workspaceId: OTHER_WS,
      url: 'https://example.com',
    });
    expect(res.ok).toBe(false);
    expect(errorOf(res)).not.toContain(OTHER_WS);
    expect(errorOf(res)).not.toContain(HOST_WS);
  });

  it('brings browser.open and browser.close inside the binding', async () => {
    for (const method of ['browser.open', 'browser.close'] as RpcMethod[]) {
      const res = await dispatchHosted(method, {});
      expect(res.ok).toBe(true);
      expect(handlers.get(method)!.mock.calls[0][0]).toMatchObject({
        workspaceId: HOST_WS,
      });
    }
  });

  it('refuses every covered method for an unbound host', async () => {
    for (const method of covered) {
      const res = await dispatchHosted(method, { workspaceId: OTHER_WS }, null);
      expect(res.ok, method).toBe(false);
      expect(errorOf(res), method).toContain('HOSTED_SCOPE_REFUSED');
      expect(handlers.get(method), method).not.toHaveBeenCalled();
    }
  });

  it('leaves events.poll to its own hosted scoping (#959)', async () => {
    const res = await dispatchHosted('events.poll', {
      cursor: 0,
      workspaceId: OTHER_WS,
    });
    expect(res.ok).toBe(true);
    expect(handlers.get('events.poll')!.mock.calls[0][0]).toEqual({
      cursor: 0,
      workspaceId: OTHER_WS,
    });
  });

  it('leaves a wire caller byte-identical in both enforcement modes', async () => {
    for (const mode of ['shadow', 'enforce'] as const) {
      router.setEnforcementMode(mode);
      const fn = handlers.get('pane.list')!;
      fn.mockClear();
      const res = await router.dispatch(
        {
          id: 'w',
          method: 'pane.list',
          params: { workspaceId: OTHER_WS },
          clientName: 'wmux-cli',
        },
        { externalWire: true },
      );
      expect(res.ok, mode).toBe(true);
      expect(fn.mock.calls[0][0], mode).toEqual({ workspaceId: OTHER_WS });
      expect(hostedSink, mode).not.toHaveBeenCalled();
    }
  });

  it('binds in shadow mode as well — the mode is the wire rollback, not this', async () => {
    router.setEnforcementMode('shadow');
    const res = await dispatchHosted('pane.split', { workspaceId: OTHER_WS });
    expect(res.ok).toBe(false);
    expect(handlers.get('pane.split')).not.toHaveBeenCalled();
  });

  it('a plugin cannot forge the binding through its own params', async () => {
    // Provenance: `hostedWorkspace` is a dispatch ARGUMENT. A params field of
    // the same name is inert data that the binding then overwrites.
    const res = await dispatchHosted('pane.list', {
      hostedWorkspace: OTHER_WS,
      workspaceId: OTHER_WS,
    });
    expect(res.ok).toBe(true);
    expect(handlers.get('pane.list')!.mock.calls[0][0]).toEqual({
      hostedWorkspace: OTHER_WS,
      workspaceId: HOST_WS,
    });
  });

  it('a dispatch audit failure never breaks the call', async () => {
    hostedSink.mockImplementation(() => {
      throw new Error('disk full');
    });
    const res = await dispatchHosted('pane.list', { workspaceId: OTHER_WS });
    expect(res.ok).toBe(true);
  });
});
