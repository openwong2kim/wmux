// browser.cdp.grant: who may be handed a relay token for a script in a wmux
// pane, what it is minted with, and that the client it connects ends with
// what it was granted on. A real relay (fake Chrome behind it), the real
// router and claim registry; main's peer walk is stood in for (its own walk is
// covered against a real process tree in browser.cdp.grant.walk.e2e.os.test).
import fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import type { BrowserWindow } from 'electron';
import { RpcRouter } from '../../RpcRouter';
import { paneScriptGrantRefusal, registerBrowserRpc, relayLaneOf } from '../browser.rpc';
import { setPaneOfPeer } from '../peerPidShadow';
import type { RpcContext } from '../../../../shared/rpc';
import { WMUX_CLI_CLIENT_NAME } from '../../../../shared/rpc';
import { CdpPipeMux, type CallerIdentity } from '../../../browser-session/CdpPipeMux';
import { CdpPipeRelay, type RelayGrant } from '../../../browser-session/CdpPipeRelay';
import { closeRelayClients, relayAdmissionRefusal, setPipeRelayForTests, setRelayAdmission } from '../../../browser-session/ChromeLauncher';
import { wireRelayClientTriggers, type RelayClientTriggers } from '../../../browser-session/relayClientTriggers';
import { FakeBrowser } from '../../../browser-session/__tests__/fakePipeBrowser';
import { WorkspaceMirror } from '../../../workspace/WorkspaceMirror';
import {
  __resetWorkspaceClaimTrustForTesting,
  claimTokenForPane,
  claimTokenForRun,
  mintWorkspaceClaimToken,
  onPaneClaimChange,
  revokeWorkspaceClaimToken,
} from '../../../workspace/workspaceClaimTrust';
import { FIRST_PARTY_CLIENT_NAMES } from '../../../mcp/firstParty';

vi.mock('electron', () => ({
  webContents: { fromId: vi.fn(() => null) },
  shell: { openExternal: vi.fn() },
}));
vi.mock('../_bridge', () => ({ sendToRenderer: vi.fn(async () => null) }));

const posix = process.platform !== 'win32';
/** Windows reads no peer process, so a grant is refused there before anything else (pinned below). */
const onWindows = !posix;
const cleanup: Array<() => void | Promise<void>> = [];

interface Rig {
  router: RpcRouter;
  launcher: {
    endpoint: ReturnType<typeof vi.fn>;
    relayGrant: ReturnType<typeof vi.fn>;
    narrowedFor: ReturnType<typeof vi.fn>;
  };
  registry: { profileFor: ReturnType<typeof vi.fn> };
  mirror: WorkspaceMirror;
  triggers: RelayClientTriggers;
  held: Array<{ surfaceId: string; active: boolean; mode: 'agent' | 'paused' | 'user' }>;
  surfaces: Map<string, string>;
  peer: { current: { workspaceId: string; ptyId: string } | null };
}

