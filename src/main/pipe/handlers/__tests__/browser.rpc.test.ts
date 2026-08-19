import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserWindow } from 'electron';
import type { RpcContext } from '../../../../shared/rpc';
import {
  __resetConfiguredFirstPartyClientsForTests,
  FIRST_PARTY_CLIENT_NAMES,
  setConfiguredFirstPartyClients,
} from '../../../mcp/firstParty';
import { RpcRouter } from '../../RpcRouter';
import {
  callerScope,
  canDiscloseBrowserAttachInfo,
  registerBrowserRpc,
} from '../browser.rpc';

const { validateResolvedNavigationUrlMock } = vi.hoisted(() => ({
  validateResolvedNavigationUrlMock: vi.fn(),
}));
const { sendToRendererMock } = vi.hoisted(() => ({
  sendToRendererMock: vi.fn(),
}));
// Navigation resolves on the guest's commit event (#756), so the fake guest
// has to be a real (if tiny) emitter. Without `on`/`off` here the handler's
// try/catch would swallow a TypeError and silently divert every navigate onto
// the renderer-bridge path — the CDP branch would then be untested while
// still looking green.
const wcListeners = new Map<string, Set<(...args: unknown[]) => void>>();
const mockWebContents = {
  isDestroyed: vi.fn(() => false),
  canGoBack: vi.fn(() => true),
  goBack: vi.fn(),
  loadURL: vi.fn(),
  once: vi.fn(),
  on: vi.fn((event: string, fn: (...args: unknown[]) => void) => {
    const set = wcListeners.get(event) ?? new Set<(...args: unknown[]) => void>();
    set.add(fn);
    wcListeners.set(event, set);
  }),
  off: vi.fn((event: string, fn: (...args: unknown[]) => void) => {
    wcListeners.get(event)?.delete(fn);
  }),
  debugger: {
    sendCommand: vi.fn(async () => ({})),
    // EventEmitter-ish surface used by BrowserCaptureManager (#106).
    isAttached: vi.fn(() => true),
    attach: vi.fn(),
    on: vi.fn(),
    removeListener: vi.fn(),
  },
};

vi.mock('electron', () => ({
  webContents: {
    fromId: vi.fn(() => mockWebContents),
  },
}));

vi.mock('../../../security/navigationPolicy', () => ({
  validateResolvedNavigationUrl: validateResolvedNavigationUrlMock,
}));

vi.mock('../_bridge', () => ({
  sendToRenderer: sendToRendererMock,
}));

describe('canDiscloseBrowserAttachInfo (#810)', () => {
  it.each([
    ['renderer operator', { origin: 'local', operator: true, firstParty: true }, true],
    ['server-pinned caller', { origin: 'local', externalWire: true, commanderWorkspace: 'ws-pinned' }, true],
    ['remote server-pinned caller', { origin: 'remote', externalWire: true, commanderWorkspace: 'ws-pinned' }, false],
    ['in-process caller carrying a pin', { origin: 'local', firstParty: true, commanderWorkspace: 'ws-pinned' }, false],
    ['recognised external-wire client', { origin: 'local', externalWire: true, clientName: 'claude-code' }, true],
    ['iframe with a colliding client name', { origin: 'local', firstParty: true, clientName: 'claude-code' }, false],
    ['unrecognised external-wire client', { origin: 'local', externalWire: true, clientName: 'browser-plugin' }, false],
    ['legacy envelope-less wire caller', { origin: 'local', externalWire: true }, false],
    ['remote caller with a recognised name', { origin: 'remote', externalWire: true, clientName: 'claude-code' }, false],
  ] as const)('%s', (_label, ctx, expected) => {
    expect(canDiscloseBrowserAttachInfo(ctx as RpcContext)).toBe(expected);
  });

  it('fails closed without a router-provided context', () => {
    expect(canDiscloseBrowserAttachInfo(undefined)).toBe(false);
  });

  it('honors an operator-configured first-party host only on the qualified wire', () => {
    try {
      setConfiguredFirstPartyClients(['hermes-agent']);
      expect(canDiscloseBrowserAttachInfo({
        origin: 'local',
        externalWire: true,
        clientName: 'hermes-agent',
      })).toBe(true);
      expect(canDiscloseBrowserAttachInfo({
        origin: 'local',
        firstParty: true,
        clientName: 'hermes-agent',
      })).toBe(false);
    } finally {
      __resetConfiguredFirstPartyClientsForTests();
    }
  });
});

