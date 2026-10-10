import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrowserWindow } from 'electron';
import { RpcRouter } from '../../RpcRouter';
import { registerBrowserRpc } from '../browser.rpc';
import { surfaceOpeners } from '../../../browser-session/SurfaceOpeners';
import { ChromeProfileStore } from '../../../browser-session/ChromeProfileStore';
import { BrowserPolicyStore } from '../../../browser-session/BrowserPolicyStore';
import type { BrowserBackendStore } from '../../../browser-session/BrowserBackendStore';
import { getWorkspaceMirror, __resetWorkspaceMirrorForTest } from '../../../workspace/WorkspaceMirror';
import { BROWSER_POLICY_FILE } from '../../../../shared/browserPolicy';
import { dispatchAsClaimedCaller } from './claimedCaller';
import { __resetProfileNamespaceStoreForTest } from '../../../browser-session/ProfileNamespaceStore';

/**
 * Protected panes at the RPC boundary: the upstream gate. Real policy and
 * profile stores, fake launchers. pane-a (pty-a) is bound to its own profile
 * "pa" and protected with allow=[a.test]; pane-b (pty-b) in the same
 * workspace is not.
 */

const { sendToRendererMock } = vi.hoisted(() => ({ sendToRendererMock: vi.fn() }));
vi.mock('../_bridge', () => ({ sendToRenderer: sendToRendererMock }));
vi.mock('electron', () => ({
  webContents: { fromId: vi.fn(() => null) },
  shell: { openExternal: vi.fn() },
}));
vi.mock('../../../security/navigationPolicy', () => ({
  validateResolvedNavigationUrl: vi.fn(async () => ({ valid: true })),
}));

function makeLauncher(profile: string) {
  let next = 0;
  return {
    endpoint: vi.fn(async () => ({ cdpPort: 19000 })),
    cdpInfoTargets: vi.fn(async () => []),
    openTab: vi.fn(async (url: string) => ({ surfaceId: `${profile}-sfc-${++next}`, targetId: `t-${next}`, url })),
    listTargets: vi.fn(async () => []),
    closeSurface: vi.fn(async () => true),
    hasSurface: vi.fn(() => false),
    dispose: vi.fn(),
  };
}

function makeRegistry(store: ChromeProfileStore) {
  const launchers = new Map<string, ReturnType<typeof makeLauncher>>();
  return {
    launchers,
    forProfile: vi.fn((profile: string) => {
      let l = launchers.get(profile);
      if (!l) launchers.set(profile, (l = makeLauncher(profile)));
      return l;
    }),
    profileFor: vi.fn((ws?: string, paneId?: string) => store.profileFor(ws, paneId)),
    hasPaneBindings: vi.fn((ws?: string) => store.hasPaneBindings(ws)),
    isPaneBound: vi.fn((profile: string) => store.isPaneBound(profile)),
    ownerOfSurface: vi.fn((_id: string): unknown => null),
    statusForProfile: vi.fn(async (profile: string) => ({ profile, running: true, cdpPort: 19000 })),
    disposeAll: vi.fn(),
  };
}

let backend: 'chrome' | 'builtin' = 'chrome';
let registry: ReturnType<typeof makeRegistry>;

/** Surface ids the fake in-app browser (webview manager) knows. */
const webviewSurfaces = new Set<string>();

