import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrowserWindow } from 'electron';
import { RpcRouter } from '../../RpcRouter';
import { registerBrowserConsentRpc } from '../browserConsent.rpc';
import { ChromeProfileStore } from '../../../browser-session/ChromeProfileStore';
import { BrowserPolicyStore } from '../../../browser-session/BrowserPolicyStore';
import { DangerousActionConsent, type DownloadGuardPort } from '../../../browser-session/dangerousActionConsent';
import { getWorkspaceMirror, __resetWorkspaceMirrorForTest } from '../../../workspace/WorkspaceMirror';
import { dispatchAsClaimedCaller } from './claimedCaller';

/**
 * browser.consent.* at the RPC boundary: identity from main's attestation only
 * (pane claim → pane → its exclusive profile → policy), never from params.
 * pane-a (pty-a) is protected on its own profile "pa"; pane-b (pty-b) is not.
 */

const { sendToRendererMock } = vi.hoisted(() => ({ sendToRendererMock: vi.fn() }));
vi.mock('../_bridge', () => ({ sendToRenderer: sendToRendererMock }));
vi.mock('electron', () => ({ webContents: { fromId: vi.fn(() => null) }, shell: { openExternal: vi.fn() } }));

let dir: string;
let profiles: ChromeProfileStore;
let policy: BrowserPolicyStore;
let authorize: ReturnType<typeof vi.fn>;
let guard: DownloadGuardPort | null;
let backend = 'chrome';

function register(): RpcRouter {
  const router = dispatchAsClaimedCaller(new RpcRouter());
  const consent = new DangerousActionConsent({ store: policy, queue: () => null, runOwnership: () => 'not-owned' });
  authorize = vi.fn(async () => ({ operationId: 'op-1', epoch: policy.epoch(), via: 'once' }));
  consent.authorize = authorize as never;
  registerBrowserConsentRpc(router, {
    getWindow: () => null as unknown as BrowserWindow,
    store: policy,
    paneBindings: () => profiles.getPaneBindings(),
    chrome: { profileFor: (ws, pane) => profiles.profileFor(ws, pane), forProfile: vi.fn() as never },
    backend: () => backend,
    consent,
    makeDownloadDir: () => mkdtempSync(join(dir, 'pass-')),
    downloadGuardFor: () => guard,
  });
  return router;
}

async function call(router: RpcRouter, method: string, params: Record<string, unknown>, callerPtyId?: string) {
  const response = await router.dispatch({ id: '1', method, params, ...(callerPtyId && { callerPtyId }) } as never);
  if (response.ok) return { result: (response as { result?: unknown }).result, error: undefined };
  return { result: undefined, error: String((response as { error?: unknown }).error ?? '') };
}

beforeEach(async () => {
  backend = 'chrome';
  guard = null;
  dir = mkdtempSync(join(tmpdir(), 'wmux-consent-rpc-'));
  profiles = new ChromeProfileStore(dir);
  await profiles.create('pa');
  await profiles.setPaneBinding('pane-a', 'ws-1', 'pa');
  policy = new BrowserPolicyStore(dir);
  await policy.write(
    { workspaceId: 'ws-1', paneId: 'pane-a', profileId: 'pa', protected: true, hosts: { mode: 'allowlist', allow: ['a.test'], block: [] }, expectedEpoch: 0 },
    'pa',
    true,
  );
  __resetWorkspaceMirrorForTest();
  getWorkspaceMirror().setSnapshot({
    ts: Date.now(),
    entries: [{ id: 'ws-1', name: 'one', activePtyId: 'pty-a', ptyIds: ['pty-a', 'pty-b'] }],
    fleets: [],
    panePtys: { 'pty-a': 'pane-a', 'pty-b': 'pane-b' },
  });
  sendToRendererMock.mockReset();
  sendToRendererMock.mockResolvedValue([]);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  __resetWorkspaceMirrorForTest();
});