describe('callerScope shadow decision (#810)', () => {
  it.each([
    [
      'operator without a request scope',
      { origin: 'local', operator: true, firstParty: true },
      {},
      { kind: 'allowed', lane: 'operator' },
    ],
    [
      'operator preserving an explicit narrow scope',
      { origin: 'local', operator: true, firstParty: true },
      { workspaceId: 'ws-requested' },
      { kind: 'allowed', lane: 'operator', workspaceId: 'ws-requested' },
    ],
    [
      'validated pin supplying an omitted scope',
      { origin: 'local', externalWire: true, commanderWorkspace: 'ws-pinned' },
      {},
      { kind: 'scoped', lane: 'pinned', workspaceId: 'ws-pinned' },
    ],
    [
      'validated pin accepting its matching body scope',
      { origin: 'local', externalWire: true, commanderWorkspace: 'ws-pinned' },
      { workspaceId: 'ws-pinned' },
      { kind: 'scoped', lane: 'pinned', workspaceId: 'ws-pinned' },
    ],
    [
      'validated pin refusing a mismatched body scope',
      { origin: 'local', externalWire: true, commanderWorkspace: 'ws-pinned' },
      { workspaceId: 'ws-other' },
      {
        kind: 'rejected',
        lane: 'pinned',
        reason: 'pinned-workspace-mismatch',
        requestedWorkspaceId: 'ws-other',
        pinnedWorkspaceId: 'ws-pinned',
      },
    ],
    [
      'iframe unable to forge a server pin',
      {
        origin: 'local',
        firstParty: true,
        clientName: 'plugin',
        commanderWorkspace: 'ws-forged',
      },
      {},
      {
        kind: 'rejected',
        lane: 'pinned',
        reason: 'pinned-source-unqualified',
        pinnedWorkspaceId: 'ws-forged',
      },
    ],
    [
      // #922 — the plugin host derives both halves of this identity, so an
      // omitted workspaceId resolves instead of being refused. Contrast the
      // `declared` cases below: those callers name their own scope.
      'hosted plugin omitting its scope resolves to the host workspace',
      {
        origin: 'local',
        firstParty: true,
        clientName: 'hello-panel',
        hostedWorkspace: 'ws-host',
      },
      {},
      { kind: 'scoped', lane: 'hosted', workspaceId: 'ws-host' },
    ],
    [
      'hosted plugin naming its own workspace',
      {
        origin: 'local',
        firstParty: true,
        clientName: 'hello-panel',
        hostedWorkspace: 'ws-host',
      },
      { workspaceId: 'ws-host' },
      { kind: 'scoped', lane: 'hosted', workspaceId: 'ws-host' },
    ],
    [
      // THE defect #922 describes: before this lane the same call landed in
      // `declared` and was scoped to 'ws-other' — a foreign workspace, on one
      // approval, from a plugin that #719 already forbids from WATCHING it.
      'hosted plugin naming a foreign workspace is refused',
      {
        origin: 'local',
        firstParty: true,
        clientName: 'hello-panel',
        hostedWorkspace: 'ws-host',
      },
      { workspaceId: 'ws-other' },
      {
        kind: 'rejected',
        lane: 'hosted',
        reason: 'hosted-workspace-mismatch',
        requestedWorkspaceId: 'ws-other',
        hostedWorkspaceId: 'ws-host',
      },
    ],
    [
      // Provenance, not payload: dispatch already refuses the option off the
      // firstParty lane, so a wire context carrying one is malformed. It is
      // refused rather than quietly demoted to `declared`, which would let a
      // malformed context buy the OLD behaviour back.
      'wire caller carrying a host workspace is refused',
      {
        origin: 'local',
        externalWire: true,
        clientName: 'approved-plugin',
        hostedWorkspace: 'ws-host',
      },
      { workspaceId: 'ws-other' },
      {
        kind: 'rejected',
        lane: 'hosted',
        reason: 'hosted-source-unqualified',
        requestedWorkspaceId: 'ws-other',
        hostedWorkspaceId: 'ws-host',
      },
    ],
    [
      // The host had no active workspace, so there is nothing to bind to. This
      // must NOT fall through to `declared`, which would accept the plugin's
      // own workspaceId — an unbound plugin would end up less confined than a
      // bound one.
      'hosted plugin with no binding is refused, not demoted',
      {
        origin: 'local',
        firstParty: true,
        clientName: 'hello-panel',
        hostedWorkspace: null,
      },
      { workspaceId: 'ws-other' },
      {
        kind: 'rejected',
        lane: 'hosted',
        reason: 'hosted-workspace-unbound',
        requestedWorkspaceId: 'ws-other',
      },
    ],
    [
      'hosted plugin with a blank binding is refused the same way',
      {
        origin: 'local',
        firstParty: true,
        clientName: 'hello-panel',
        hostedWorkspace: '',
      },
      {},
      {
        kind: 'rejected',
        lane: 'hosted',
        reason: 'hosted-workspace-unbound',
      },
    ],
    [
      // The pinned lane is checked first and stays first: a forged commander
      // pin is refused before the hosted lane can rescue the same caller.
      'hosted plugin forging a server pin is still refused as pinned',
      {
        origin: 'local',
        firstParty: true,
        clientName: 'hello-panel',
        hostedWorkspace: 'ws-host',
        commanderWorkspace: 'ws-forged',
      },
      {},
      {
        kind: 'rejected',
        lane: 'pinned',
        reason: 'pinned-source-unqualified',
        pinnedWorkspaceId: 'ws-forged',
      },
    ],
    [
      'identified caller declaring a scope',
      { origin: 'local', externalWire: true, clientName: 'approved-plugin' },
      { workspaceId: 'ws-declared' },
      { kind: 'scoped', lane: 'declared', workspaceId: 'ws-declared' },
    ],
    [
      'identified caller omitting its scope',
      { origin: 'local', externalWire: true, clientName: 'approved-plugin' },
      {},
      { kind: 'rejected', lane: 'declared', reason: 'workspace-unresolved' },
    ],
    [
      // No lane is keyed on the caller's NAME. `clientName` is self-asserted,
      // so a lane for the bundled CLI would be a lane for anything willing to
      // claim its name — the CLI resolves `workspace.current` instead.
      'bundled CLI name buys nothing on its own',
      { origin: 'local', externalWire: true, clientName: 'wmux-cli' },
      {},
      { kind: 'rejected', lane: 'declared', reason: 'workspace-unresolved' },
    ],
    [
      'bundled CLI that resolved its workspace',
      { origin: 'local', externalWire: true, clientName: 'wmux-cli' },
      { workspaceId: 'ws-cli' },
      { kind: 'scoped', lane: 'declared', workspaceId: 'ws-cli' },
    ],
    [
      // Being first-party is not a scope either: the bundled MCP servers send
      // their workspace on every call, so omitting it is a caller bug.
      'first-party MCP client omitting its scope',
      { origin: 'local', externalWire: true, clientName: 'claude-code' },
      {},
      { kind: 'rejected', lane: 'declared', reason: 'workspace-unresolved' },
    ],
    [
      'legacy caller remaining unscoped',
      { origin: 'local', externalWire: true },
      {},
      { kind: 'allowed', lane: 'legacy' },
    ],
    [
      'legacy caller retaining an explicit narrow scope',
      { origin: 'local', externalWire: true },
      { workspaceId: 'ws-legacy' },
      { kind: 'allowed', lane: 'legacy', workspaceId: 'ws-legacy' },
    ],
    [
      'remote caller failing closed',
      { origin: 'remote', clientName: 'approved-plugin' },
      { workspaceId: 'ws-remote' },
      {
        kind: 'rejected',
        lane: 'context',
        reason: 'caller-origin-unsupported',
        requestedWorkspaceId: 'ws-remote',
      },
    ],
  ] as const)('%s', (_label, ctx, params, expected) => {
    expect(callerScope(ctx as RpcContext, params)).toEqual(expected);
  });

  it('fails closed when a handler is invoked without router context', () => {
    expect(callerScope(undefined, {})).toEqual({
      kind: 'rejected',
      lane: 'context',
      reason: 'caller-context-unavailable',
    });
  });
});