function register(profiles: ChromeProfileStore, policy: BrowserPolicyStore): RpcRouter {
  const router = dispatchAsClaimedCaller(new RpcRouter());
  const cdp = {
    getTarget: vi.fn((surfaceId?: string) =>
      surfaceId && webviewSurfaces.has(surfaceId) ? { surfaceId, webContentsId: 1 } : null),
    listTargets: vi.fn(() => []),
    isDiscarded: vi.fn(() => false),
    getCdpPort: vi.fn(() => 18800),
    waitForTarget: vi.fn(),
    ensureAwake: vi.fn(async () => null),
    setCaptureCleanup: vi.fn(),
    setCaptureAttach: vi.fn(),
    withAutomationLease: vi.fn(async (_s: string, fn: () => Promise<unknown>) => fn()),
    acquireRpcLease: vi.fn(() => 'lease-1'),
    renewRpcLease: vi.fn(() => true),
    releaseRpcLease: vi.fn(() => true),
  };
  registerBrowserRpc(
    router,
    () => null as unknown as BrowserWindow,
    cdp as never,
    { get: () => backend, set: vi.fn(), liveWriteScope: () => 'agent' } as unknown as BrowserBackendStore,
    undefined,
    undefined,
    (registry = makeRegistry(profiles)) as never,
    undefined,
    undefined,
    undefined,
    { store: policy, paneBindings: () => profiles.getPaneBindings() },
  );
  return router;
}

async function call(router: RpcRouter, method: string, params: Record<string, unknown>, callerPtyId?: string) {
  const response = await router.dispatch({ id: '1', method, params, ...(callerPtyId && { callerPtyId }) } as never);
  if (response.ok) return { result: (response as { result?: unknown }).result, error: undefined };
  return { result: undefined, error: String((response as { error?: unknown }).error ?? '') };
}

let dir: string;
let profiles: ChromeProfileStore;
let policy: BrowserPolicyStore;

async function protectPaneA(allow = ['a.test']): Promise<void> {
  await policy.write(
    {
      workspaceId: 'ws-1',
      paneId: 'pane-a',
      profileId: 'pa',
      protected: true,
      hosts: { mode: 'allowlist', allow, block: [] },
      expectedEpoch: policy.epoch(),
    },
    'pa',
    true,
  );
}

beforeEach(async () => {
  backend = 'chrome';
  dir = mkdtempSync(join(tmpdir(), 'wmux-protected-rpc-'));
  profiles = new ChromeProfileStore(dir);
  await profiles.create('pa');
  await profiles.setPaneBinding('pane-a', 'ws-1', 'pa');
  policy = new BrowserPolicyStore(dir);
  __resetProfileNamespaceStoreForTest(dir);
  __resetWorkspaceMirrorForTest();
  getWorkspaceMirror().setSnapshot({
    ts: Date.now(),
    entries: [{ id: 'ws-1', name: 'one', activePtyId: 'pty-a', ptyIds: ['pty-a', 'pty-b'] }],
    fleets: [],
    panePtys: { 'pty-a': 'pane-a', 'pty-b': 'pane-b' },
  });
  sendToRendererMock.mockReset();
  sendToRendererMock.mockResolvedValue([]);
  surfaceOpeners.clear();
  webviewSurfaces.clear();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  __resetWorkspaceMirrorForTest();
});