function rig(): Rig {
  const root = posix ? fs.mkdtempSync('/tmp/wmux-cg-') : null;
  if (root) fs.chmodSync(root, 0o700);
  const relay = new CdpPipeRelay({ roots: root ? [root] : [] });
  void setPipeRelayForTests(relay);
  const browser = new FakeBrowser();
  const mux = new CdpPipeMux(browser.fromMux, browser.toMux);
  const route = relay.serve(mux);
  const launcher = {
    endpoint: vi.fn(async () => ({ piped: true as const })),
    relayGrant: vi.fn((identity: CallerIdentity) => route.grant(identity)),
    narrowedFor: vi.fn(() => true),
    cdpInfoTargets: vi.fn(async () => []),
    dispose: vi.fn(),
  };
  const registry = {
    profileFor: vi.fn(() => 'work'),
    hasPaneBindings: vi.fn(() => false),
    isPaneBound: vi.fn(() => false),
    forProfile: vi.fn(() => launcher),
    ownerOfSurface: vi.fn(() => null),
    disposeAll: vi.fn(),
  };
  const surfaces = new Map<string, string>();
  const held: Rig['held'] = [];
  const router = new RpcRouter();
  registerBrowserRpc(
    router,
    () => null as unknown as BrowserWindow,
    {
      getTarget: vi.fn((surfaceId?: string) => (surfaceId && surfaces.has(surfaceId) ? { surfaceId, workspaceId: surfaces.get(surfaceId) } : null)),
      listTargets: vi.fn(() => []),
      getCdpPort: vi.fn(() => 18800),
      waitForTarget: vi.fn(),
      ensureAwake: vi.fn(async () => null),
      setCaptureCleanup: vi.fn(),
      setCaptureAttach: vi.fn(),
      isDiscarded: vi.fn(() => false),
    } as never,
    { get: () => 'chrome', set: vi.fn() } as never,
    undefined,
    undefined,
    registry as never,
    undefined,
    undefined,
    undefined,
    undefined,
    { refusal: () => null, forget: vi.fn(), list: () => held },
  );
  const mirror = new WorkspaceMirror();
  mirror.setSnapshot({ ts: 0, entries: [{ id: 'ws-1', name: 'one', ptyIds: ['pty-1', 'pty-2'] }, { id: 'ws-2', name: 'two', ptyIds: ['pty-3'] }], fleets: [] });
  const triggers = wireRelayClientTriggers({
    closeClients: closeRelayClients,
    policy: { onChange: () => () => undefined, epoch: () => 0, profileDecision: () => ({ kind: 'legacy' as const }) },
    paneBindings: () => ({}),
    mirror,
    surfaceWorkspace: (surfaceId) => surfaces.get(surfaceId),
    onPaneClaimChange,
  });
  setRelayAdmission((identity) => triggers.admit(identity));
  const peer: Rig['peer'] = { current: { workspaceId: 'ws-1', ptyId: 'pty-1' } };
  setPaneOfPeer(async () => peer.current);
  cleanup.push(async () => {
    setPaneOfPeer(null);
    setRelayAdmission(null);
    triggers.dispose();
    await setPipeRelayForTests(null);
    mux.close();
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });
  return { router, launcher, registry, mirror, triggers, held, surfaces, peer };
}

beforeEach(() => __resetWorkspaceClaimTrustForTesting());
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
  vi.restoreAllMocks();
});

type Answer = { ok: boolean; result?: RelayGrant & { profile?: string }; error?: string };

/** browser.cdp.grant as the wmux CLI in a pane sends it, over the pipe. */
function grantAs(router: RpcRouter, opts: {
  token?: string | null;
  params?: Record<string, unknown>;
  dispatch?: Parameters<RpcRouter['dispatch']>[1];
  clientName?: string;
} = {}): Promise<Answer> {
  const token = opts.token === undefined ? claimTokenForPane('ws-1', 'pty-1') : opts.token;
  return router.dispatch({
    id: '1',
    method: 'browser.cdp.grant',
    params: opts.params ?? {},
    clientName: opts.clientName ?? WMUX_CLI_CLIENT_NAME,
    ...(token !== null && { workspaceToken: token }),
  } as never, opts.dispatch ?? { externalWire: true }) as Promise<Answer>;
}

function dial(grant: Pick<RelayGrant, 'endpoint' | 'headers'>): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(grant.endpoint, { headers: { ...grant.headers } });
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
    ws.once('unexpected-response', (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)));
  });
}

const closedOf = (ws: WebSocket) => new Promise<void>((resolve) => {
  if (ws.readyState === WebSocket.CLOSED) resolve();
  else ws.once('close', () => resolve());
});

describe('paneScriptGrantRefusal: each condition on its own', () => {
  const ok: RpcContext = { origin: 'local', externalWire: true, clientName: WMUX_CLI_CLIENT_NAME, workspaceClaim: { kind: 'bound', workspaceId: 'ws-1', ptyId: 'pty-1' } };
  it('admits a pipe caller holding a pane claim', () => {
    expect(paneScriptGrantRefusal(ok)).toBeNull();
  });
  const rows: Array<[string, Partial<RpcContext> | ((c: RpcContext) => RpcContext)]> = [
    ['no claim (token only)', (c) => ({ ...c, workspaceClaim: undefined })],
    ['a workspace claim without a pane (mcp.claimWorkspace)', { workspaceClaim: { kind: 'bound', workspaceId: 'ws-1' } }],
    ['a stale claim', { workspaceClaim: { kind: 'stale' } }],
    ['a browser-only run claim', { workspaceClaim: { kind: 'bound', workspaceId: 'ws-1', ptyId: 'pty-1', browserOnly: true } }],
    ['a remote caller', { origin: 'remote' }],
    ['not the pipe (an in-process dispatch, such as the phone bridge)', (c) => ({ ...c, externalWire: undefined })],
    ['a plugin host', (c) => ({ ...c, externalWire: undefined, firstParty: true, hostedWorkspace: 'ws-1' })],
    ['the operator', (c) => ({ ...c, externalWire: undefined, firstParty: true, operator: true })],
    ['a commander token', { commanderWorkspace: 'ws-1' }],
    ['a fenced bot worker', { fencedWorker: true }],
  ];
  for (const [name, change] of rows) {
    it(`refuses ${name}`, () => {
      const ctx = typeof change === 'function' ? change(ok) : { ...ok, ...change };
      expect(paneScriptGrantRefusal(ctx)).toEqual(expect.any(String));
    });
  }
});

