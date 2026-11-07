import { describe, it, expect, afterEach, vi } from 'vitest';
import os from 'node:os';
import { EventEmitter } from 'node:events';
import { WebTerminalServer } from '../WebTerminalServer';
import type { DaemonSessionManager } from '../../DaemonSessionManager';
import { DesktopPhoneBridge } from '../../phone/DesktopPhoneBridge';
import { BrowserHelpTable } from '../../phone/BrowserHelpTable';
import { HelpRequests } from '../../../main/browser-session/HelpRequests';
import { browserHelpRow, type BrowserHelpTabDeps } from '../../../main/phone/PhoneBrowserHelp';
import { handlePhoneBrowser } from '../../../main/phone/PhoneBrowser';
import type { RpcResponse } from '../../../shared/rpc';

/**
 * The phone preview on dedicated-profile Chrome, at the daemon: the flag, the
 * `?chrome=1` opt-in, main's error codes as statuses, `focus`, `open.backend`,
 * and help-card typing pinned to the help row's origin. A fake desktop stands
 * in for main and records what it was asked.
 */

describe('browser preview routes with dedicated Chrome', () => {
  let server: WebTerminalServer | undefined;
  afterEach(async () => { if (server?.isRunning) await server.stop(); server = undefined; });

  async function start(opts: { announce?: string[]; allowTranscript?: boolean; reply?: (command: string, payload: Record<string, unknown>) => unknown } = {}) {
    const calls: Array<{ command: string; payload: Record<string, unknown> }> = [];
    const bridge = new DesktopPhoneBridge((clientId, event) => {
      const data = (event as { data: { requestId: string; command: string; payload: Record<string, unknown> } }).data;
      if (data.command !== 'workspaces.list') calls.push({ command: data.command, payload: data.payload });
      const result = data.command === 'workspaces.list' ? { workspaces: [{ id: 'ws-1', name: 'One', sessionId: null }] }
        : opts.reply ? opts.reply(data.command, data.payload) : { pages: [] };
      queueMicrotask(() => bridge.complete(clientId, { requestId: data.requestId, ok: true, result }));
      return true;
    }, 500);
    bridge.register('main', opts.announce ?? ['browser.help', 'browser.chromePreview']);
    const table = new BrowserHelpTable({ firstParty: (id) => id === 'main', isOwner: (id) => bridge.isOwner(id), emit: () => undefined });
    const now = Date.now();
    const row = (requestId: string, extra: Record<string, unknown> = {}) => ({
      requestId, workspaceId: 'ws-1', surfaceId: 'chrome-own', prompt: 'Sign in, then press Done.',
      createdAt: now, deadlineAt: now + 60_000, backend: 'chrome', previewable: true, origin: 'https://login.example.com', ...extra,
    });
    expect(table.set('main', { requests: [row('req-1'), row('req-noorigin', { origin: undefined }), row('req-other', { surfaceId: 'chrome-else' }), row('req-ws2', { workspaceId: 'ws-2' })] }).ok).toBe(true);
    const sessionManager = Object.assign(new EventEmitter(), { getSession: () => undefined, listLiveSessions: () => [] }) as unknown as DaemonSessionManager;
    server = new WebTerminalServer({ sessionManager, desktop: () => bridge, log: () => undefined, assetsDir: os.tmpdir(), browserHelp: () => table });
    const info = await server.start({ port: 0, host: '127.0.0.1', allowInput: true, allowUpload: false, allowTranscript: opts.allowTranscript ?? true });
    const base = `http://127.0.0.1:${server.status().port}`;
    const auth = { Authorization: `Bearer ${info.token as string}`, 'Content-Type': 'application/json' };
    const get = async (route: string) => {
      const res = await fetch(`${base}${route}`, { headers: auth });
      return { status: res.status, body: await res.json() as Record<string, unknown> };
    };
    const post = async (body: unknown) => {
      const res = await fetch(`${base}/api/desktop-workspaces/ws-1/browser`, { method: 'POST', headers: auth, body: JSON.stringify(body) });
      return { status: res.status, body: await res.json() as Record<string, unknown> };
    };
    return { calls, get, post, table };
  }

  it('announces browserPreviewChrome only with the consent and a desktop that supports it', async () => {
    expect((await (await start()).get('/api/config')).body.browserPreviewChrome).toBe(true);
    await server?.stop();
    expect((await (await start({ announce: [] })).get('/api/config')).body).not.toHaveProperty('browserPreviewChrome');
    await server?.stop();
    expect((await (await start({ allowTranscript: false })).get('/api/config')).body).not.toHaveProperty('browserPreviewChrome');
  });

  it('asks main for Chrome rows only on ?chrome=1, and only of a desktop that supports it', async () => {
    const r = await start();
    expect((await r.get('/api/desktop-workspaces/ws-1/browser')).status).toBe(200);
    expect(r.calls.at(-1)).toEqual({ command: 'browser.list', payload: { workspaceId: 'ws-1' } });
    await r.get('/api/desktop-workspaces/ws-1/browser?chrome=1');
    expect(r.calls.at(-1)).toEqual({ command: 'browser.list', payload: { workspaceId: 'ws-1', chrome: true } });
    await server?.stop();
    const old = await start({ announce: [] });
    await old.get('/api/desktop-workspaces/ws-1/browser?chrome=1');
    expect(old.calls.at(-1)).toEqual({ command: 'browser.list', payload: { workspaceId: 'ws-1' } });
  });

  it.each([
    ['browser-tab-gone', 404], ['browser-tab-hidden', 409], ['browser-backend-unavailable', 503],
    ['browser-action-unsupported', 501], ['browser-help-origin-changed', 409],
  ] as const)('main\'s %s is answered %i', async (code, status) => {
    const r = await start({ reply: () => ({ error: code }) });
    expect(await r.get('/api/desktop-workspaces/ws-1/browser?surfaceId=chrome-own')).toEqual({ status, body: { error: code } });
  });

  it('a code main does not have is the generic failure', async () => {
    const r = await start({ reply: () => ({ error: 'something-else' }) });
    expect(await r.get('/api/desktop-workspaces/ws-1/browser?surfaceId=chrome-own')).toEqual({ status: 503, body: { error: 'browser-preview-unavailable' } });
  });

  it('forwards focus and open.backend, and nothing else of the body', async () => {
    const r = await start({ reply: (command) => (command === 'browser.open' ? { surfaceId: 'chrome-new' } : { applied: true }) });
    expect((await r.post({ action: 'focus', surfaceId: 'chrome-own', workspaceId: 'forged', url: 'https://x' })).status).toBe(200);
    expect(r.calls.at(-1)).toEqual({ command: 'browser.focus', payload: { surfaceId: 'chrome-own', workspaceId: 'ws-1' } });
    expect((await r.post({ action: 'open', url: 'https://a.example.com/', backend: 'chrome' })).body).toEqual({ surfaceId: 'chrome-new' });
    expect(r.calls.at(-1)).toEqual({ command: 'browser.open', payload: { url: 'https://a.example.com/', backend: 'chrome', workspaceId: 'ws-1' } });
    const count = r.calls.length;
    expect((await r.post({ action: 'open', url: 'https://a.example.com/', backend: 'live' })).status).toBe(400);
    expect((await r.post({ action: 'focus' })).status).toBe(400);
    expect(r.calls).toHaveLength(count);
  });

  it('help-card typing goes only to the help row\'s tab, pinned to the row\'s origin', async () => {
    const r = await start({ reply: () => ({ applied: true }) });
    const typed = { action: 'type', surfaceId: 'chrome-own', expectedURL: 'https://login.example.com/', text: 'pw' };
    expect((await r.post({ ...typed, helpRequestId: 'req-1', helpOrigin: 'https://evil.example.com' })).status).toBe(200);
    // The origin is the daemon's table's, never the body's.
    expect(r.calls.at(-1)).toEqual({ command: 'browser.type', payload: { surfaceId: 'chrome-own', expectedURL: 'https://login.example.com/', text: 'pw', helpOrigin: 'https://login.example.com', workspaceId: 'ws-1' } });
    const count = r.calls.length;
    expect(await r.post({ ...typed, helpRequestId: 'req-missing' })).toEqual({ status: 404, body: { error: 'browser-help-not-found' } });
    expect(await r.post({ ...typed, helpRequestId: 'req-other' })).toEqual({ status: 404, body: { error: 'browser-help-not-found' } });
    expect(await r.post({ ...typed, helpRequestId: 'req-noorigin' })).toEqual({ status: 409, body: { error: 'browser-help-origin-changed' } });
    expect((await r.post({ ...typed, helpRequestId: 'bad id!' })).status).toBe(400);
    // Another workspace's request answers as unknown, open or closed.
    expect(await r.post({ ...typed, helpRequestId: 'req-ws2' })).toEqual({ status: 404, body: { error: 'browser-help-not-found' } });
    r.table.closeDecided('req-ws2', 'continued');
    expect(await r.post({ ...typed, helpRequestId: 'req-ws2' })).toEqual({ status: 404, body: { error: 'browser-help-not-found' } });
    r.table.closeDecided('req-1', 'continued');
    expect(await r.post({ ...typed, helpRequestId: 'req-1' })).toEqual({ status: 409, body: { error: 'browser-help-closed' } });
    expect(r.calls).toHaveLength(count);
    // Plain typing is unchanged.
    expect((await r.post(typed)).status).toBe(200);
    expect(r.calls.at(-1)?.payload).not.toHaveProperty('helpOrigin');
  });
});