describe('protected-pane gate', () => {
  it('legacy (nothing ever protected): the gate never looks a pane up', async () => {
    const decisionFor = vi.spyOn(policy, 'decisionFor');
    const router = register(profiles, policy);
    const info = await call(router, 'browser.cdp.info', { workspaceId: 'ws-1' }, 'pty-a');
    expect(info.result).toMatchObject({ profile: 'pa' });
    expect(info.result).not.toHaveProperty('protected');
    const auth = await call(router, 'browser.lease.acquire', { workspaceId: 'ws-1', authorize: true }, 'pty-a');
    expect(auth.result).toEqual({ token: null, policy: { protected: false } });
    expect(decisionFor).not.toHaveBeenCalled();
    expect(sendToRendererMock).not.toHaveBeenCalled();
  });

  it('authorizes a protected pane with its hosts and epoch; its neighbour stays legacy', async () => {
    await protectPaneA();
    const router = register(profiles, policy);
    const a = await call(router, 'browser.lease.acquire', { workspaceId: 'ws-1', authorize: true }, 'pty-a');
    expect(a.result).toMatchObject({ token: null, policy: { protected: true, epoch: 1, hosts: { allow: ['a.test'] } } });
    const info = await call(router, 'browser.cdp.info', { workspaceId: 'ws-1' }, 'pty-a');
    expect(info.result).toMatchObject({ protected: true, policyEpoch: 1 });
    const b = await call(router, 'browser.lease.acquire', { workspaceId: 'ws-1', authorize: true }, 'pty-b');
    expect(b.result).toEqual({ token: null, policy: { protected: false } });
  });

  it('refuses hosts and schemes outside the policy at open / tabs new / navigate', async () => {
    await protectPaneA();
    const router = register(profiles, policy);
    expect((await call(router, 'browser.open', { workspaceId: 'ws-1', url: 'https://a.test/' }, 'pty-a')).error).toBeUndefined();
    expect((await call(router, 'browser.open', { workspaceId: 'ws-1' }, 'pty-a')).error).toBeUndefined(); // about:blank bootstrap
    for (const url of ['https://blocked.test/', 'file:///etc/passwd', 'javascript:alert(1)', 'data:text/html,x', 'chrome://settings']) {
      expect((await call(router, 'browser.open', { workspaceId: 'ws-1', url }, 'pty-a')).error).toContain('policy_denied');
    }
    expect((await call(router, 'browser.tabs', { workspaceId: 'ws-1', action: 'new', url: 'https://blocked.test/' }, 'pty-a')).error)
      .toContain('policy_denied');
    expect((await call(router, 'browser.navigate', { workspaceId: 'ws-1', url: 'view-source:https://a.test/' }, 'pty-a')).error)
      .toContain('policy_denied');
    // The unprotected neighbour is untouched.
    expect((await call(router, 'browser.open', { workspaceId: 'ws-1', url: 'https://blocked.test/' }, 'pty-b')).error).toBeUndefined();
  });

  it('refuses page scripts, raw cookies, the builtin target and site guides', async () => {
    await protectPaneA();
    const router = register(profiles, policy);
    for (const [method, extra] of [
      ['browser.evaluate', { expression: '1' }],
      ['browser.cookies', { action: 'get' }],
      ['browser.cdp.target', {}],
      ['browser.siteGuides.match', { url: 'https://a.test/' }],
    ] as const) {
      expect((await call(router, method, { workspaceId: 'ws-1', ...extra }, 'pty-a')).error, method).toContain('policy_denied');
    }
  });

  it('never shows a protected pane its Chrome CDP port', async () => {
    await protectPaneA();
    const router = register(profiles, policy);
    const status = await call(router, 'browser.session.status', { workspaceId: 'ws-1' }, 'pty-a');
    expect(status.result).toMatchObject({ profile: 'pa', port: null });
    const neighbour = await call(router, 'browser.session.status', { workspaceId: 'ws-1' }, 'pty-b');
    expect(neighbour.result).toMatchObject({ profile: 'default', port: 19000 });
  });

  it('never lets a protected pane drive a surface outside its own Chrome', async () => {
    await protectPaneA();
    const router = register(profiles, policy);
    // An in-app browser tab (a <webview>, not behind the proxy) of the same
    // workspace, and a tab of the pane's own Chrome.
    const webviewSurface = 'surface-webview-1';
    webviewSurfaces.add(webviewSurface);
    registry.ownerOfSurface.mockImplementation((id: string) =>
      id === 'pa-sfc-own' || id === 'pb-sfc-other'
        ? { workspaceId: 'ws-1', profile: id.slice(0, 2), client: registry.forProfile(id.slice(0, 2)) }
        : null);
    for (const [method, extra] of [
      ['browser.navigate', { url: 'https://a.test/' }],
      ['browser.screenshot', {}],
      ['browser.type.humanlike', { selector: '#x', text: 'hi' }],
      ['browser.surface.adopt', {}],
      ['browser.lease.acquire', { authorize: true }],
      ['browser.tabs', { action: 'select' }],
      ['browser.close', {}],
      ['browser.help.request', { prompt: 'help' }],
    ] as const) {
      const res = await call(router, method, { workspaceId: 'ws-1', surfaceId: webviewSurface, ...extra }, 'pty-a');
      expect(res.error, method).toContain('policy_denied');
    }
    // Another profile's Chrome tab is refused too.
    expect((await call(router, 'browser.navigate', { workspaceId: 'ws-1', surfaceId: 'pb-sfc-other', url: 'https://a.test/' }, 'pty-a')).error)
      .toContain('policy_denied');
    // Its own tab, and an id nothing knows (a stale pin), pass the gate; the
    // unprotected neighbour is unaffected.
    expect((await call(router, 'browser.navigate', { workspaceId: 'ws-1', surfaceId: 'gone-1', url: 'https://a.test/' }, 'pty-a')).error ?? '')
      .not.toContain('policy_denied');
    expect((await call(router, 'browser.navigate', { workspaceId: 'ws-1', surfaceId: 'pa-sfc-own', url: 'https://a.test/' }, 'pty-a')).error ?? '')
      .not.toContain('policy_denied');
    expect((await call(router, 'browser.navigate', { workspaceId: 'ws-1', surfaceId: webviewSurface, url: 'https://x.test/' }, 'pty-b')).error ?? '')
      .not.toContain('policy_denied');
  });

  it('refuses a protected pane on a non-Chrome backend', async () => {
    await protectPaneA();
    backend = 'builtin';
    const router = register(profiles, policy);
    expect((await call(router, 'browser.lease.acquire', { workspaceId: 'ws-1', authorize: true }, 'pty-a')).error)
      .toContain('policy_denied');
  });

  it('refuses an unidentified caller in a workspace with a protected pane', async () => {
    await protectPaneA();
    const router = register(profiles, policy);
    // A pane claim for a PTY no pane owns (an auto-<runId> PTY, say).
    expect((await call(router, 'browser.lease.acquire', { workspaceId: 'ws-1', authorize: true }, 'auto-run-1')).error)
      .toContain('policy_denied');
  });

  it('after a rebind the pane is deny-all until confirmed again', async () => {
    await protectPaneA();
    await policy.onPaneRebind('pane-a');
    const router = register(profiles, policy);
    const opened = await call(router, 'browser.open', { workspaceId: 'ws-1', url: 'https://a.test/' }, 'pty-a');
    expect(opened.error).toContain('confirmed again');
  });

  it('a corrupt policy file refuses the previously protected pane and leaves its neighbour alone', async () => {
    await protectPaneA();
    writeFileSync(join(dir, BROWSER_POLICY_FILE), '{ torn');
    const router = register(profiles, new BrowserPolicyStore(dir));
    expect((await call(router, 'browser.cdp.info', { workspaceId: 'ws-1' }, 'pty-a')).error).toContain('policy_denied');
    expect((await call(router, 'browser.cdp.info', { workspaceId: 'ws-1' }, 'pty-b')).error).toBeUndefined();
  });
});