describe('browser.consent.request', () => {
  it('resolves the caller from its pane claim, whatever the params name', async () => {
    const router = register();
    const r = await call(router, 'browser.consent.request', { workspaceId: 'ws-1', paneId: 'pane-b', profileId: 'zz', action: 'evaluate', url: 'http://A.test./x' }, 'pty-a');
    expect(r.error).toBeUndefined();
    expect(authorize).toHaveBeenCalledTimes(1);
    expect(authorize.mock.calls[0][0]).toMatchObject({ workspaceId: 'ws-1', paneId: 'pane-a', profileId: 'pa', ptyId: 'pty-a' });
    expect(authorize.mock.calls[0][1]).toMatchObject({ action: 'evaluate', hosts: ['a.test'] });
  });

  it('an unprotected pane has nothing to consent to', async () => {
    const r = await call(register(), 'browser.consent.request', { workspaceId: 'ws-1', action: 'evaluate', url: 'http://a.test/' }, 'pty-b');
    expect(r.error).toMatch(/^browser\.consent\.request: policy_denied:/);
    expect(authorize).not.toHaveBeenCalled();
  });

  it('an unprotected pane asks when its agent skips a check, whatever its backend', async () => {
    backend = 'builtin';
    const r = await call(register(), 'browser.consent.request', { workspaceId: 'ws-1', action: 'evaluate', url: 'http://b.test/', unprotected: true }, 'pty-b');
    expect(r.result).toMatchObject({ ok: true, operationId: 'op-1' });
    expect(authorize).toHaveBeenCalledTimes(1);
    expect(authorize.mock.calls[0][0]).toMatchObject({ workspaceId: 'ws-1', paneId: 'pane-b', ptyId: 'pty-b', unprotected: true });
    expect(authorize.mock.calls[0][1]).toMatchObject({ action: 'evaluate', hosts: ['b.test'] });
  });

  it('an unprotected download is asked about and opens no pass', async () => {
    const r = await call(register(), 'browser.consent.request', { workspaceId: 'ws-1', action: 'download', url: 'https://cdn.test/f.zip', detail: 'f.zip', unprotected: true }, 'pty-b');
    expect(r.result).toMatchObject({ ok: true, operationId: 'op-1' });
    expect(authorize.mock.calls[0][1]).toMatchObject({ action: 'download', hosts: ['cdn.test'], detail: 'f.zip' });
    const wait = await call(register(), 'browser.consent.awaitDownload', { workspaceId: 'ws-1', operationId: 'op-1' }, 'pty-b');
    expect(wait.error).toMatch(/no such approved download/);
  });

  it('a protected pane is never asked on unprotected terms', async () => {
    const r = await call(register(), 'browser.consent.request', { workspaceId: 'ws-1', action: 'evaluate', url: 'http://a.test/', unprotected: true }, 'pty-a');
    expect(r.error).toMatch(/^browser\.consent\.request: policy_denied: this pane is protected now/);
    expect(authorize).not.toHaveBeenCalled();
  });

  it('an unprotected request with no attested pane is refused in its own words', async () => {
    const r = await call(register(), 'browser.consent.request', { workspaceId: 'ws-1', action: 'evaluate', url: 'http://b.test/', unprotected: true });
    expect(r.error).toMatch(/^browser\.consent\.request: policy_denied: .*Skipping this safety check needs the operator's consent/);
    expect(authorize).not.toHaveBeenCalled();
  });

  it('a caller with no attested pane is refused', async () => {
    const r = await call(register(), 'browser.consent.request', { workspaceId: 'ws-1', action: 'evaluate', url: 'http://a.test/' });
    expect(r.error).toMatch(/policy_denied/);
    expect(authorize).not.toHaveBeenCalled();
  });

  it('off the Chrome backend a protected pane is refused', async () => {
    backend = 'builtin';
    const r = await call(register(), 'browser.consent.request', { workspaceId: 'ws-1', action: 'evaluate', url: 'http://a.test/' }, 'pty-a');
    expect(r.error).toMatch(/policy_denied/);
  });

  it('a download with no ready guard is refused after consent, never let through', async () => {
    const r = await call(register(), 'browser.consent.request', { workspaceId: 'ws-1', action: 'download', url: 'http://a.test/', targetId: 'T1' }, 'pty-a');
    expect(r.error).toMatch(/download guard is not ready/);
  });

  it('a download arms one pass; another pane cannot await or release it', async () => {
    const sent: string[] = [];
    guard = {
      send: async (m, p) => {
        sent.push(`${m}:${String(p.behavior ?? p.guid ?? '')}`);
        return m === 'Target.getTargetInfo' ? { targetInfo: { type: 'page', url: 'http://a.test/' } } : {};
      },
      claim: () => () => undefined,
      onProgress: () => () => undefined,
      onClose: () => () => undefined,
    };
    const router = register();
    const r = await call(router, 'browser.consent.request', { workspaceId: 'ws-1', action: 'download', url: 'http://a.test/', targetId: 'T1', startTimeoutMs: 1000 }, 'pty-a');
    expect(r.result).toMatchObject({ ok: true, operationId: 'op-1' });
    expect(sent).toContain('Browser.setDownloadBehavior:allowAndName');
    const other = await call(router, 'browser.consent.release', { workspaceId: 'ws-1', operationId: 'op-1' }, 'pty-b');
    expect(other.error).toMatch(/policy_denied/);
    // The impostor's attempt voided the pass: deny is back.
    expect(sent.at(-1)).toBe('Browser.setDownloadBehavior:deny');
  });

  it.each([
    ['the tab is not on the approved site', { url: 'http://b.test/', claimable: true, allowFails: false }],
    ['another pass holds the claim', { url: 'http://a.test/', claimable: false, allowFails: false }],
    ['the browser refuses the allow', { url: 'http://a.test/', claimable: true, allowFails: true }],
  ])('a pass that cannot open leaves no download directory behind: %s', async (_why, how) => {
    guard = {
      send: async (m, p) => {
        if (m === 'Target.getTargetInfo') return { targetInfo: { type: 'page', url: how.url } };
        if (how.allowFails && p.behavior === 'allowAndName') throw new Error('CDP error');
        return {};
      },
      claim: () => (how.claimable ? () => undefined : null),
      onProgress: () => () => undefined,
      onClose: () => () => undefined,
    };
    const r = await call(register(), 'browser.consent.request', { workspaceId: 'ws-1', action: 'download', url: 'http://a.test/', targetId: 'T1' }, 'pty-a');
    expect(r.error).toMatch(/policy_denied/);
    expect(readdirSync(dir).filter((n) => n.startsWith('pass-'))).toEqual([]);
  });

  it('returns only the approved file, moved out of the pass directory, which is removed', async () => {
    let claimant: ((p: Record<string, unknown>) => boolean) | null = null;
    let progress: ((p: Record<string, unknown>) => void) | null = null;
    let passDir = '';
    guard = {
      send: async (m) => (m === 'Target.getTargetInfo' ? { targetInfo: { type: 'page', url: 'http://a.test/' } } : {}),
      claim: (fn) => { claimant = fn; return () => { claimant = null; }; },
      onProgress: (fn) => { progress = fn; return () => { progress = null; }; },
      onClose: () => () => undefined,
    };
    const router = register();
    const r = await call(router, 'browser.consent.request', { workspaceId: 'ws-1', action: 'download', url: 'http://a.test/', targetId: 'T1' }, 'pty-a');
    expect(r.error).toBeUndefined();
    passDir = readdirSync(dir).filter((n) => n.startsWith('pass-')).map((n) => join(dir, n))[0];
    // A stray file from another tab landed before its cancel took hold.
    writeFileSync(join(passDir, 'stray-guid'), 'OTHER');
    writeFileSync(join(passDir, 'g1'), 'PAYLOAD');
    expect(claimant!({ guid: 'g1', frameId: 'T1', url: 'http://a.test/f', suggestedFilename: 'f.bin' })).toBe(true);
    progress!({ guid: 'g1', state: 'completed' });
    const got = await call(router, 'browser.consent.awaitDownload', { workspaceId: 'ws-1', operationId: 'op-1' }, 'pty-a');
    const path = (got.result as { path: string }).path;
    expect(readFileSync(path, 'utf8')).toBe('PAYLOAD');
    expect(path.startsWith(passDir)).toBe(false);
    expect(existsSync(passDir)).toBe(false);
    rmSync(join(path, '..'), { recursive: true, force: true });
  });

  it('a policy change voids an approved download still in flight', async () => {
    const sent: string[] = [];
    guard = {
      send: async (m, p) => {
        sent.push(`${m}:${String(p.behavior ?? '')}`);
        return m === 'Target.getTargetInfo' ? { targetInfo: { type: 'page', url: 'http://a.test/' } } : {};
      },
      claim: () => () => undefined,
      onProgress: () => () => undefined,
      onClose: () => () => undefined,
    };
    const router = register();
    await call(router, 'browser.consent.request', { workspaceId: 'ws-1', action: 'download', url: 'http://a.test/', targetId: 'T1' }, 'pty-a');
    // A bare epoch move (another pane, a grant) leaves it alone…
    await policy.bumpEpoch();
    expect(sent.at(-1)).toBe('Browser.setDownloadBehavior:allowAndName');
    // …a change of this pane's site list voids it.
    await policy.write(
      { workspaceId: 'ws-1', paneId: 'pane-a', profileId: 'pa', protected: true, hosts: { mode: 'allowlist', allow: ['a.test', 'b.test'], block: [] }, expectedEpoch: policy.epoch() },
      'pa',
      true,
    );
    expect(sent.at(-1)).toBe('Browser.setDownloadBehavior:deny');
    const r = await call(router, 'browser.consent.awaitDownload', { workspaceId: 'ws-1', operationId: 'op-1' }, 'pty-a');
    expect(r.error).toMatch(/policy_denied/);
  });
});

describe('browser.consent.request from a scheduled run acting as a protected pane', () => {
  // A live identity run the daemon answers for, keyed by its PTY.
  let liveRuns: Map<string, { runId: string }>;
  const notes: Array<{ runId: string; detail: string }> = [];

  async function grantRun(ptyId: string) {
    const { recordRunIdentity, panePolicyFingerprint } = await import('../../../automation/runIdentity');
    await recordRunIdentity({
      automationId: 'auto-a1', boundRevision: 2, workspaceId: 'ws-1', paneId: 'pane-a', profileId: 'pa', hosts: ['a.test'],
      fingerprint: panePolicyFingerprint(policy.entryFor('pane-a'), profiles.getPaneBindings()['pane-a']?.profile),
      mode: 'auto',
    } as never);
    liveRuns.set(ptyId, { runId: `r-${ptyId}` });
  }

  /** The real consent rules; a run's PTY is owned by the automation bridge. */
  function registerReal(): RpcRouter {
    const router = dispatchAsClaimedCaller(new RpcRouter());
    registerBrowserConsentRpc(router, {
      getWindow: () => null as unknown as BrowserWindow,
      store: policy,
      paneBindings: () => profiles.getPaneBindings(),
      chrome: { profileFor: (ws, pane) => profiles.profileFor(ws, pane), forProfile: vi.fn() as never },
      backend: () => backend,
      consent: new DangerousActionConsent({
        store: policy,
        queue: () => null,
        runOwnership: (ptyId) => (ptyId && liveRuns.has(ptyId) ? 'owned' : 'not-owned'),
      }),
      makeDownloadDir: () => mkdtempSync(join(dir, 'pass-')),
      downloadGuardFor: () => guard,
    });
    return router;
  }

  async function asRun(router: RpcRouter, params: Record<string, unknown>, ptyId: string) {
    const { claimTokenForRun } = await import('../../../workspace/workspaceClaimTrust');
    const response = await router.dispatch(
      { id: '1', method: 'browser.consent.request', params, workspaceToken: claimTokenForRun('ws-1', ptyId), callerPtyId: ptyId } as never,
      { externalWire: true } as never,
    );
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
          return {
            run: run
              ? {
                runId: run.runId, automationId: 'auto-a1', revision: 2, effectiveMode: 'auto', ptyId: params?.['ptyId'],
                browserIdentity: { workspaceId: 'ws-1', paneId: 'pane-a', boundRevision: 2 },
              }
              : null,
          };
        }
        if (method === 'automation.noteRunBrowser') {
          notes.push({ runId: String(params?.['runId']), detail: String(params?.['detail']) });
          return { ok: true };
        }
        return null;
      },
    } as never);
  });

  afterEach(async () => {
    const { setRunIdentityTransport, __setRunIdentityStoreDirForTest } = await import('../../../automation/runIdentity');
    setRunIdentityTransport(null);
    __setRunIdentityStoreDirForTest(null);
  });

  it.each([
    ['evaluate', { action: 'evaluate', url: 'https://a.test/x' }],
    ['download', { action: 'download', url: 'https://a.test/file', targetId: 't-1' }],
  ])('a %s is needs_consent because nobody is there to answer, and the run row says so', async (_label, op) => {
    await grantRun('auto-r1');
    const router = registerReal();
    const res = await asRun(router, { workspaceId: 'ws-1', ...op }, 'auto-r1');
    expect(res.error).toMatch(/^browser\.consent\.request: needs_consent: /);
    expect(res.error).toContain('This is a scheduled run and nobody is there to answer.');
    expect(notes).toEqual([{ runId: 'r-auto-r1', detail: 'browser_consent_unattended' }]);
  });

  it("honours the pane's \"Always on this pane\" grant: the run borrows that pane", async () => {
    await grantRun('auto-r1');
    await policy.setGrants('pane-a', { workspaceId: 'ws-1', profileId: 'pa' }, (g) => ({ ...g, evaluate: true }), policy.epoch());
    const router = registerReal();
    const res = await asRun(router, { workspaceId: 'ws-1', action: 'evaluate', url: 'https://a.test/x' }, 'auto-r1');
    expect(res.error).toBeUndefined();
    expect(res.result).toMatchObject({ ok: true, via: 'grant' });
    expect(notes).toEqual([]);
  });

  it("a run whose pane's policy changed since the grant needs a new grant, as the gate says", async () => {
    await grantRun('auto-r1');
    await policy.write(
      {
        workspaceId: 'ws-1', paneId: 'pane-a', profileId: 'pa', protected: true,
        hosts: { mode: 'allowlist', allow: ['a.test', 'b.test'], block: [] }, expectedEpoch: policy.epoch(),
      },
      'pa',
      true,
    );
    const router = registerReal();
    const res = await asRun(router, { workspaceId: 'ws-1', action: 'evaluate', url: 'https://a.test/x' }, 'auto-r1');
    expect(res.error).toContain('needs_consent');
    expect(res.error).toContain("the pane's browser policy changed after this schedule was granted");
    expect(notes).toEqual([{ runId: 'r-auto-r1', detail: 'browser_needs_consent' }]);
  });

  it('still refuses an auto- PTY no live identity run owns', async () => {
    const router = registerReal();
    const res = await asRun(router, { workspaceId: 'ws-1', action: 'evaluate', url: 'https://a.test/x' }, 'auto-unknown');
    expect(res.error).toContain('policy_denied');
    expect(res.error).toContain('the calling pane could not be identified');
    expect(notes).toEqual([]);
  });

  it('leaves a pane caller exactly as before', async () => {
    await grantRun('auto-r1');
    const router = registerReal();
    // The protected pane's own agent is not a run, so a person would be asked;
    // with nobody to ask here it gets the existing denial.
    const res = await call(router, 'browser.consent.request', { workspaceId: 'ws-1', action: 'evaluate', url: 'https://a.test/x' }, 'pty-a');
    expect(res.error).toContain('policy_denied');
    expect(res.error).toContain('nobody can be asked right now');
    expect(notes).toEqual([]);
  });
});