describe('help-card typing is held to the origin the request was made at', () => {
  let server: WebTerminalServer | undefined;
  afterEach(async () => { if (server?.isRunning) await server.stop(); server = undefined; });

  /** Main's real store, row builder and preview behind the real bridge, table and server. */
  async function rig(origin: string | undefined) {
    let paneURL = 'https://a.example.com/login';
    const store = new HelpRequests({ open: () => undefined, close: () => undefined });
    const help: BrowserHelpTabDeps = {
      backend: () => 'builtin',
      builtinUrl: (s, ws) => (s === 'surf-1' && ws === 'ws-1' ? paneURL : null),
      mayBeLiveChrome: () => false,
      chromeTabs: async () => [],
    };
    const invoke = vi.fn(async (): Promise<RpcResponse> => ({ id: 'rpc', ok: true, result: { ok: true } }));
    const preview = {
      backend: () => 'builtin',
      clearViewport: async () => undefined,
      nativeBounds: async () => ({ width: 1000, height: 728 }),
      scroll: async () => undefined,
      input: (_id: number, operation: () => Promise<RpcResponse>) => operation(),
      targets: () => [{ surfaceId: 'surf-1', workspaceId: 'ws-1', webContentsId: 1, targetId: 't' }],
      page: () => ({ title: 'Pane', url: paneURL }),
      invoke,
    };
    const bridge = new DesktopPhoneBridge((clientId, event) => {
      const data = (event as { data: { requestId: string; command: string; payload: Record<string, unknown> } }).data;
      queueMicrotask(async () => {
        try {
          const result = data.command === 'workspaces.list'
            ? { workspaces: [{ id: 'ws-1', name: 'One', sessionId: null }] }
            : await handlePhoneBrowser(data.command, data.payload, preview);
          bridge.complete(clientId, { requestId: data.requestId, ok: true, result });
        } catch {
          bridge.complete(clientId, { requestId: data.requestId, ok: false });
        }
      });
      return true;
    }, 500);
    bridge.register('main', ['browser.help', 'browser.chromePreview']);
    const table = new BrowserHelpTable({ firstParty: (id) => id === 'main', isOwner: (id) => bridge.isOwner(id), emit: () => undefined });
    const publish = async () => table.set('main', { requests: await Promise.all(store.listPending().map((r) => browserHelpRow(r, help))) });
    const info = store.create({ workspaceId: 'ws-1', surfaceId: 'surf-1', prompt: 'Sign in, then press Done.', timeoutMs: 60_000, ...(origin ? { origin } : {}) });
    const sessionManager = Object.assign(new EventEmitter(), { getSession: () => undefined, listLiveSessions: () => [] }) as unknown as DaemonSessionManager;
    server = new WebTerminalServer({ sessionManager, desktop: () => bridge, log: () => undefined, assetsDir: os.tmpdir(), browserHelp: () => table });
    const started = await server.start({ port: 0, host: '127.0.0.1', allowInput: true, allowUpload: false, allowTranscript: true });
    const base = `http://127.0.0.1:${server.status().port}`;
    const auth = { Authorization: `Bearer ${started.token as string}`, 'Content-Type': 'application/json' };
    const typeAt = async (url: string) => {
      const res = await fetch(`${base}/api/desktop-workspaces/ws-1/browser`, { method: 'POST', headers: auth,
        body: JSON.stringify({ action: 'type', surfaceId: 'surf-1', expectedURL: url, text: 'pw', helpRequestId: info.requestId }) });
      return { status: res.status, body: await res.json() as Record<string, unknown> };
    };
    const row = async () => {
      const res = await fetch(`${base}/api/browser-help`, { headers: auth });
      return ((await res.json()) as { requests: Array<Record<string, unknown>> }).requests[0];
    };
    const typed = () => invoke.mock.calls.filter((call) => (call as unknown[])[0] === 'browser.type.cdp').length;
    return { navigate: (url: string) => { paneURL = url; }, publish, typeAt, row, typed };
  }

  it('a tab that moved before the first publish: the row keeps A, typing on B is refused', async () => {
    const r = await rig('https://a.example.com');
    r.navigate('https://b.example.com/');
    await r.publish();
    expect(await r.row()).toMatchObject({ origin: 'https://a.example.com' });
    expect(await r.typeAt('https://b.example.com/')).toEqual({ status: 409, body: { error: 'browser-help-origin-changed' } });
    expect(r.typed()).toBe(0);
    // Republished on B: the row still shows A, and typing there is still refused.
    await r.publish();
    expect(await r.row()).toMatchObject({ origin: 'https://a.example.com' });
    expect(await r.typeAt('https://b.example.com/')).toEqual({ status: 409, body: { error: 'browser-help-origin-changed' } });
    // Back on A: it types.
    r.navigate('https://a.example.com/login');
    expect(await r.typeAt('https://a.example.com/login')).toEqual({ status: 200, body: { applied: true } });
    expect(r.typed()).toBe(1);
  });

  it('an origin unknown when the request was made stays unknown: typing is refused, even once the tab settles', async () => {
    const r = await rig(undefined);
    await r.publish();
    expect(await r.row()).not.toHaveProperty('origin');
    expect(await r.typeAt('https://a.example.com/login')).toEqual({ status: 409, body: { error: 'browser-help-origin-changed' } });
    r.navigate('https://a.example.com/settled');
    await r.publish();
    expect(await r.row()).not.toHaveProperty('origin');
    expect(await r.typeAt('https://a.example.com/settled')).toEqual({ status: 409, body: { error: 'browser-help-origin-changed' } });
    expect(r.typed()).toBe(0);
  });
});