describe('protected-pane memory: per-account namespaces', () => {
  const trace = (name: string) => ({
    id: `tr_${name}`,
    name,
    urlKey: 'a.test/',
    surfaceShape: '',
    steps: [{ tool: 'browser_navigate', axis: null, args: { url: 'https://a.test/' } }],
    observedCount: 1,
    successCount: 0,
    failCount: 0,
    createdAt: Date.now(),
    lastUsedAt: Date.now(),
  });
  const names = (r: { result?: unknown }) => ((r.result as { traces?: Array<{ name: string }> })?.traces ?? []).map((t) => t.name);

  it('a protected pane starts empty and never sees the workspace (legacy) memory, nor the reverse', async () => {
    const router = register(profiles, policy);
    // Recorded by the unprotected neighbour, under the legacy workspace key.
    expect((await call(router, 'browser.actionCache.put', { workspaceId: 'ws-1', trace: trace('legacy-flow') }, 'pty-b')).result)
      .toMatchObject({ ok: true });
    await protectPaneA();
    expect(names(await call(router, 'browser.actionCache.list', { workspaceId: 'ws-1' }, 'pty-a'))).toEqual([]);
    const epoch = policy.epoch();
    expect((await call(router, 'browser.actionCache.put', { workspaceId: 'ws-1', trace: trace('account-flow'), policyEpoch: epoch }, 'pty-a')).result)
      .toMatchObject({ ok: true });
    expect(names(await call(router, 'browser.actionCache.list', { workspaceId: 'ws-1' }, 'pty-a'))).toEqual(['account-flow']);
    // The neighbour keeps exactly what it had.
    expect(names(await call(router, 'browser.actionCache.list', { workspaceId: 'ws-1' }, 'pty-b'))).toEqual(['legacy-flow']);
  });

  it('ignores a workspace or profile the caller names', async () => {
    await protectPaneA();
    const router = register(profiles, policy);
    await call(router, 'browser.actionCache.put', { workspaceId: 'ws-1', trace: trace('mine'), policyEpoch: policy.epoch() }, 'pty-a');
    const listed = await call(router, 'browser.actionCache.list', { workspaceId: 'ws-1', profile: 'default', profileId: 'other' }, 'pty-a');
    expect(names(listed)).toEqual(['mine']);
  });

  it('refuses a completion recorded under an earlier policy epoch', async () => {
    await protectPaneA();
    const router = register(profiles, policy);
    const stale = policy.epoch();
    await protectPaneA(['a.test', 'b.test']);
    const res = await call(router, 'browser.actionCache.put', { workspaceId: 'ws-1', trace: trace('late'), policyEpoch: stale }, 'pty-a');
    expect(res.error).toContain('policy_denied');
    const missing = await call(router, 'browser.siteMemory.record', { workspaceId: 'ws-1', domain: 'a.test', kind: 'success' }, 'pty-a');
    expect(missing.error).toContain('policy_denied');
  });

  it('a rebind back to the same profile still starts a fresh namespace', async () => {
    await protectPaneA();
    const router = register(profiles, policy);
    await call(router, 'browser.actionCache.put', { workspaceId: 'ws-1', trace: trace('old'), policyEpoch: policy.epoch() }, 'pty-a');
    await profiles.create('pb');
    await profiles.setPaneBinding('pane-a', 'ws-1', 'pb');
    await policy.onPaneRebind('pane-a');
    await profiles.setPaneBinding('pane-a', 'ws-1', 'pa');
    await policy.onPaneRebind('pane-a');
    await protectPaneA();
    expect(names(await call(router, 'browser.actionCache.list', { workspaceId: 'ws-1' }, 'pty-a'))).toEqual([]);
  });

  it('a completion recorded while protected never lands in the workspace memory after protection is turned off', async () => {
    await protectPaneA();
    const router = register(profiles, policy);
    const epoch = policy.epoch();
    await policy.write(
      { workspaceId: 'ws-1', paneId: 'pane-a', profileId: 'pa', protected: false, hosts: { mode: 'allowlist', allow: ['a.test'], block: [] }, expectedEpoch: policy.epoch() },
      'pa',
      true,
    );
    const res = await call(router, 'browser.actionCache.put', { workspaceId: 'ws-1', trace: trace('late'), policyEpoch: epoch }, 'pty-a');
    expect(res.error).toContain('policy_denied');
    expect(names(await call(router, 'browser.actionCache.list', { workspaceId: 'ws-1' }, 'pty-b'))).not.toContain('late');
  });

  it('a rebind starts a fresh namespace, and an unconfirmed pane gets no memory at all', async () => {
    await protectPaneA();
    const router = register(profiles, policy);
    await call(router, 'browser.actionCache.put', { workspaceId: 'ws-1', trace: trace('before'), policyEpoch: policy.epoch() }, 'pty-a');
    await profiles.create('pa2');
    await profiles.setPaneBinding('pane-a', 'ws-1', 'pa2');
    await policy.onPaneRebind('pane-a');
    expect((await call(router, 'browser.actionCache.list', { workspaceId: 'ws-1' }, 'pty-a')).error).toContain('policy_denied');
    await policy.write(
      { workspaceId: 'ws-1', paneId: 'pane-a', profileId: 'pa2', protected: true, hosts: { mode: 'allowlist', allow: ['a.test'], block: [] }, expectedEpoch: policy.epoch() },
      'pa2',
      true,
    );
    expect(names(await call(router, 'browser.actionCache.list', { workspaceId: 'ws-1' }, 'pty-a'))).toEqual([]);
  });
});