describe('relayLaneOf: the engine lane is earned, not the default', () => {
  it('operator, first-party pipe client, anyone else', () => {
    expect(relayLaneOf({ origin: 'local', operator: true, firstParty: true })).toBe('operator');
    expect(relayLaneOf({ origin: 'local', externalWire: true, clientName: [...FIRST_PARTY_CLIENT_NAMES][0] })).toBe('engine');
    expect(relayLaneOf({ origin: 'local', externalWire: true, clientName: 'some-tool', commanderWorkspace: 'ws-1' })).toBe('pane-script');
    expect(relayLaneOf({ origin: 'local', externalWire: true, clientName: 'some-tool' })).toBe('pane-script');
    expect(relayLaneOf({ origin: 'local', firstParty: true, hostedWorkspace: 'ws-1', clientName: [...FIRST_PARTY_CLIENT_NAMES][0] })).toBe('pane-script');
    expect(relayLaneOf(undefined)).toBe('pane-script');
  });
});

describe.skipIf(onWindows)('browser.cdp.grant', () => {
  it('mints for the calling pane only, with an identity main sets, and logs one line without the token or endpoint', async () => {
    const r = rig();
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const answer = await grantAs(r.router, { params: { lane: 'engine', ptyId: 'pty-9', everyTarget: true } });
    expect(answer.ok).toBe(true);
    expect(r.launcher.relayGrant).toHaveBeenCalledTimes(1);
    expect(r.launcher.relayGrant).toHaveBeenCalledWith({ workspaceId: 'ws-1', profile: 'work', ptyId: 'pty-1', lane: 'pane-script' });
    expect(r.launcher.narrowedFor).toHaveBeenCalledWith({ workspaceId: 'ws-1', profile: 'work', ptyId: 'pty-1', lane: 'pane-script' });
    expect(r.registry.profileFor).toHaveBeenCalledWith('ws-1');
    const grant = answer.result as RelayGrant & { profile: string };
    expect(grant.profile).toBe('work');
    const lines = log.mock.calls.map((c) => String(c[0])).filter((l) => l.startsWith('[browser.cdp.grant]'));
    expect(lines).toEqual([`[browser.cdp.grant] pane pty-1 profile work protected no transport ${posix ? 'unix socket' : 'named pipe'}`]);
    expect(lines[0]).not.toContain(grant.endpoint);
    expect(lines[0]).not.toContain(grant.headers.Authorization.slice('Bearer '.length));
    (await dial(grant)).close();
  });

  const refusedRows: Array<[string, (r: Rig) => Promise<Answer>, RegExp]> = [
    ['no claim (a pipe token only)', (r) => grantAs(r.router, { token: null }), /no pane claim/],
    ['a claim from mcp.claimWorkspace (no pane)', (r) => grantAs(r.router, { token: mintWorkspaceClaimToken('ws-1') }), /no pane/],
    ['a revoked claim', (r) => {
      const token = claimTokenForPane('ws-1', 'pty-1') as string;
      revokeWorkspaceClaimToken(token);
      return grantAs(r.router, { token });
    }, /no longer valid/],
    ['a scheduled run\'s browser-only claim (the router)', (r) => grantAs(r.router, { token: claimTokenForRun('ws-1', 'pty-1') }), /browser tools only/],
    ['a fenced bot worker\'s pane (the router)', (r) => {
      r.router.setFencedWorkerPty((pty) => pty === 'pty-1');
      return grantAs(r.router);
    }, /worker fence/],
    ['a plugin host', (r) => grantAs(r.router, { token: null, dispatch: { firstParty: true, hostedWorkspace: 'ws-1' } }), /pane may ask/],
    ['the operator', (r) => grantAs(r.router, { token: null, dispatch: { operator: true } }), /pane may ask/],
    ['a connection main cannot trace to a pane (no peer pid)', (r) => {
      r.peer.current = null;
      return grantAs(r.router);
    }, /could not trace this process/],
    ['a connection whose process runs in another pane than its claim', (r) => {
      r.peer.current = { workspaceId: 'ws-1', ptyId: 'pty-2' };
      return grantAs(r.router);
    }, /does not run in the pane its claim names/],
    ['another workspace named in params', (r) => grantAs(r.router, { params: { workspaceId: 'ws-2' } }), /takes no other/],
    ['a profile named in params', (r) => grantAs(r.router, { params: { profile: 'other' } }), /takes no profile/],
    ['a held tab in the pane\'s workspace', (r) => {
      r.surfaces.set('surface-1', 'ws-1');
      r.held.push({ surfaceId: 'surface-1', active: false, mode: 'paused' });
      return grantAs(r.router);
    }, /paused or taken over/],
    ['a held tab main cannot place', (r) => {
      r.held.push({ surfaceId: 'surface-gone', active: false, mode: 'user' });
      return grantAs(r.router);
    }, /paused or taken over/],
    ['a Chrome whose clients are not each kept to their own tabs', (r) => {
      r.launcher.narrowedFor.mockReturnValue(false);
      return grantAs(r.router);
    }, /opt-in for now: start wmux with WMUX_CDP_TARGET_GRANT=1/],
    ['a Chrome not on the pipe', (r) => {
      r.launcher.endpoint.mockResolvedValue({ cdpPort: 9 } as never);
      return grantAs(r.router);
    }, /not on the debugging pipe/],
    ['a pane the latest workspace list does not show', (r) => {
      r.mirror.setSnapshot({ ts: 0, entries: [{ id: 'ws-1', name: 'one', ptyIds: ['pty-2'] }, { id: 'ws-2', name: 'two', ptyIds: ['pty-3'] }], fleets: [] });
      return grantAs(r.router);
    }, /its pane is not open/],
  ];
  for (const [name, call, why] of refusedRows) {
    it(`refuses ${name}`, async () => {
      const r = rig();
      const answer = await call(r);
      expect(answer.ok).toBe(false);
      expect(String(answer.error)).toMatch(why);
      expect(r.launcher.relayGrant).not.toHaveBeenCalled();
    });
  }

  it('refuses on Windows, where no peer process is read, even with a pane its walk would find', async () => {
    const r = rig();
    const platform = Object.getOwnPropertyDescriptor(process, 'platform') as PropertyDescriptor;
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    let answer: Answer;
    try {
      answer = await grantAs(r.router);
    } finally {
      Object.defineProperty(process, 'platform', platform);
    }
    expect(answer.ok).toBe(false);
    expect(String(answer.error)).toContain("not available on Windows yet: wmux can't verify which process asked");
    expect(r.launcher.relayGrant).not.toHaveBeenCalled();
  });

  it('grants while a tab in another workspace is held, and while the held tab is handed back', async () => {
    const r = rig();
    r.surfaces.set('surface-9', 'ws-2');
    r.held.push({ surfaceId: 'surface-9', active: false, mode: 'user' }, { surfaceId: 'surface-1', active: true, mode: 'agent' });
    expect((await grantAs(r.router)).ok).toBe(true);
  });

  it('keeps one unspent token per pane: a second grant revokes the first, not the second', async () => {
    const r = rig();
    const first = (await grantAs(r.router)).result as RelayGrant;
    const second = (await grantAs(r.router)).result as RelayGrant;
    await expect(dial(first)).rejects.toThrow('HTTP 401');
    (await dial(second)).close();
    // Another pane's unspent token is not this pane's.
    r.peer.current = { workspaceId: 'ws-1', ptyId: 'pty-2' };
    const other = (await grantAs(r.router, { token: claimTokenForPane('ws-1', 'pty-2') })).result as RelayGrant;
    r.peer.current = { workspaceId: 'ws-1', ptyId: 'pty-1' };
    const third = (await grantAs(r.router)).result as RelayGrant;
    (await dial(other)).close();
    (await dial(third)).close();
  });
});