describe('registerBrowserRpc', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockWebContents.isDestroyed.mockReturnValue(false);
    mockWebContents.canGoBack.mockReturnValue(true);
    validateResolvedNavigationUrlMock.mockResolvedValue({ valid: true });
    sendToRendererMock.mockResolvedValue({ ok: true });
  });

  function register(
    getWindow: () => BrowserWindow | null = () => null,
    browserScopeShadowSink?: Parameters<typeof registerBrowserRpc>[4],
    enforcementMode: 'shadow' | 'enforce' = 'shadow',
  ): RpcRouter {
    const router = new RpcRouter();
    const webviewCdpManager = {
      getTarget: vi.fn(() => ({ surfaceId: 'surface-1', webContentsId: 42, targetId: 'target-1', wsUrl: 'ws://127.0.0.1/devtools/page/target-1' })),
      listTargets: vi.fn(() => [{ surfaceId: 'surface-1', webContentsId: 42, targetId: 'target-1', wsUrl: 'ws://127.0.0.1/devtools/page/target-1' }]),
      getCdpPort: vi.fn(() => 18800),
      waitForTarget: vi.fn(),
      ensureAwake: vi.fn(async () => null),
      setCaptureCleanup: vi.fn(),
      // #517: automation ops run through the per-op lease wrapper.
      withAutomationLease: vi.fn(async (_surfaceId: string, fn: () => Promise<unknown>) => fn()),
      acquireRpcLease: vi.fn(() => 'lease-1'),
      renewRpcLease: vi.fn(() => true),
      releaseRpcLease: vi.fn(() => true),
    };

    registerBrowserRpc(
      router,
      getWindow,
      webviewCdpManager as never,
      undefined,
      browserScopeShadowSink,
      () => enforcementMode,
    );
    // Handed back so enforcement tests can assert a refusal never reached the
    // target lookup — "returned an error" is not the same as "did not look".
    (router as unknown as { __cdp: typeof webviewCdpManager }).__cdp = webviewCdpManager;
    return router;
  }

  /** The lookup mock behind a router built by `register`. */
  function cdpOf(router: RpcRouter) {
    return (router as unknown as { __cdp: { getTarget: ReturnType<typeof vi.fn>; listTargets: ReturnType<typeof vi.fn>; waitForTarget: ReturnType<typeof vi.fn>; ensureAwake: ReturnType<typeof vi.fn> } }).__cdp;
  }

  /** Build a fake main window whose webContents.getURL() returns `url`. */
  function windowWithUrl(url: string | (() => string)): () => BrowserWindow {
    const getURL = typeof url === 'function' ? url : () => url;
    return () => ({ webContents: { getURL } }) as unknown as BrowserWindow;
  }

  it('does not expose browser.cdp.send through the RPC router', async () => {
    const router = register();

    const response = await router.dispatch({
      id: '1',
      method: 'browser.cdp.send' as never,
      params: { method: 'Page.navigate' },
    });

    expect(response.ok).toBe(false);
    if (!response.ok) {
      expect(response.error).toContain('Unknown method: browser.cdp.send');
    }
  });

  it('browser.goBack uses the reviewed navigation method instead of raw CDP', async () => {
    const router = register();

    const response = await router.dispatch({
      id: '2',
      method: 'browser.goBack',
      params: {},
    });

    expect(response.ok).toBe(true);
    expect(mockWebContents.goBack).toHaveBeenCalledTimes(1);
    expect(mockWebContents.debugger.sendCommand).not.toHaveBeenCalled();
  });

  it.each([...FIRST_PARTY_CLIENT_NAMES])(
    'browser.cdp.info returns attach metadata to supported wire client %s',
    async (clientName) => {
      const router = register();

      const response = await router.dispatch({
        id: '3',
        method: 'browser.cdp.info',
        params: {},
        clientName,
      }, { externalWire: true });

      expect(response.ok).toBe(true);
      if (response.ok) {
        // No window (getWindow → null): shellUrl is omitted, not null.
        expect(response.result).toEqual({
          cdpPort: 18800,
          workspaceBackend: 'builtin',
          targets: [{ surfaceId: 'surface-1', targetId: 'target-1' }],
        });
      }
    },
  );

  it('browser.cdp.info exposes the main-window URL as shellUrl', async () => {
    const router = register(
      windowWithUrl('file:///x/.vite/renderer/main_window/index.html'),
    );

    const response = await router.dispatch({
      id: '3b',
      method: 'browser.cdp.info',
      params: {},
    }, { operator: true });

    expect(response.ok).toBe(true);
    if (response.ok) {
      expect(response.result).toMatchObject({
        cdpPort: 18800,
        workspaceBackend: 'builtin',
        shellUrl: 'file:///x/.vite/renderer/main_window/index.html',
      });
    }
  });

  it('browser.cdp.info omits shellUrl when the URL is empty (mid-load)', async () => {
    const router = register(windowWithUrl(''));

    const response = await router.dispatch({
      id: '3c',
      method: 'browser.cdp.info',
      params: {},
    }, { operator: true });

    expect(response.ok).toBe(true);
    if (response.ok) {
      expect(response.result).not.toHaveProperty('shellUrl');
    }
  });

  it('browser.cdp.info omits shellUrl when getURL throws (window destroyed)', async () => {
    const router = register(windowWithUrl(() => { throw new Error('destroyed'); }));

    const response = await router.dispatch({
      id: '3d',
      method: 'browser.cdp.info',
      params: {},
    }, { operator: true });

    expect(response.ok).toBe(true);
    if (response.ok) {
      expect(response.result).not.toHaveProperty('shellUrl');
    }
  });

  // #580 Option 1: browser.cdp.info filters its target list to the caller's
  // workspace server-side when a workspaceId is supplied, so the RPC never
  // volunteers another workspace's live targets to a caller that identifies
  // itself. #810 independently gates cdpPort/shellUrl by caller provenance.
  describe('browser.cdp.info workspace scoping (#580)', () => {
    const multiWorkspaceTargets = [
      { surfaceId: 'surface-a', targetId: 'target-a', workspaceId: 'ws-a' },
      { surfaceId: 'surface-b', targetId: 'target-b', workspaceId: 'ws-b' },
      { surfaceId: 'surface-untagged', targetId: 'target-u' },
    ];

    function registerMultiWs(
      listTargets = vi.fn(() => multiWorkspaceTargets),
    ): { router: RpcRouter; listTargets: typeof listTargets } {
      const router = new RpcRouter();
      const webviewCdpManager = {
        getTarget: vi.fn(),
        listTargets,
        getCdpPort: vi.fn(() => 18800),
        waitForTarget: vi.fn(),
        ensureAwake: vi.fn(async () => null),
        setCaptureCleanup: vi.fn(),
        withAutomationLease: vi.fn(async (_s: string, fn: () => Promise<unknown>) => fn()),
        acquireRpcLease: vi.fn(() => 'lease-1'),
        renewRpcLease: vi.fn(() => true),
        releaseRpcLease: vi.fn(() => true),
      };
      registerBrowserRpc(router, () => null, webviewCdpManager as never);
      return { router, listTargets };
    }

    it('filters targets to the caller workspace and marks the response scoped', async () => {
      const { router } = registerMultiWs();

      const response = await router.dispatch({
        id: 'ws1',
        method: 'browser.cdp.info',
        params: { workspaceId: 'ws-a' },
        clientName: 'claude-code',
      }, { externalWire: true });

      expect(response.ok).toBe(true);
      if (response.ok) {
        expect(response.result).toEqual({
          cdpPort: 18800,
          workspaceBackend: 'builtin',
          targetsScoped: true,
          targets: [{ surfaceId: 'surface-a', targetId: 'target-a', workspaceId: 'ws-a' }],
        });
        // Neither the foreign nor the untagged target may leak.
        expect(JSON.stringify(response.result)).not.toContain('surface-b');
        expect(JSON.stringify(response.result)).not.toContain('surface-untagged');
      }
    });

    it('returns an empty scoped list when the caller owns no live target', async () => {
      vi.useFakeTimers();
      try {
        const { router, listTargets } = registerMultiWs();

        const responsePromise = router.dispatch({
          id: 'ws2',
          method: 'browser.cdp.info',
          params: { workspaceId: 'ws-none' },
          clientName: 'claude-code',
        }, { externalWire: true });
        await vi.advanceTimersByTimeAsync(1500);
        const response = await responsePromise;

        expect(listTargets).toHaveBeenCalledTimes(2);
        expect(response.ok).toBe(true);
        if (response.ok) {
          // Empty + targetsScoped is the signal the engine reads as "own none",
          // distinct from a legacy main that cannot scope at all.
          expect(response.result).toEqual({ cdpPort: 18800, targetsScoped: true, workspaceBackend: 'builtin', targets: [] });
        }
      } finally {
        vi.useRealTimers();
      }
    });

    it('waits for the caller target when another workspace is already registered', async () => {
      vi.useFakeTimers();
      try {
        const foreignTarget = {
          surfaceId: 'surface-b',
          targetId: 'target-b',
          workspaceId: 'ws-b',
        };
        const callerTarget = {
          surfaceId: 'surface-a',
          targetId: 'target-a',
          workspaceId: 'ws-a',
        };
        const listTargets = vi.fn()
          .mockReturnValueOnce([foreignTarget])
          .mockReturnValue([foreignTarget, callerTarget]);
        const { router } = registerMultiWs(listTargets);

        const responsePromise = router.dispatch({
          id: 'ws-race',
          method: 'browser.cdp.info',
          params: { workspaceId: 'ws-a' },
        });
        expect(listTargets).toHaveBeenCalledTimes(1);

        await vi.advanceTimersByTimeAsync(1500);
        const response = await responsePromise;

        expect(listTargets).toHaveBeenCalledTimes(2);
        expect(response.ok).toBe(true);
        if (response.ok) {
          expect(response.result).toMatchObject({
            targetsScoped: true,
            targets: [callerTarget],
          });
        }
      } finally {
        vi.useRealTimers();
      }
    });

    it('keeps legacy target metadata but withholds attach metadata', async () => {
      const { router } = registerMultiWs();

      const response = await router.dispatch({
        id: 'ws3',
        method: 'browser.cdp.info',
        params: {},
      });

      expect(response.ok).toBe(true);
      if (response.ok) {
        const result = response.result as {
          cdpPort?: number;
          shellUrl?: string;
          targetsScoped?: boolean;
          targets: unknown[];
        };
        expect(result.cdpPort).toBeUndefined();
        expect(result.shellUrl).toBeUndefined();
        expect(result.targetsScoped).toBeUndefined();
        expect(result.targets).toHaveLength(3);
      }
    });
  });

  it('does not disclose attach metadata to an iframe with a privileged-name collision', async () => {
    const getUrl = vi.fn(() => 'file:///private/app-shell.html');
    const router = register(windowWithUrl(getUrl));

    const response = await router.dispatch({
      id: 'collision',
      method: 'browser.cdp.info',
      params: {},
      clientName: 'claude-code',
    }, { firstParty: true });

    expect(response.ok).toBe(true);
    if (response.ok) {
      expect(response.result).not.toHaveProperty('cdpPort');
      expect(response.result).not.toHaveProperty('shellUrl');
      expect(response.result).toMatchObject({
        workspaceBackend: 'builtin',
        targets: [{ surfaceId: 'surface-1', targetId: 'target-1' }],
      });
    }
    expect(getUrl).not.toHaveBeenCalled();
  });

  it('shadow-logs an identified unscoped cdp.info call without changing its target response', async () => {
    const shadowSink = vi.fn();
    const router = register(() => null, shadowSink);

    const response = await router.dispatch({
      id: 'scope-shadow-info',
      method: 'browser.cdp.info',
      params: {},
      clientName: 'approved-plugin',
    }, { externalWire: true });

    expect(response.ok).toBe(true);
    if (response.ok) {
      expect(response.result).toMatchObject({
        targets: [{ surfaceId: 'surface-1', targetId: 'target-1' }],
      });
    }
    expect(shadowSink).toHaveBeenCalledOnce();
    expect(shadowSink).toHaveBeenCalledWith({
      clientName: 'approved-plugin',
      method: 'browser.cdp.info',
      reason: 'workspace-unresolved',
    });
  });

  it('does not shadow-log a declared scope or a trusted operator lane', async () => {
    const shadowSink = vi.fn();
    const router = register(() => null, shadowSink);

    await router.dispatch({
      id: 'scope-shadow-declared',
      method: 'browser.cdp.info',
      params: { workspaceId: 'ws-declared' },
      clientName: 'approved-plugin',
    }, { externalWire: true });
    await router.dispatch({
      id: 'scope-shadow-operator',
      method: 'browser.cdp.info',
      params: {},
    }, { operator: true });

    expect(shadowSink).not.toHaveBeenCalled();
  });

  it('observes leased target handlers and swallows a failing shadow sink', async () => {
    const shadowSink = vi.fn(() => {
      throw new Error('audit disk unavailable');
    });
    const router = register(() => null, shadowSink);

    const response = await router.dispatch({
      id: 'scope-shadow-evaluate',
      method: 'browser.evaluate',
      params: { expression: '1 + 1' },
      clientName: 'approved-plugin',
    }, { externalWire: true });

    expect(response.ok).toBe(true);
    expect(shadowSink).toHaveBeenCalledWith({
      clientName: 'approved-plugin',
      method: 'browser.evaluate',
      reason: 'workspace-unresolved',
    });
    expect(mockWebContents.debugger.sendCommand).toHaveBeenCalled();
  });

  // ── #810 step 4: the same decisions, now authoritative ────────────────────
  //
  // Every case below is paired: the shadow assertions above prove the response
  // is unchanged, these prove the enforce mode refuses. A test that only checked
  // enforce would not catch the rollback path silently breaking.

  it('refuses an identified caller that omits workspaceId, and never looks a target up', async () => {
    const shadowSink = vi.fn();
    const router = register(() => null, shadowSink, 'enforce');

    const response = await router.dispatch({
      id: 'scope-enforce-evaluate',
      method: 'browser.evaluate',
      params: { expression: '1 + 1' },
      clientName: 'approved-plugin',
    }, { externalWire: true });

    expect(response.ok).toBe(false);
    if (!response.ok) {
      expect(response.error).toContain('BROWSER_SCOPE_REFUSED');
      expect(response.error).toContain('send the workspaceId');
      expect(response.error).toContain('Do not retry unchanged');
    }
    // The refusal is the whole point: no lookup, no lease, no evaluation.
    expect(cdpOf(router).getTarget).not.toHaveBeenCalled();
    expect(cdpOf(router).ensureAwake).not.toHaveBeenCalled();
    expect(mockWebContents.debugger.sendCommand).not.toHaveBeenCalled();
    // Enforced refusals stay auditable — the log is written before the throw.
    expect(shadowSink).toHaveBeenCalledWith({
      clientName: 'approved-plugin',
      method: 'browser.evaluate',
      reason: 'workspace-unresolved',
    });
  });

  // The pinned lane cannot be reached from here: `commanderWorkspace` is set
  // only by RpcRouter after validating a commander token, never from dispatch
  // options or a request field. Its decisions are covered pure-functionally in
  // the `callerScope` describe above; `scopeFor` funnels every rejected lane
  // through one branch, exercised by the unresolved cases here.

  // The hosted lane, unlike pinned, IS reachable from here: `hostedWorkspace`
  // comes from the dispatch options the plugin host supplies, so these drive
  // the real handler chain rather than the decision function alone.
  it('resolves a hosted plugin that omits its workspace to the host binding', async () => {
    const router = register(() => null, undefined, 'enforce');

    const response = await router.dispatch({
      id: 'scope-enforce-hosted-omitted',
      method: 'browser.evaluate',
      params: { expression: '1 + 1' },
      clientName: 'hello-panel',
    }, { firstParty: true, hostedWorkspace: 'ws-host' });

    expect(response.ok).toBe(true);
    // The binding, not the absent request field, is what the lookup receives.
    expect(cdpOf(router).getTarget).toHaveBeenCalledWith(undefined, 'ws-host');
  });

  it('refuses a hosted plugin that names another workspace, before any lookup', async () => {
    const shadowSink = vi.fn();
    const router = register(() => null, shadowSink, 'enforce');

    const response = await router.dispatch({
      id: 'scope-enforce-hosted-mismatch',
      method: 'browser.evaluate',
      params: { expression: '1 + 1', workspaceId: 'ws-other' },
      clientName: 'hello-panel',
    }, { firstParty: true, hostedWorkspace: 'ws-host' });

    expect(response.ok).toBe(false);
    if (!response.ok) {
      expect(response.error).toContain('BROWSER_SCOPE_REFUSED');
      expect(response.error).toContain('omit workspaceId');
    }
    expect(cdpOf(router).getTarget).not.toHaveBeenCalled();
    expect(cdpOf(router).ensureAwake).not.toHaveBeenCalled();
    expect(mockWebContents.debugger.sendCommand).not.toHaveBeenCalled();
    expect(shadowSink).toHaveBeenCalledWith({
      clientName: 'hello-panel',
      method: 'browser.evaluate',
      reason: 'hosted-workspace-mismatch',
      requestedWorkspaceId: 'ws-other',
      hostedWorkspaceId: 'ws-host',
    });
  });

  it('refuses an unbound hosted plugin instead of accepting the workspace it names', async () => {
    const shadowSink = vi.fn();
    const router = register(() => null, shadowSink, 'enforce');

    const response = await router.dispatch({
      id: 'scope-enforce-hosted-unbound',
      method: 'browser.evaluate',
      params: { expression: '1 + 1', workspaceId: 'ws-other' },
      clientName: 'hello-panel',
    }, { firstParty: true, hostedWorkspace: null });

    expect(response.ok).toBe(false);
    if (!response.ok) expect(response.error).toContain('BROWSER_SCOPE_REFUSED');
    // The regression this guards: before the lane keyed on presence, this call
    // landed in `declared` and was scoped to 'ws-other'.
    expect(cdpOf(router).getTarget).not.toHaveBeenCalled();
    expect(shadowSink).toHaveBeenCalledWith({
      clientName: 'hello-panel',
      method: 'browser.evaluate',
      reason: 'hosted-workspace-unbound',
      requestedWorkspaceId: 'ws-other',
    });
  });

  it('hands the decided workspace to the lookup, not the raw request field', async () => {
    const router = register(() => null, undefined, 'enforce');

    const response = await router.dispatch({
      id: 'scope-enforce-declared',
      method: 'browser.evaluate',
      params: { expression: '1 + 1', workspaceId: 'ws-declared' },
      clientName: 'approved-plugin',
    }, { externalWire: true });

    expect(response.ok).toBe(true);
    expect(cdpOf(router).getTarget).toHaveBeenCalledWith(undefined, 'ws-declared');
  });

  it('refuses a caller with no context at all', async () => {
    const router = register(() => null, undefined, 'enforce');

    // No dispatch options: RpcRouter still builds a ctx, so this exercises the
    // realistic shape rather than a hand-made `undefined` ctx. An identified
    // caller that never proved a source lands on the unresolved lane.
    const response = await router.dispatch({
      id: 'scope-enforce-nosource',
      method: 'browser.evaluate',
      params: { expression: '1 + 1' },
      clientName: 'approved-plugin',
    });

    expect(response.ok).toBe(false);
    if (!response.ok) expect(response.error).toContain('BROWSER_SCOPE_REFUSED');
  });

  it('keeps the operator and legacy lanes working under enforce', async () => {
    const router = register(() => null, undefined, 'enforce');

    // Human operator crossing workspaces on purpose.
    const operator = await router.dispatch({
      id: 'scope-enforce-operator',
      method: 'browser.evaluate',
      params: { expression: '1 + 1' },
    }, { operator: true });
    expect(operator.ok).toBe(true);

    // Envelope-less caller: still grandfathered, matching PermissionEnforcer.
    // This lane is the documented remaining hole on #810, asserted so that
    // closing it later is a deliberate, visible change rather than a drift.
    const legacy = await router.dispatch({
      id: 'scope-enforce-legacy',
      method: 'browser.evaluate',
      params: { expression: '1 + 1' },
    });
    expect(legacy.ok).toBe(true);
  });

  it('refuses cdp.info before disclosing anything, including targets', async () => {
    const router = register(windowWithUrl('http://localhost:5173/'), undefined, 'enforce');

    const response = await router.dispatch({
      id: 'scope-enforce-info',
      method: 'browser.cdp.info',
      params: {},
      clientName: 'approved-plugin',
    }, { externalWire: true });

    expect(response.ok).toBe(false);
    if (!response.ok) expect(response.error).toContain('BROWSER_SCOPE_REFUSED');
    expect(cdpOf(router).listTargets).not.toHaveBeenCalled();
  });

  it('refuses cdp.target before the discovery wait', async () => {
    const router = register(() => null, undefined, 'enforce');

    const response = await router.dispatch({
      id: 'scope-enforce-cdp-target',
      method: 'browser.cdp.target',
      params: { surfaceId: 'surface-1' },
      clientName: 'approved-plugin',
    }, { externalWire: true });

    expect(response.ok).toBe(false);
    if (!response.ok) expect(response.error).toContain('BROWSER_SCOPE_REFUSED');
    expect(cdpOf(router).waitForTarget).not.toHaveBeenCalled();
  });

  it('refuses lease.acquire rather than handing back a null token', async () => {
    const router = register(() => null, undefined, 'enforce');

    const response = await router.dispatch({
      id: 'scope-enforce-lease',
      method: 'browser.lease.acquire',
      params: {},
      clientName: 'approved-plugin',
    }, { externalWire: true });

    // `{ token: null }` would read as "no surface open" and send the caller
    // into a retry loop; a refusal is terminal and says why.
    expect(response.ok).toBe(false);
    if (!response.ok) expect(response.error).toContain('BROWSER_SCOPE_REFUSED');
  });

  it('refuses navigate before URL validation or the external delegate', async () => {
    const router = register(() => null, undefined, 'enforce');

    const response = await router.dispatch({
      id: 'scope-enforce-navigate',
      method: 'browser.navigate',
      params: { url: 'https://example.com/' },
      clientName: 'approved-plugin',
    }, { externalWire: true });

    expect(response.ok).toBe(false);
    if (!response.ok) expect(response.error).toContain('BROWSER_SCOPE_REFUSED');
    expect(validateResolvedNavigationUrlMock).not.toHaveBeenCalled();
    expect(sendToRendererMock).not.toHaveBeenCalled();
  });

  it('shadow mode looks targets up by the request field, not the decision', async () => {
    // Shadow is the rollback, so it must be pre-#810 behavior exactly. The
    // regression this guards: returning the decision's workspace here would
    // re-scope callers (notably the pinned lane) in the mode whose promise is
    // that it changes nothing.
    const router = register(() => null, undefined, 'shadow');

    await router.dispatch({
      id: 'scope-shadow-passthrough-none',
      method: 'browser.evaluate',
      params: { expression: '1 + 1' },
      clientName: 'approved-plugin',
    }, { externalWire: true });
    expect(cdpOf(router).getTarget).toHaveBeenCalledWith(undefined, undefined);

    await router.dispatch({
      id: 'scope-shadow-passthrough-declared',
      method: 'browser.evaluate',
      params: { expression: '1 + 1', workspaceId: 'ws-declared' },
      clientName: 'approved-plugin',
    }, { externalWire: true });
    expect(cdpOf(router).getTarget).toHaveBeenCalledWith(undefined, 'ws-declared');
  });

  it('treats an empty workspaceId as absent, the same as the pre-#810 inline check', async () => {
    // `browser.cdp.info` used to inline `typeof x === 'string' && x.length > 0`
    // and now shares `requestedWorkspaceId`. If those ever diverge, `""` would
    // start filtering targets to a workspace that cannot exist — an empty list
    // reported as `targetsScoped`, which reads as "you own nothing" rather than
    // "your request was malformed".
    const enforced = register(() => null, undefined, 'enforce');
    const response = await enforced.dispatch({
      id: 'scope-empty-ws',
      method: 'browser.cdp.info',
      params: { workspaceId: '' },
      clientName: 'approved-plugin',
    }, { externalWire: true });

    // Empty means unresolved, so an identified caller is refused rather than
    // silently scoped to "".
    expect(response.ok).toBe(false);
    if (!response.ok) expect(response.error).toContain('BROWSER_SCOPE_REFUSED');
  });

  it('shadow mode still answers every one of those calls', async () => {
    const router = register(() => null, undefined, 'shadow');

    for (const [id, method, params] of [
      ['s1', 'browser.evaluate', { expression: '1 + 1' }],
      ['s2', 'browser.cdp.info', {}],
      ['s3', 'browser.lease.acquire', {}],
    ] as const) {
      const response = await router.dispatch({
        id,
        method,
        params: params as Record<string, unknown>,
        clientName: 'approved-plugin',
      }, { externalWire: true });
      expect(response.ok).toBe(true);
    }
  });

  it('browser.navigate rejects URLs whose resolved targets are blocked', async () => {
    validateResolvedNavigationUrlMock.mockResolvedValue({
      valid: false,
      reason: 'Blocked resolved address 169.254.169.254: Blocked link-local/cloud metadata address (169.254.0.0/16)',
    });

    const router = register();
    const response = await router.dispatch({
      id: '4',
      method: 'browser.navigate',
      params: { url: 'https://metadata.example' },
    });

    expect(response.ok).toBe(false);
    if (!response.ok) {
      expect(response.error).toContain('browser.navigate: Blocked resolved address 169.254.169.254');
    }
    expect(mockWebContents.loadURL).not.toHaveBeenCalled();
  });

  it('browser.tabs list forwards the strictly supplied workspace without CDP state', async () => {
    const router = register();

    const response = await router.dispatch({
      id: '4b',
      method: 'browser.tabs',
      params: { action: 'list', workspaceId: 'ws-caller' },
    });

    expect(response.ok).toBe(true);
    expect(sendToRendererMock).toHaveBeenCalledWith(expect.any(Function), 'browser.tabs', {
      action: 'list',
      workspaceId: 'ws-caller',
    });
  });

  it('browser.tabs new validates the URL and supplies the active partition', async () => {
    const router = register();

    await router.dispatch({
      id: '4c',
      method: 'browser.tabs',
      params: {
        action: 'new',
        workspaceId: 'ws-caller',
        url: 'https://example.com/',
      },
    });

    expect(validateResolvedNavigationUrlMock).toHaveBeenCalledWith('https://example.com/');
    expect(sendToRendererMock).toHaveBeenCalledWith(expect.any(Function), 'browser.tabs', {
      action: 'new',
      workspaceId: 'ws-caller',
      url: 'https://example.com/',
      partition: 'persist:wmux-default',
    });
  });

  it('browser.tabs new returns a stable blocked-url error before renderer mutation', async () => {
    validateResolvedNavigationUrlMock.mockResolvedValue({
      valid: false,
      reason: 'Blocked resolved address 169.254.169.254',
    });
    const router = register();

    const response = await router.dispatch({
      id: '4d',
      method: 'browser.tabs',
      params: {
        action: 'new',
        workspaceId: 'ws-caller',
        url: 'https://metadata.example/',
      },
    });

    expect(response.ok).toBe(true);
    if (response.ok) {
      expect(response.result).toMatchObject({
        ok: false,
        error: { code: 'BROWSER_TAB_URL_BLOCKED' },
      });
    }
    expect(sendToRendererMock).not.toHaveBeenCalledWith(
      expect.any(Function),
      'browser.tabs',
      expect.anything(),
    );
  });

  it('browser.tabs rejects missing workspace identity and select without surfaceId', async () => {
    const router = register();

    const noWorkspace = await router.dispatch({
      id: '4e',
      method: 'browser.tabs',
      params: { action: 'list' },
    });
    const noSurface = await router.dispatch({
      id: '4f',
      method: 'browser.tabs',
      params: { action: 'select', workspaceId: 'ws-caller' },
    });

    expect(noWorkspace.ok).toBe(true);
    if (noWorkspace.ok) {
      expect(noWorkspace.result).toMatchObject({
        ok: false,
        error: { code: 'BROWSER_TABS_WORKSPACE_UNRESOLVED' },
      });
    }
    expect(noSurface.ok).toBe(true);
    if (noSurface.ok) {
      expect(noSurface.result).toMatchObject({
        ok: false,
        error: { code: 'BROWSER_TABS_INVALID_ARGUMENT' },
      });
    }
    expect(sendToRendererMock).not.toHaveBeenCalledWith(
      expect.any(Function),
      'browser.tabs',
      expect.anything(),
    );
  });

  it('browser.tabs close forwards only the stable surface id inside the caller workspace', async () => {
    const router = register();

    await router.dispatch({
      id: '4g',
      method: 'browser.tabs',
      params: {
        action: 'close',
        workspaceId: 'ws-caller',
        surfaceId: 'surface-a',
      },
    });

    expect(sendToRendererMock).toHaveBeenCalledWith(expect.any(Function), 'browser.tabs', {
      action: 'close',
      workspaceId: 'ws-caller',
      surfaceId: 'surface-a',
    });
  });

  it('browser.open passes the active profile partition to the renderer', async () => {
    const router = register();

    await router.dispatch({
      id: '5',
      method: 'browser.open',
      params: {},
    });

    expect(sendToRendererMock).toHaveBeenCalledWith(expect.any(Function), 'browser.open', {
      partition: 'persist:wmux-default',
    });
  });

  it('browser.close forwards surfaceId and workspaceId to the renderer (caller-ws routing)', async () => {
    const router = register();

    await router.dispatch({
      id: '5b',
      method: 'browser.close',
      params: { surfaceId: 'surface-9', workspaceId: 'ws-caller' },
    });

    expect(sendToRendererMock).toHaveBeenCalledWith(expect.any(Function), 'browser.close', {
      surfaceId: 'surface-9',
      workspaceId: 'ws-caller',
    });
  });

  it('browser.close omits absent ids (renderer falls back to the active workspace)', async () => {
    const router = register();

    await router.dispatch({
      id: '5c',
      method: 'browser.close',
      params: {},
    });

    expect(sendToRendererMock).toHaveBeenCalledWith(expect.any(Function), 'browser.close', {});
  });

  it('browser.session.start applies only the default partition to renderer browser surfaces', async () => {
    const router = register();

    const response = await router.dispatch({
      id: '6',
      method: 'browser.session.start',
      params: {},
    });

    expect(response.ok).toBe(true);
    expect(sendToRendererMock).toHaveBeenCalledWith(expect.any(Function), 'browser.session.applyProfile', {
      partition: 'persist:wmux-default',
    });
  });

  it('browser.session.start rejects protected browser profiles', async () => {
    const router = register();

    const response = await router.dispatch({
      id: '7',
      method: 'browser.session.start',
      params: { profile: 'login' },
    });

    expect(response.ok).toBe(false);
    if (!response.ok) {
      expect(response.error).toContain('profile "login" is not available');
    }
    expect(sendToRendererMock).not.toHaveBeenCalledWith(expect.any(Function), 'browser.session.applyProfile', {
      partition: 'persist:wmux-login',
    });
  });

  it('browser.session.start rejects invalid profile names before building partitions', async () => {
    const router = register();

    const response = await router.dispatch({
      id: '8',
      method: 'browser.session.start',
      params: { profile: '../login\ncontrol-char' },
    });

    expect(response.ok).toBe(false);
    if (!response.ok) {
      expect(response.error).toContain('Browser profile names must be 1-64 characters');
    }
    expect(sendToRendererMock).not.toHaveBeenCalled();
  });

  it('browser.console.get drains the capture buffer (#106)', async () => {
    const router = register();
    const response = await router.dispatch({ id: '7', method: 'browser.console.get', params: {} });
    expect(response.ok).toBe(true);
    if (response.ok) {
      expect(response.result).toHaveProperty('entries');
      expect(Array.isArray((response.result as { entries: unknown[] }).entries)).toBe(true);
    }
  });

  it('browser.network.get drains the capture buffer (#106)', async () => {
    const router = register();
    const response = await router.dispatch({ id: '8', method: 'browser.network.get', params: {} });
    expect(response.ok).toBe(true);
    if (response.ok) {
      expect(response.result).toHaveProperty('entries');
    }
  });

  it('browser.responseBody.get requires urlPattern (#106)', async () => {
    const router = register();
    const response = await router.dispatch({ id: '9', method: 'browser.responseBody.get', params: {} });
    expect(response.ok).toBe(false);
    if (!response.ok) {
      expect(response.error).toContain('missing "urlPattern"');
    }
  });

  it('browser.responseBody.get returns a body field for a pattern (#106)', async () => {
    const router = register();
    const response = await router.dispatch({
      id: '10',
      method: 'browser.responseBody.get',
      params: { urlPattern: '*api*' },
    });
    expect(response.ok).toBe(true);
    if (response.ok) {
      expect(response.result).toHaveProperty('body');
    }
  });

  it('browser.console.get fails clearly when no webview target is registered (#106)', async () => {
    const router = new RpcRouter();
    const webviewCdpManager = {
      getTarget: vi.fn(() => null),
      listTargets: vi.fn(() => []),
      getCdpPort: vi.fn(() => 18800),
      waitForTarget: vi.fn(),
      ensureAwake: vi.fn(async () => null),
      setCaptureCleanup: vi.fn(),
      // #517: no registered target → registerLeased runs the handler unleased.
      withAutomationLease: vi.fn(async (_surfaceId: string, fn: () => Promise<unknown>) => fn()),
      acquireRpcLease: vi.fn(() => 'lease-1'),
      renewRpcLease: vi.fn(() => true),
      releaseRpcLease: vi.fn(() => true),
    };
    registerBrowserRpc(router, () => null, webviewCdpManager as never);
    const response = await router.dispatch({ id: '11', method: 'browser.console.get', params: {} });
    expect(response.ok).toBe(false);
    if (!response.ok) {
      // #756 replaced the one-size message with a matchable cause. Unscoped
      // caller + nothing registered = "there is no browser", not a refusal.
      expect(response.error).toContain('BROWSER_NO_TARGET');
      expect(response.error).toContain('browser_open');
    }
  });

  // browser.press.cdp regression coverage (#353). The old handler dispatched
  // non-named keys as CDP type:'char', which inserts text but fires NO keydown.
  // Assert the handler now dispatches real keyDown/keyUp descriptors.
  function keyEventCalls(): unknown[][] {
    return (mockWebContents.debugger.sendCommand.mock.calls as unknown[][]).filter(
      (c) => c[0] === 'Input.dispatchKeyEvent',
    );
  }

  it("browser.press.cdp {key:'z'} synthesizes keyDown (with text) + keyUp", async () => {
    const router = register();
    const response = await router.dispatch({
      id: '12',
      method: 'browser.press.cdp',
      params: { key: 'z' },
    });

    expect(response.ok).toBe(true);
    const calls = keyEventCalls();
    expect(calls).toHaveLength(2);
    expect(calls[0][1]).toMatchObject({
      type: 'keyDown',
      key: 'z',
      code: 'KeyZ',
      text: 'z',
      windowsVirtualKeyCode: 90,
    });
    expect(calls[1][1]).toMatchObject({ type: 'keyUp', key: 'z' });
    // keyUp must not re-insert the character.
    expect(calls[1][1]).not.toHaveProperty('text');
  });

  it("browser.press.cdp {key:'Control+a'} sets the modifier bitmask and suppresses text", async () => {
    const router = register();
    const response = await router.dispatch({
      id: '13',
      method: 'browser.press.cdp',
      params: { key: 'Control+a' },
    });

    expect(response.ok).toBe(true);
    const calls = keyEventCalls();
    expect(calls[0][1]).toMatchObject({ type: 'keyDown', key: 'a', code: 'KeyA', modifiers: 2 });
    // Shortcut semantics: no text insertion (Control+a selects all, not types "a").
    expect(calls[0][1]).not.toHaveProperty('text');
  });

  it("browser.press.cdp rejects multi-character text with a pointer to browser.type.cdp", async () => {
    const router = register();
    const response = await router.dispatch({
      id: '14',
      method: 'browser.press.cdp',
      params: { key: 'abc' },
    });

    expect(response.ok).toBe(false);
    if (!response.ok) {
      expect(response.error).toContain('browser.type.cdp');
    }
    expect(keyEventCalls()).toHaveLength(0);
  });
});

