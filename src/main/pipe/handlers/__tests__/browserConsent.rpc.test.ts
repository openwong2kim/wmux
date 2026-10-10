import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
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
    makeDownloadDir: () => dir,
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
      send: async (m, p) => { sent.push(`${m}:${String(p.behavior ?? p.guid ?? '')}`); return {}; },
      claim: () => () => undefined,
      onProgress: () => () => undefined,
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
});