describe('F1: no pane grant without an admission check', () => {
  it('the launcher-level check refuses a pane-script identity when none is set, and passes the others', () => {
    setRelayAdmission(null);
    expect(relayAdmissionRefusal({ lane: 'pane-script', workspaceId: 'ws-1', ptyId: 'pty-1' })).toEqual(expect.any(String));
    expect(relayAdmissionRefusal({ lane: 'engine', workspaceId: 'ws-1' })).toBeNull();
    expect(relayAdmissionRefusal({ lane: 'operator', everyTarget: true })).toBeNull();
  });

  it.skipIf(onWindows)('browser.cdp.grant mints nothing when no check is set', async () => {
    const r = rig();
    setRelayAdmission(null);
    const answer = await grantAs(r.router);
    expect(answer.ok).toBe(false);
    expect(String(answer.error)).toMatch(/no relay token/);
    expect(r.launcher.relayGrant).not.toHaveBeenCalled();
  });
});

describe.skipIf(onWindows)('F3: a pane script\'s client ends with what it was granted on', () => {
  async function connected(r: Rig): Promise<WebSocket> {
    const answer = await grantAs(r.router);
    expect(answer.ok).toBe(true);
    const ws = await dial(answer.result as RelayGrant);
    cleanup.push(() => ws.terminate());
    return ws;
  }

  it('(b) its pane closes', async () => {
    const r = rig();
    const ws = await connected(r);
    const neighbour = await (async () => {
      r.peer.current = { workspaceId: 'ws-1', ptyId: 'pty-2' };
      const a = await grantAs(r.router, { token: claimTokenForPane('ws-1', 'pty-2') });
      return dial(a.result as RelayGrant);
    })();
    cleanup.push(() => neighbour.terminate());
    r.mirror.setSnapshot({ ts: 0, entries: [{ id: 'ws-1', name: 'one', ptyIds: ['pty-2'] }, { id: 'ws-2', name: 'two', ptyIds: ['pty-3'] }], fleets: [] });
    await closedOf(ws);
    expect(neighbour.readyState).toBe(WebSocket.OPEN);
  });

  it('(d) the user holds a tab in its workspace', async () => {
    const r = rig();
    const ws = await connected(r);
    r.surfaces.set('surface-1', 'ws-1');
    r.triggers.userHold('surface-1');
    await closedOf(ws);
  });

  it('(e) its pane\'s claim is issued anew', async () => {
    const r = rig();
    const ws = await connected(r);
    // The pane now answers from another workspace: its old claim goes.
    claimTokenForPane('ws-2', 'pty-1');
    await closedOf(ws);
  });

  it('a client of another pane stays through all three', async () => {
    const r = rig();
    r.peer.current = { workspaceId: 'ws-2', ptyId: 'pty-3' };
    const answer = await grantAs(r.router, { token: claimTokenForPane('ws-2', 'pty-3') });
    const ws = await dial(answer.result as RelayGrant);
    cleanup.push(() => ws.terminate());
    r.mirror.setSnapshot({ ts: 0, entries: [{ id: 'ws-1', name: 'one', ptyIds: ['pty-2'] }, { id: 'ws-2', name: 'two', ptyIds: ['pty-3'] }], fleets: [] });
    r.surfaces.set('surface-1', 'ws-1');
    r.triggers.userHold('surface-1');
    claimTokenForPane('ws-2', 'pty-1');
    const echo = await new Promise<unknown>((resolve) => {
      ws.once('message', (data) => resolve(JSON.parse(data.toString())));
      ws.send(JSON.stringify({ id: 1, method: 'Test.still' }));
    });
    expect(echo).toMatchObject({ id: 1, result: { echo: 'Test.still' } });
  });
});

describe.runIf(onWindows)('browser.cdp.grant on Windows', () => {
  it('refuses: wmux reads no peer process for a pipe connection there', async () => {
    const r = rig();
    const answer = await grantAs(r.router);
    expect(answer.ok).toBe(false);
    expect(String(answer.error)).toContain("not available on Windows yet: wmux can't verify which process asked");
    expect(r.launcher.relayGrant).not.toHaveBeenCalled();
  });
});