// ── #529 — screenshot hang fallback ─────────────────────────────────────────

describe('browser.screenshot capture fallback (#529)', () => {
  // Local mirror of the register() helper above (it is scoped to the first
  // describe block).
  function register(): RpcRouter {
    const router = new RpcRouter();
    const webviewCdpManager = {
      getTarget: vi.fn(() => ({ surfaceId: 'surface-1', webContentsId: 42, targetId: 'target-1', wsUrl: 'ws://127.0.0.1/devtools/page/target-1' })),
      listTargets: vi.fn(() => []),
      getCdpPort: vi.fn(() => 18800),
      waitForTarget: vi.fn(),
      ensureAwake: vi.fn(async () => null),
      setCaptureCleanup: vi.fn(),
      withAutomationLease: vi.fn(async (_surfaceId: string, fn: () => Promise<unknown>) => fn()),
      acquireRpcLease: vi.fn(() => 'lease-1'),
      renewRpcLease: vi.fn(() => true),
      releaseRpcLease: vi.fn(() => true),
    };
    registerBrowserRpc(router, () => null, webviewCdpManager as never);
    return router;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mockWebContents.isDestroyed.mockReturnValue(false);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    delete (mockWebContents as Record<string, unknown>)['capturePage'];
  });

  it('returns the CDP capture when it resolves promptly (fast path unchanged)', async () => {
    mockWebContents.debugger.sendCommand.mockResolvedValueOnce({ data: 'cdp-png' });
    const router = register();
    const p = router.dispatch({ id: 's1', method: 'browser.screenshot', params: {} });
    await vi.advanceTimersByTimeAsync(10);
    const response = await p;
    expect(response.ok).toBe(true);
    if (response.ok) expect(response.result).toEqual({ data: 'cdp-png' });
  });

  it('falls back to capturePage when the CDP capture hangs', async () => {
    // A capture that never settles — the #529 compositor hang.
    mockWebContents.debugger.sendCommand.mockReturnValueOnce(new Promise(() => {}));
    (mockWebContents as Record<string, unknown>)['capturePage'] = vi.fn(async () => ({
      isEmpty: () => false,
      toPNG: () => Buffer.from('fallback-png'),
    }));
    const router = register();
    const p = router.dispatch({ id: 's2', method: 'browser.screenshot', params: {} });
    await vi.advanceTimersByTimeAsync(3000);
    const response = await p;
    expect(response.ok).toBe(true);
    if (response.ok) {
      expect(response.result).toEqual({ data: Buffer.from('fallback-png').toString('base64') });
    }
  });

  it('fails with a clear error when the CDP capture hangs AND capturePage is empty', async () => {
    mockWebContents.debugger.sendCommand.mockReturnValueOnce(new Promise(() => {}));
    (mockWebContents as Record<string, unknown>)['capturePage'] = vi.fn(async () => ({
      isEmpty: () => true,
      toPNG: () => Buffer.alloc(0),
    }));
    const router = register();
    const p = router.dispatch({ id: 's3', method: 'browser.screenshot', params: {} });
    await vi.advanceTimersByTimeAsync(3000);
    const response = await p;
    expect(response.ok).toBe(false);
    if (!response.ok) expect(response.error).toContain('not producing frames');
  });

  it('a rejected CDP capture (debugger detached) also falls back instead of throwing', async () => {
    mockWebContents.debugger.sendCommand.mockRejectedValueOnce(new Error('Debugger detached'));
    (mockWebContents as Record<string, unknown>)['capturePage'] = vi.fn(async () => ({
      isEmpty: () => false,
      toPNG: () => Buffer.from('after-detach'),
    }));
    const router = register();
    const p = router.dispatch({ id: 's4', method: 'browser.screenshot', params: {} });
    await vi.advanceTimersByTimeAsync(3000);
    const response = await p;
    expect(response.ok).toBe(true);
  });
});

