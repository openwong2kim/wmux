// The guides read goes through main, not the MCP process, so a remote MCP host
// reads the app's own wmuxDir. Two contracts are pinned here: the opt-in flag
// (default OFF touches no file at all) and the fail-closed workspace gate.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserWindow } from 'electron';
import type { RpcContext } from '../../../../shared/rpc';
import { RpcRouter } from '../../RpcRouter';
import { registerBrowserRpc } from '../browser.rpc';
import { SiteGuideStore, getSiteGuidesDir } from '../../../browser-session/SiteGuideStore';
import { __resetWorkspaceClaimTrustForTesting } from '../../../workspace/workspaceClaimTrust';

vi.mock('electron', () => ({
  webContents: { fromId: vi.fn(() => null) },
  shell: { openExternal: vi.fn() },
}));

vi.mock('../_bridge', () => ({ sendToRenderer: vi.fn() }));

let home: string;
let store: SiteGuideStore;
vi.mock('../../../browser-session/SiteGuideStore', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../../browser-session/SiteGuideStore')>();
  return { ...mod, getSiteGuideStore: () => store };
});

const URL_UPLOAD = 'https://studio.example.com/upload';

function register(enabled: boolean | null): RpcRouter {
  const router = new RpcRouter();
  const webviewCdpManager = {
    getTarget: vi.fn(() => null),
    listTargets: vi.fn(() => []),
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
    (() => null) as unknown as () => BrowserWindow | null,
    webviewCdpManager as never,
    undefined,
    undefined,
    () => 'enforce',
    undefined,
    () => null,
    () => enabled,
  );
  return router;
}

async function match(router: RpcRouter, ctx: RpcContext, url = URL_UPLOAD) {
  const res = await router.dispatch(
    { id: '1', method: 'browser.siteGuides.match' as never, params: { url, workspaceId: 'ws-1' } },
    ctx as never,
  );
  return res as { ok: boolean; error?: string; result?: Record<string, unknown> };
}

/** A wire caller that has claimed nothing — the 'legacy' lane. */
function legacyCtx(): RpcContext {
  return { origin: 'local', externalWire: true, clientName: 'some-plugin' };
}

/** The renderer. wmux itself, so it is trusted with the workspace it names. */
function operatorCtx(): RpcContext {
  return { origin: 'local', operator: true };
}

beforeEach(() => {
  __resetWorkspaceClaimTrustForTesting();
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-guides-rpc-')));
  const dir = path.join(home, '.wmux');
  fs.mkdirSync(getSiteGuidesDir(dir), { recursive: true });
  fs.writeFileSync(
    path.join(getSiteGuidesDir(dir), 'studio.md'),
    `---\ntitle: Studio upload flow\nurls: [studio.example.com/upload]\n---\nbody\n`,
  );
  store = new SiteGuideStore(dir, { home });
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

describe('browser.siteGuides.match RPC', () => {
  it('refuses an unverified workspace scope', async () => {
    const res = await match(register(true), legacyCtx());
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/workspace/i);
  });

  it('gives a caller that may not see local data the answer an off setting gives', async () => {
    // A hosted plugin passes the workspace gate (its workspace is host-derived)
    // but is not allowed local-only data, so it must not learn which local
    // notes exist — the same disclosure rule as the CDP attach info.
    const router = register(true);
    const spy = vi.spyOn(store, 'match');
    const res = (await router.dispatch(
      {
        id: '1',
        method: 'browser.siteGuides.match' as never,
        params: { url: URL_UPLOAD, workspaceId: 'ws-1' },
        clientName: 'some-plugin',
      } as never,
      { firstParty: true, hostedWorkspace: 'ws-1' },
    )) as { ok: boolean; result?: unknown };
    expect(res.ok).toBe(true);
    expect(res.result).toEqual({ guides: [] });
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('serves the matching guide when the setting is on', async () => {
    const res = await match(register(true), operatorCtx());
    const guides = res.result?.['guides'] as Array<{ title: string; path: string }>;
    expect(guides).toHaveLength(1);
    expect(guides[0].title).toBe('Studio upload flow');
    expect(guides[0].path).toBe('~/.wmux/site-guides/studio.md');
  });

  it('reads no file at all while the setting is off or unset', async () => {
    // The point of the opt-in: off must not stat or open anything under the
    // user's guides directory, not merely withhold the answer.
    for (const enabled of [false, null]) {
      const spy = vi.spyOn(store, 'match');
      const res = await match(register(enabled), operatorCtx());
      expect(res.result, String(enabled)).toEqual({ guides: [] });
      expect(spy, String(enabled)).not.toHaveBeenCalled();
      spy.mockRestore();
    }
  });

  it('serves nothing without a url', async () => {
    const router = register(true);
    const res = await router.dispatch(
      {
        id: '1',
        method: 'browser.siteGuides.match' as never,
        params: { workspaceId: 'ws-1' },
      },
      operatorCtx() as never,
    );
    expect((res as { result?: unknown }).result).toEqual({ guides: [] });
  });

  it('answers an overlong url with no guides, before any matching', async () => {
    const router = register(true);
    const spy = vi.spyOn(store, 'match');
    const long = `https://studio.example.com/${'a'.repeat(2049 - 'https://studio.example.com/'.length)}`;
    expect(long).toHaveLength(2049);
    expect((await match(router, operatorCtx(), long)).result).toEqual({ guides: [] });
    expect(spy).not.toHaveBeenCalled();

    const atCap = `https://studio.example.com/${'a'.repeat(2048 - 'https://studio.example.com/'.length)}`;
    await match(router, operatorCtx(), atCap);
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });

  it('re-lists the directory on the first call after the setting turns on', async () => {
    const off = register(false);
    await match(off, operatorCtx());
    const on = register(true);
    const spy = vi.spyOn(store, 'invalidateListing');
    await match(on, operatorCtx());
    expect(spy).toHaveBeenCalledTimes(1);
    // Only on the transition — not on every landing.
    await match(on, operatorCtx());
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