describe('scheduled runs acting as a protected pane', () => {
  let liveRuns: Map<string, { runId: string; automationId: string; revision: number; identity: Record<string, unknown> }>;
  const notes: Array<{ runId: string; detail: string }> = [];

  async function grantRun(ptyId: string, over: Record<string, unknown> = {}) {
    const { recordRunIdentity, panePolicyFingerprint } = await import('../../../automation/runIdentity');
    const snapshot = {
      automationId: 'auto-a1', boundRevision: 2, workspaceId: 'ws-1', paneId: 'pane-a', profileId: 'pa', hosts: ['a.test'],
      fingerprint: panePolicyFingerprint(policy.entryFor('pane-a'), profiles.getPaneBindings()['pane-a']?.profile),
      ...over,
    };
    await recordRunIdentity(snapshot as never);
    liveRuns.set(ptyId, { runId: `r-${ptyId}`, automationId: snapshot.automationId, revision: 2, identity: { workspaceId: 'ws-1', paneId: 'pane-a', boundRevision: 2 } });
  }

  async function asRun(router: RpcRouter, method: string, params: Record<string, unknown>, ptyId: string) {
    const { claimTokenForRun } = await import('../../../workspace/workspaceClaimTrust');
    const token = claimTokenForRun('ws-1', ptyId);
    const response = await router.dispatch({ id: '1', method, params, workspaceToken: token, callerPtyId: ptyId } as never, { externalWire: true } as never);
    if (response.ok) return { result: (response as { result?: unknown }).result, error: undefined };
    return { result: undefined, error: String((response as { error?: unknown }).error ?? '') };
  }

  beforeEach(async () => {
    const { __setRunIdentityStoreDirForTest, setRunIdentityTransport } = await import('../../../automation/runIdentity');
    __setRunIdentityStoreDirForTest(dir);
    liveRuns = new Map();
    notes.length = 0;
    setRunIdentityTransport({
      rpc: async (method: string, params?: Record<string, unknown>) => {
        if (method === 'automation.runIdentity') {
          const run = liveRuns.get(String(params?.['ptyId']));
          return { run: run ? { runId: run.runId, automationId: run.automationId, revision: run.revision, ptyId: params?.['ptyId'], browserIdentity: run.identity } : null };
        }
        if (method === 'automation.noteRunBrowser') {
          notes.push({ runId: String(params?.['runId']), detail: String(params?.['detail']) });
          return { ok: true };
        }
        return null;
      },
    });
  });

  afterEach(async () => {
    const { setRunIdentityTransport, __setRunIdentityStoreDirForTest } = await import('../../../automation/runIdentity');
    setRunIdentityTransport(null);
    __setRunIdentityStoreDirForTest(null);
  });

  it("an owned run acts as its snapshot's pane: that pane's profile and hosts", async () => {
    await protectPaneA();
    await grantRun('auto-r1');
    const router = register(profiles, policy);
    const auth = await asRun(router, 'browser.lease.acquire', { workspaceId: 'ws-1', authorize: true }, 'auto-r1');
    expect(auth.result).toMatchObject({ policy: { protected: true, hosts: { allow: ['a.test'] } } });
    const info = await asRun(router, 'browser.cdp.info', { workspaceId: 'ws-1' }, 'auto-r1');
    expect(info.result).toMatchObject({ profile: 'pa', protected: true });
    expect((await asRun(router, 'browser.open', { workspaceId: 'ws-1', url: 'https://blocked.test/' }, 'auto-r1')).error)
      .toContain('policy_denied');
    expect(notes).toEqual([{ runId: 'r-auto-r1', detail: 'browser_policy_denied' }]);
  });

  it('a policy change, a protection removal or a rebind after the grant fails fast with needs_consent, recorded on the run', async () => {
    await protectPaneA();
    await grantRun('auto-r1');
    const router = register(profiles, policy);
    // An added block / revoked host moves the epoch.
    await protectPaneA(['a.test', 'other.test']);
    const changed = await asRun(router, 'browser.open', { workspaceId: 'ws-1', url: 'https://a.test/' }, 'auto-r1');
    expect(changed.error).toContain('needs_consent');
    expect(notes.at(-1)).toEqual({ runId: 'r-auto-r1', detail: 'browser_needs_consent' });
    // Protection turned off entirely.
    await policy.write(
      { workspaceId: 'ws-1', paneId: 'pane-a', profileId: 'pa', protected: false, hosts: { mode: 'allowlist', allow: ['a.test'], block: [] }, expectedEpoch: policy.epoch() },
      'pa',
      true,
    );
    await grantRun('auto-r2', { fingerprint: (await import('../../../automation/runIdentity')).panePolicyFingerprint(policy.entryFor('pane-a'), 'pa') });
    expect((await asRun(router, 'browser.cdp.info', { workspaceId: 'ws-1' }, 'auto-r2')).error).toContain('needs_consent');
  });

  it('a missing profile fails immediately', async () => {
    await protectPaneA();
    await grantRun('auto-r1', { profileId: 'gone' });
    const router = register(profiles, policy);
    expect((await asRun(router, 'browser.cdp.info', { workspaceId: 'ws-1' }, 'auto-r1')).error).toContain('needs_consent');
  });

  it('an auto- PTY the daemon does not vouch for, or with no snapshot in main, gets nothing', async () => {
    await protectPaneA();
    const router = register(profiles, policy);
    expect((await asRun(router, 'browser.cdp.info', { workspaceId: 'ws-1' }, 'auto-unowned')).error).toContain('policy_denied');
    await grantRun('auto-r1');
    // The daemon names a revision main never recorded (a reference it made up).
    const run = liveRuns.get('auto-r1')!;
    run.revision = 3;
    run.identity = { ...run.identity, boundRevision: 3 };
    expect((await asRun(router, 'browser.cdp.info', { workspaceId: 'ws-1' }, 'auto-r1')).error).toContain('policy_denied');
  });

  it("an edit to another pane's policy does not touch the run", async () => {
    await protectPaneA();
    await profiles.create('pb');
    await profiles.setPaneBinding('pane-b', 'ws-1', 'pb');
    await grantRun('auto-r1');
    await policy.write(
      { workspaceId: 'ws-1', paneId: 'pane-b', profileId: 'pb', protected: true, hosts: { mode: 'allowlist', allow: ['b.test'], block: [] }, expectedEpoch: policy.epoch() },
      'pb',
      true,
    );
    const router = register(profiles, policy);
    expect((await asRun(router, 'browser.cdp.info', { workspaceId: 'ws-1' }, 'auto-r1')).result).toMatchObject({ profile: 'pa' });
  });

  it('a run is never left waiting on a person: help requests fail fast', async () => {
    await protectPaneA();
    await grantRun('auto-r1');
    const router = register(profiles, policy);
    const res = await asRun(router, 'browser.help.request', { workspaceId: 'ws-1', reason: 'captcha' }, 'auto-r1');
    expect(res.error).toContain('needs_consent');
    expect(notes.at(-1)).toEqual({ runId: 'r-auto-r1', detail: 'browser_needs_consent' });
  });

  it('a run claim may call the browser and nothing else of wmux', async () => {
    await protectPaneA();
    await grantRun('auto-r1');
    const router = register(profiles, policy);
    router.register('workspace.list' as never, async () => ({ workspaces: [] }));
    const other = await asRun(router, 'workspace.list', {}, 'auto-r1');
    expect(other.error).toContain('browser tools only');
  });
});