// ── #695 a scoped caller cannot reach another workspace ──────────────────────
// These drive the handlers against an ownership-enforcing stand-in rather than
// a permissive spy. Asserting that getTarget was *called* with a workspace
// would pass just as well if the manager ignored it — the property is that a
// foreign surface cannot be read, driven, navigated or leased.
describe('registerBrowserRpc — scoped callers stay inside their workspace (#695)', () => {
  const OWN = {
    surfaceId: 'own-surface', webContentsId: 42,
    targetId: 'target-own', wsUrl: 'ws://127.0.0.1/devtools/page/own', workspaceId: 'ws-a',
  };
  const FOREIGN = {
    surfaceId: 'foreign-surface', webContentsId: 43,
    targetId: 'target-foreign', wsUrl: 'ws://127.0.0.1/devtools/page/foreign', workspaceId: 'ws-b',
  };

  function registerScoped() {
    const sessions = new Map([[OWN.surfaceId, OWN], [FOREIGN.surfaceId, FOREIGN]]);
    const owns = (t: typeof OWN, ws?: string) => !ws || t.workspaceId === ws;
    const cdp = {
      getTarget: vi.fn((surfaceId?: string, ws?: string) => {
        if (surfaceId) {
          const t = sessions.get(surfaceId);
          return t && owns(t, ws) ? t : null;
        }
        for (const t of sessions.values()) if (owns(t, ws)) return t;
        return null;
      }),
      // Scoped wait: a surface the caller does not own is indistinguishable
      // from one that is not there — both time out.
      waitForTarget: vi.fn(async (surfaceId: string, _timeout?: number, ws?: string) => {
        const t = sessions.get(surfaceId);
        if (t && owns(t, ws)) return t;
        throw new Error(`timeout waiting for CDP target: ${surfaceId}`);
      }),
      ensureAwake: vi.fn(async () => null),
      listTargets: vi.fn(() => [...sessions.values()]),
      getCdpPort: vi.fn(() => 18800),
      setCaptureCleanup: vi.fn(),
      withAutomationLease: vi.fn(async (_s: string, fn: () => Promise<unknown>) => fn()),
      acquireRpcLease: vi.fn((sid: string) => `lease-for-${sid}`),
      renewRpcLease: vi.fn(() => true),
      releaseRpcLease: vi.fn(() => true),
    };
    const router = new RpcRouter();
    registerBrowserRpc(router, () => null as unknown as BrowserWindow, cdp as never);
    return { router, cdp };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mockWebContents.isDestroyed.mockReturnValue(false);
    sendToRendererMock.mockResolvedValue({ ok: true });
    // Primed here, not inherited: without it validateUrl throws a TypeError
    // and every navigate case below fails before reaching what it tests —
    // which makes the ok:false assertions pass for the wrong reason and only
    // shows up when this block is run on its own.
    validateResolvedNavigationUrlMock.mockResolvedValue({ valid: true });
    mockWebContents.loadURL.mockResolvedValue(undefined);
  });

  it('does not evaluate in a surface owned by another workspace', async () => {
    const { router } = registerScoped();

    const response = await router.dispatch({
      id: 'x1',
      method: 'browser.evaluate',
      params: { expression: 'document.cookie', surfaceId: FOREIGN.surfaceId, workspaceId: 'ws-a' },
    });

    expect(response.ok).toBe(false);
    // The guest was never driven — not merely a refused response after the fact.
    expect(mockWebContents.debugger.sendCommand).not.toHaveBeenCalled();
  });

  it('still evaluates in a surface the caller does own', async () => {
    const { router } = registerScoped();

    const response = await router.dispatch({
      id: 'x2',
      method: 'browser.evaluate',
      params: { expression: '1+1', surfaceId: OWN.surfaceId, workspaceId: 'ws-a' },
    });

    expect(response.ok).toBe(true);
    expect(mockWebContents.debugger.sendCommand).toHaveBeenCalled();
  });

  it('refuses to navigate a foreign surface instead of handing it to the renderer', async () => {
    // The renderer bridge resolves a surface id with no workspace check, so
    // falling through to it would undo the refusal one layer down.
    const { router } = registerScoped();

    const response = await router.dispatch({
      id: 'n1',
      method: 'browser.navigate',
      params: { url: 'https://example.com', surfaceId: FOREIGN.surfaceId, workspaceId: 'ws-a' },
    });

    expect(response.ok).toBe(false);
    expect(sendToRendererMock).not.toHaveBeenCalled();
  });

  it('keeps the renderer navigate fallback for an unscoped caller', async () => {
    // Packaged builds route the whole tool set through this path; only a
    // caller that named a workspace loses it.
    const { router } = registerScoped();

    const response = await router.dispatch({
      id: 'n2',
      method: 'browser.navigate',
      params: { url: 'https://example.com', surfaceId: 'ghost-surface' },
    });

    expect(response.ok).toBe(true);
    expect(sendToRendererMock).toHaveBeenCalledWith(
      expect.anything(), 'browser.navigate',
      expect.objectContaining({ surfaceId: 'ghost-surface' }),
    );
  });

  it('browser.cdp.target answers a foreign surface exactly as it answers a missing one', async () => {
    // Not compared against the no-surfaceId case — that one legitimately
    // differs. The pair that must be indistinguishable is "exists, not yours"
    // versus "does not exist", in message and in the path taken to get there.
    const { router } = registerScoped();

    const foreign = await router.dispatch({
      id: 'c1', method: 'browser.cdp.target',
      params: { surfaceId: FOREIGN.surfaceId, workspaceId: 'ws-a' },
    });
    const missing = await router.dispatch({
      id: 'c2', method: 'browser.cdp.target',
      params: { surfaceId: 'no-such-surface', workspaceId: 'ws-a' },
    });

    expect(foreign.ok).toBe(true);
    expect(missing.ok).toBe(true);
    if (foreign.ok && missing.ok) {
      expect(foreign.result).toEqual(missing.result);
      expect(JSON.stringify(foreign.result)).not.toContain('target-foreign');
    }
  });

  it('never leases a foreign surface for a scoped caller', async () => {
    const { router, cdp } = registerScoped();

    const response = await router.dispatch({
      id: 'l1', method: 'browser.lease.acquire',
      params: { surfaceId: FOREIGN.surfaceId, workspaceId: 'ws-a' },
    });

    expect(response.ok).toBe(true);
    if (response.ok) expect(response.result).toEqual({ token: null });
    expect(cdp.acquireRpcLease).not.toHaveBeenCalled();
  });
});

// ── #695 round two: the navigate fallback, in every combination ──────────────
// The first attempt guarded on `scope && surfaceId`, which left the case the
// issue is actually about — a scoped caller with no surface id, whose default
// selection is the workspace-blind one — still falling through. It also refused
// a caller whose ownership had already been proven and whose CDP call merely
// failed. Both directions are pinned here.
describe('registerBrowserRpc — navigate fallback under a scope (#695)', () => {
  const OWN = {
    surfaceId: 'own-surface', webContentsId: 42,
    targetId: 'target-own', wsUrl: 'ws://127.0.0.1/devtools/page/own', workspaceId: 'ws-a',
  };
  const FOREIGN = {
    surfaceId: 'foreign-surface', webContentsId: 43,
    targetId: 'target-foreign', wsUrl: 'ws://127.0.0.1/devtools/page/foreign', workspaceId: 'ws-b',
  };

  function registerWith(sessions: Map<string, typeof OWN>) {
    const owns = (t: typeof OWN, ws?: string) => !ws || t.workspaceId === ws;
    const cdp = {
      getTarget: vi.fn((surfaceId?: string, ws?: string) => {
        if (surfaceId) {
          const t = sessions.get(surfaceId);
          return t && owns(t, ws) ? t : null;
        }
        for (const t of sessions.values()) if (owns(t, ws)) return t;
        return null;
      }),
      waitForTarget: vi.fn(),
      ensureAwake: vi.fn(async () => null),
      listTargets: vi.fn(() => [...sessions.values()]),
      getCdpPort: vi.fn(() => 18800),
      setCaptureCleanup: vi.fn(),
      withAutomationLease: vi.fn(async (_s: string, fn: () => Promise<unknown>) => fn()),
      acquireRpcLease: vi.fn(() => 'lease-1'),
      renewRpcLease: vi.fn(() => true),
      releaseRpcLease: vi.fn(() => true),
    };
    const router = new RpcRouter();
    registerBrowserRpc(router, () => null as unknown as BrowserWindow, cdp as never);
    return { router, cdp };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mockWebContents.isDestroyed.mockReturnValue(false);
    sendToRendererMock.mockResolvedValue({ ok: true });
    // Primed here, not inherited: without it validateUrl throws a TypeError
    // and every navigate case below fails before reaching what it tests —
    // which makes the ok:false assertions pass for the wrong reason and only
    // shows up when this block is run on its own.
    validateResolvedNavigationUrlMock.mockResolvedValue({ valid: true });
    mockWebContents.loadURL.mockResolvedValue(undefined);
  });

  it('refuses a scoped caller that owns nothing, with no surface id to hide behind', async () => {
    // The bridge would have picked its own default here — someone else's pane.
    const { router } = registerWith(new Map([[FOREIGN.surfaceId, FOREIGN]]));

    const response = await router.dispatch({
      id: 'nv1', method: 'browser.navigate',
      params: { url: 'https://example.com', workspaceId: 'ws-a' },
    });

    expect(response.ok).toBe(false);
    expect(sendToRendererMock).not.toHaveBeenCalled();
  });

  it('still lets a proven owner use the bridge when CDP itself fails', async () => {
    // Ownership was established before the CDP attempt, so a loadURL failure
    // is a transport problem, not an authorization one.
    mockWebContents.loadURL.mockRejectedValueOnce(new Error('CDP navigation failed'));
    const { router } = registerWith(new Map([[OWN.surfaceId, OWN]]));

    const response = await router.dispatch({
      id: 'nv2', method: 'browser.navigate',
      params: { url: 'https://example.com', surfaceId: OWN.surfaceId, workspaceId: 'ws-a' },
    });

    expect(response.ok).toBe(true);
    expect(sendToRendererMock).toHaveBeenCalledWith(
      expect.anything(), 'browser.navigate',
      expect.objectContaining({ surfaceId: OWN.surfaceId }),
    );
  });

  it('pins the bridge to the resolved surface when a scoped caller named none', async () => {
    // Without this the bridge falls back to its own default pick, which is the
    // workspace-blind selection the scope just avoided.
    mockWebContents.loadURL.mockRejectedValueOnce(new Error('CDP navigation failed'));
    const { router } = registerWith(new Map([[FOREIGN.surfaceId, FOREIGN], [OWN.surfaceId, OWN]]));

    const response = await router.dispatch({
      id: 'nv3', method: 'browser.navigate',
      params: { url: 'https://example.com', workspaceId: 'ws-a' },
    });

    expect(response.ok).toBe(true);
    expect(sendToRendererMock).toHaveBeenCalledWith(
      expect.anything(), 'browser.navigate',
      expect.objectContaining({ surfaceId: OWN.surfaceId }),
    );
  });

  it('leaves the unscoped fallback exactly as it was', async () => {
    const { router } = registerWith(new Map());

    const response = await router.dispatch({
      id: 'nv4', method: 'browser.navigate',
      params: { url: 'https://example.com' },
    });

    expect(response.ok).toBe(true);
    // No surfaceId sent, no workspace pinned — the historical shape.
    expect(sendToRendererMock).toHaveBeenCalledWith(
      expect.anything(), 'browser.navigate', { url: 'https://example.com' },
    );
  });
});
